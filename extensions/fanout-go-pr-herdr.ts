import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { Type } from "typebox";
import { spawn } from "node:child_process";
import { randomUUID } from "node:crypto";
import { closeSync, openSync } from "node:fs";
import { mkdir, readFile, rm, unlink, writeFile } from "node:fs/promises";
import { homedir, tmpdir } from "node:os";
import { join } from "node:path";

const DEFAULT_BASE_BRANCH = "develop";
const PACKAGE_NAME = "pi-parallel-go-pr-herdr";
const DEFAULT_GO_PR_PROMPT_PATH = join(homedir(), ".pi", "agent", "prompts", "go-pr.md");
const WORKER_START_TIMEOUT_MS = 90 * 1000;
const HANDOFF_IDLE_TIMEOUT_MS = 5 * 60 * 1000;

const PR_DESCRIPTION_QUALITY_CONTRACT = `PR description quality expectations:
- Write the PR title and description in Spanish, while keeping technical jargon in English.
- Before writing or updating the PR description, inspect the branch diff, commits, and relevant code changes.
- Describe the current intent of the PR, especially if the implementation evolved from the original work item plan.
- Preserve accurate useful context, but remove stale claims, TODOs, or implementation details that are no longer true.
- Include a concise summary, the main code or behavior changes grouped in readable bullets, clear examples that showcase the change and its value, validation performed, and any relevant caveats, follow-ups, or rollout notes.
- Prefer short before/after examples, usage examples, workflow examples, or user-facing behavior examples when applicable.
- Use real Markdown newlines and update GitHub with a temporary Markdown file plus gh --body-file; never pass literal escaped newline sequences such as \\n in a quoted --body argument.
- Before finishing, verify the stored PR body with gh pr view --json body --jq .body and fix literal escape artifacts if they appear.`;

type ExecResult = {
  stdout?: string;
  stderr?: string;
  code?: number | null;
  killed?: boolean;
};

type FanoutOptions = {
  baseBranch: string;
  assumeYes: boolean;
  plan: string;
};

type HerdrPane = {
  pane_id?: string;
  tab_id?: string;
  workspace_id?: string;
  cwd?: string;
  foreground_cwd?: string;
};

type HerdrTab = {
  tab_id?: string;
  workspace_id?: string;
  label?: string;
};

type HerdrCurrentResult = {
  pane?: HerdrPane;
  type?: string;
};

type HerdrTabCreatedResult = {
  tab?: HerdrTab;
  root_pane?: HerdrPane;
  type?: string;
};

type HerdrAgent = HerdrPane & {
  agent?: string;
  agent_status?: string;
};

type HerdrAgentResult = {
  agent?: HerdrAgent;
  type?: string;
};

type HerdrEnvelope<T> = {
  id?: string;
  result?: T;
};

type HerdrContext = {
  paneId: string;
  tabId: string;
  workspaceId: string;
};

type PreparedPiece = {
  title: string;
  branchName: string;
  tabLabel: string;
  sessionName: string;
  promptFile: string;
  workerPrompt: string;
};

function shellQuote(value: string): string {
  return `'${value.replace(/'/g, `'"'"'`)}'`;
}

function slugify(value: string): string {
  const slug = value
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "")
    .slice(0, 48);
  return slug || "work";
}

function tokenizeArgs(input: string): string[] {
  const tokens: string[] = [];
  let current = "";
  let quote: "'" | '"' | undefined;

  const flush = () => {
    if (!current) return;
    tokens.push(current);
    current = "";
  };

  for (let index = 0; index < input.length; index += 1) {
    const character = input[index] ?? "";

    if (quote) {
      if (character === quote) {
        quote = undefined;
      } else if (character === "\\" && quote === '"' && index + 1 < input.length) {
        index += 1;
        current += input[index] ?? "";
      } else {
        current += character;
      }
      continue;
    }

    if (/\s/.test(character)) {
      flush();
      continue;
    }

    if ((character === "'" || character === '"') && (current.length === 0 || current.endsWith("="))) {
      quote = character;
      continue;
    }

    if (character === "\\" && index + 1 < input.length) {
      index += 1;
      current += input[index] ?? "";
      continue;
    }

    current += character;
  }

  if (quote) throw new Error(`Unterminated ${quote} quote.`);
  flush();
  return tokens;
}

function parseArgs(args: string | undefined): FanoutOptions {
  const tokens = tokenizeArgs(args ?? "");
  const rest: string[] = [];
  let baseBranch = DEFAULT_BASE_BRANCH;
  let assumeYes = false;

  for (let index = 0; index < tokens.length; index += 1) {
    const token = tokens[index] ?? "";

    if (token === "--yes" || token === "-y") {
      assumeYes = true;
      continue;
    }

    if (token === "--base" || token === "-b") {
      const next = tokens[index + 1];
      if (!next) throw new Error("Missing value for --base.");
      baseBranch = next;
      index += 1;
      continue;
    }

    if (token.startsWith("--base=")) {
      baseBranch = token.slice("--base=".length);
      continue;
    }

    rest.push(token);
  }

  if (!baseBranch.trim()) throw new Error("Base branch cannot be empty.");
  return { baseBranch: baseBranch.trim(), assumeYes, plan: rest.join(" ").trim() };
}

async function exec(
  pi: ExtensionAPI,
  command: string,
  args: string[],
  cwd: string,
  timeout = 30_000,
  signal?: AbortSignal,
): Promise<ExecResult> {
  return pi.exec(command, args, { cwd, timeout, signal }) as Promise<ExecResult>;
}

function commandFailure(result: ExecResult): string {
  if (result.killed) return "process was killed or cancelled";
  return result.stderr?.trim() || result.stdout?.trim() || `exit code ${String(result.code)}`;
}

function throwIfKilled(result: ExecResult, operation: string): void {
  if (result.killed) throw new Error(`${operation} was killed or cancelled; its outcome is indeterminate.`);
}

function throwIfAborted(signal: AbortSignal | undefined, operation: string): void {
  if (!signal?.aborted) return;
  throw new Error(`${operation} was cancelled before it started.`);
}

async function requireCommand(
  pi: ExtensionAPI,
  binary: string,
  cwd: string,
  signal?: AbortSignal,
): Promise<string | null> {
  const result = await exec(pi, "sh", ["-lc", `command -v ${shellQuote(binary)}`], cwd, 10_000, signal);
  throwIfKilled(result, `Resolving ${binary}`);
  if (result.code !== 0 || !result.stdout?.trim()) return null;
  return result.stdout.trim();
}

async function repoRoot(
  pi: ExtensionAPI,
  cwd: string,
  signal?: AbortSignal,
): Promise<string | null> {
  const result = await exec(pi, "git", ["rev-parse", "--show-toplevel"], cwd, 10_000, signal);
  throwIfKilled(result, "Resolving the git repository root");
  if (result.code !== 0 || !result.stdout?.trim()) return null;
  return result.stdout.trim();
}

async function validateBranch(
  pi: ExtensionAPI,
  branch: string,
  cwd: string,
  label: string,
  signal?: AbortSignal,
): Promise<void> {
  const result = await exec(pi, "git", ["check-ref-format", "--branch", branch], cwd, 10_000, signal);
  throwIfKilled(result, `Validating ${label}`);
  if (result.code !== 0) throw new Error(`Invalid ${label}: ${branch}.`);
}

async function requireGitRef(
  pi: ExtensionAPI,
  ref: string,
  cwd: string,
  signal?: AbortSignal,
): Promise<void> {
  const result = await exec(pi, "git", ["rev-parse", "--verify", `${ref}^{commit}`], cwd, 10_000, signal);
  throwIfKilled(result, `Resolving base ref ${ref}`);
  if (result.code !== 0) throw new Error(`Base branch does not resolve to a commit: ${ref}.`);
}

async function requireBranchAvailable(
  pi: ExtensionAPI,
  branch: string,
  cwd: string,
  signal?: AbortSignal,
): Promise<void> {
  const result = await exec(pi, "git", ["show-ref", "--verify", "--quiet", `refs/heads/${branch}`], cwd, 10_000, signal);
  throwIfKilled(result, `Checking branch ${branch}`);
  if (result.code === 0) throw new Error(`Fanout branch already exists locally: ${branch}.`);
  if (result.code !== 1) throw new Error(`Failed to check fanout branch ${branch}: ${commandFailure(result)}`);
}

function parseHerdrResult<T>(result: ExecResult, operation: string): T {
  throwIfKilled(result, `Herdr ${operation}`);
  if (result.code !== 0) {
    throw new Error(`Herdr ${operation} failed: ${commandFailure(result)}`);
  }

  const text = result.stdout?.trim();
  if (!text) throw new Error(`Herdr ${operation} returned no JSON response.`);

  let envelope: HerdrEnvelope<T>;
  try {
    envelope = JSON.parse(text) as HerdrEnvelope<T>;
  } catch (error) {
    throw new Error(
      `Herdr ${operation} returned invalid JSON: ${error instanceof Error ? error.message : String(error)}`,
    );
  }

  if (!envelope.result) throw new Error(`Herdr ${operation} response did not include a result.`);
  return envelope.result;
}

async function currentHerdrContext(
  pi: ExtensionAPI,
  cwd: string,
  signal?: AbortSignal,
): Promise<HerdrContext> {
  if (process.env.HERDR_ENV !== "1") {
    throw new Error("This command must run from a Pi session inside Herdr (HERDR_ENV=1).");
  }

  const result = await exec(pi, "herdr", ["pane", "current", "--current"], cwd, 10_000, signal);
  const current = parseHerdrResult<HerdrCurrentResult>(result, "pane current");
  const paneId = current.pane?.pane_id;
  const tabId = current.pane?.tab_id;
  const workspaceId = current.pane?.workspace_id;

  if (!paneId || !tabId || !workspaceId) {
    throw new Error("Herdr pane current response did not include pane, tab, and workspace IDs.");
  }

  return { paneId, tabId, workspaceId };
}

function delay(ms: number, signal?: AbortSignal): Promise<void> {
  return new Promise((resolve, reject) => {
    if (signal?.aborted) {
      reject(new Error("Operation cancelled while waiting for Herdr."));
      return;
    }

    const timeout = setTimeout(() => {
      signal?.removeEventListener("abort", onAbort);
      resolve();
    }, ms);
    const onAbort = () => {
      clearTimeout(timeout);
      reject(new Error("Operation cancelled while waiting for Herdr."));
    };
    signal?.addEventListener("abort", onAbort, { once: true });
  });
}

async function readHerdrPaneOutput(pi: ExtensionAPI, paneId: string, cwd: string): Promise<string | undefined> {
  const result = await exec(
    pi,
    "herdr",
    ["pane", "read", paneId, "--source", "recent-unwrapped", "--lines", "120"],
    cwd,
    10_000,
  );
  if (result.killed || result.code !== 0 || !result.stdout?.trim()) return undefined;

  try {
    const parsed = parseHerdrResult<{ read?: { text?: string } }>(result, `pane read ${paneId}`);
    return parsed.read?.text?.trim().slice(-4_000);
  } catch {
    return undefined;
  }
}

async function closeOwnedHerdrTab(
  pi: ExtensionAPI,
  tabId: string,
  cwd: string,
): Promise<{ status: "closed" | "retained" | "indeterminate"; message: string }> {
  let result: ExecResult;
  try {
    result = await exec(pi, "herdr", ["tab", "close", tabId], cwd, 10_000);
  } catch (error) {
    return { status: "retained", message: `Could not close ${tabId}: ${describeError(error)}. Treat it as retained.` };
  }

  if (result.killed) {
    return { status: "indeterminate", message: `Closing ${tabId} was killed or timed out; inspect whether the tab remains.` };
  }
  if (result.code !== 0) {
    return { status: "retained", message: `Could not close ${tabId}: ${commandFailure(result)}. The tab is retained.` };
  }
  return { status: "closed", message: `Closed undispatched Herdr tab ${tabId}.` };
}

async function waitForHerdrPiAgent(
  pi: ExtensionAPI,
  paneId: string,
  tabId: string,
  cwd: string,
  signal?: AbortSignal,
  timeoutMs = WORKER_START_TIMEOUT_MS,
): Promise<HerdrAgent> {
  const deadline = Date.now() + timeoutMs;
  let lastObservation = "Pi was not detected in the pane.";

  while (Date.now() < deadline) {
    throwIfAborted(signal, `Waiting for Pi in ${paneId}`);
    const result = await exec(pi, "herdr", ["agent", "get", paneId], cwd, 5_000, signal);
    throwIfKilled(result, `Herdr agent get ${paneId}`);

    if (result.code === 0 && result.stdout?.trim()) {
      const parsed = parseHerdrResult<HerdrAgentResult>(result, `agent get ${paneId}`);
      const agent = parsed.agent;
      if (agent?.pane_id === paneId && agent.agent === "pi") {
        if (agent.agent_status === "blocked") {
          throw new Error(`Pi in retained Herdr tab ${tabId} / pane ${paneId} is blocked and needs user input.`);
        }
        if (agent.agent_status && agent.agent_status !== "unknown") return agent;
        lastObservation = `Pi was detected with status ${agent.agent_status ?? "unknown"}.`;
      } else {
        lastObservation = `Detected ${agent?.agent ?? "an unknown process"} instead of Pi.`;
      }
    } else if (result.code !== 1) {
      lastObservation = commandFailure(result);
    }

    await delay(500, signal);
  }

  const output = await readHerdrPaneOutput(pi, paneId, cwd);
  throw new Error(
    `Timed out waiting for Pi readiness in retained Herdr tab ${tabId} / pane ${paneId}. ${lastObservation}${output ? ` Recent output:\n${output}` : ""}`,
  );
}

async function verifyWorkerCheckout(
  pi: ExtensionAPI,
  agent: HerdrAgent,
  expectedBranch: string,
  sourceRoot: string,
  signal?: AbortSignal,
): Promise<string> {
  const foregroundCwd = agent.foreground_cwd?.trim();
  if (!foregroundCwd) throw new Error(`Herdr did not report a foreground cwd for Pi in ${agent.pane_id}.`);

  const worktreeRoot = await repoRoot(pi, foregroundCwd, signal);
  if (!worktreeRoot) throw new Error(`Pi in ${agent.pane_id} is not running inside a git worktree: ${foregroundCwd}.`);
  if (worktreeRoot === sourceRoot) {
    throw new Error(`Pi in ${agent.pane_id} started in the source checkout instead of an isolated worktree: ${sourceRoot}.`);
  }

  const branchResult = await exec(pi, "git", ["branch", "--show-current"], worktreeRoot, 10_000, signal);
  throwIfKilled(branchResult, `Verifying branch in ${worktreeRoot}`);
  const actualBranch = branchResult.stdout?.trim();
  if (branchResult.code !== 0 || actualBranch !== expectedBranch) {
    throw new Error(
      `Pi in ${agent.pane_id} started on ${actualBranch || "an unknown branch"}; expected ${expectedBranch}.`,
    );
  }

  return worktreeRoot;
}

function buildPrReviewCommand(prNumber: number, baseBranch?: string): string {
  return `/pr-review-goal ${prNumber}${baseBranch ? ` --base=${baseBranch}` : ""}`;
}

function buildWorkerPrompt(input: {
  title: string;
  plan: string;
  baseBranch: string;
  repoRoot: string;
}): string {
  return `You are one independent coding agent in a concurrent multi-worktree fanout running in a dedicated Herdr tab.

Repository root that launched this job: ${input.repoRoot}
Base branch used to create this worktree: ${input.baseBranch}
Work item title: ${input.title}

Scope contract:
- Implement ONLY this work item. Do not opportunistically implement sibling phases or unrelated cleanup.
- Preserve the existing repo instructions and AGENTS.md constraints.
- If this work item is blocked or overlaps another launched work item in a way that makes a clean independent PR impossible, stop and ask for human guidance in this Herdr tab.
- Prefer the smallest coherent PR that satisfies this item.

Work item plan:
${input.plan}

After implementation, execute the local /go-pr flow with target-branch argument ${input.baseBranch} (equivalent to /go-pr ${input.baseBranch}). Match the PR description quality of /update-pr-description:

${PR_DESCRIPTION_QUALITY_CONTRACT}

The installed prompt template says:

--- begin /go-pr contract ---
If the slash prompt is unavailable in this startup context, follow these instructions exactly:

<<GO_PR_PROMPT_PLACEHOLDER>>
--- end /go-pr contract ---

Once the PR exists and you know its PR number, call fanout_go_pr_review_handoff as your final action with that PR number, this work item title, and baseBranch ${input.baseBranch}. That terminating tool renames this exact Herdr tab to the PR number, waits for this turn to settle, exits this Pi process, starts a fresh named Pi agent in the same pane and worktree, and submits /pr-review-goal with the same target branch. If the tool is unavailable, clearly report the PR number and ask the user to run /pr-review-goal <pr-number> --base=${input.baseBranch} manually.`;
}

function buildDecompositionPrompt(input: {
  baseBranch: string;
  assumeYes: boolean;
  repoRoot: string;
  plan?: string;
}): string {
  const planSource = input.plan?.trim()
    ? `Original plan provided to /fanout-go-pr:\n${input.plan.trim()}`
    : "No explicit plan text was passed to /fanout-go-pr. Infer the implementation plan from the preceding conversation context, including the user's latest requests, any active plan/handoff already discussed, and relevant assistant decisions. If the conversation context does not contain a concrete implementation plan, ask follow-up questions and DO NOT launch tools yet.";

  return `Turn the implementation plan into the fewest coherent PR-sized pieces that preserve meaningful parallel execution. Start from one PR; create an additional piece only when it has a clear, material concurrency benefit that outweighs its extra CI run, review cycle, worktree, Herdr tab, and agent-token cost.

Rules:
- Prefer true independence: no piece should require another launched piece to merge first.
- Prefer combining work that shares a feature outcome, subsystem, validation path, reviewer context, or likely files.
- Do not split merely because work is technically independent. Split only when every resulting PR is substantial, independently useful, and reduces overall delivery time.
- Documentation, tests, changelogs, small configuration changes, formatting, and incidental cleanup should normally travel with the functional change they support—not become standalone PRs. A docs-only PR is appropriate only when the user explicitly requests it or it is independently urgent.
- If dependencies exist, either keep dependent work in the same piece or ask follow-up questions before launching.
- If the plan is ambiguous, underspecified, or has risky cross-piece coupling, ask follow-up questions and DO NOT call tools yet.
- Each launched piece must be independently implementable, testable, commit-able, and PR-able.
- Before launching, briefly state why each additional PR is worth its separate CI run and review cycle. If there is no strong reason, merge it into the nearest coherent piece.
- Use base/PR target branch: ${input.baseBranch}.
- Repository root: ${input.repoRoot}.
- Launch every worker as a background Herdr tab in the current workspace and do not steal focus.
- ${input.assumeYes ? "The user passed --yes; if the split is clear, launch without asking for additional confirmation." : "Before launching, briefly present the proposed pieces. If they are clear and low-risk, proceed; otherwise ask for confirmation/follow-up."}

When you are ready to launch, call fanout_go_pr_launch exactly once with:
- repoRoot: ${input.repoRoot}
- baseBranch: ${input.baseBranch}
- pieces: an array of { title, branchName, plan }

Branch naming:
- branchName should be short, unique, lowercase, and prefixed with agent/.
- Avoid slashes beyond the agent/ prefix except if needed by repo convention.

${planSource}`;
}

async function readGoPrPrompt(pi: ExtensionAPI): Promise<string> {
  let promptPath = process.env.PI_GO_PR_PROMPT_PATH?.trim() || DEFAULT_GO_PR_PROMPT_PATH;

  if (!process.env.PI_GO_PR_PROMPT_PATH) {
    try {
      const command = pi.getCommands().find((candidate) => candidate.name === "go-pr" && candidate.source === "prompt");
      if (command?.sourceInfo.path) promptPath = command.sourceInfo.path;
    } catch {
      // Use the conventional global prompt path below.
    }
  }

  try {
    return await readFile(promptPath, "utf8");
  } catch (error) {
    throw new Error(
      `Required /go-pr prompt could not be read from ${promptPath}: ${error instanceof Error ? error.message : String(error)}. Install the prompt or set PI_GO_PR_PROMPT_PATH.`,
    );
  }
}

function createRunId(now = new Date(), entropy = randomUUID()): string {
  const timestamp = now.toISOString().replace(/[^0-9]/g, "").slice(0, 14);
  const suffix = entropy.toLowerCase().replace(/[^a-z0-9]/g, "").slice(0, 8) || "fanout";
  return `${timestamp}-${suffix}`;
}

function normalizeBranchName(requested: string | undefined, title: string, runId: string, index: number): string {
  const branchName = (requested?.trim() || `agent/${slugify(title)}-${runId}-${index + 1}`).replace(/^\/+/, "");
  return branchName.startsWith("agent/") ? branchName : `agent/${slugify(branchName)}`;
}

function preparePieces(input: {
  pieces: Array<{ title: string; branchName?: string; plan: string }>;
  baseBranch: string;
  repoRoot: string;
  runId: string;
  promptDir: string;
  goPrPrompt: string;
}): PreparedPiece[] {
  const seenBranches = new Set<string>();

  return input.pieces.map((piece, index) => {
    const title = piece.title.trim();
    const plan = piece.plan.trim();
    if (!title) throw new Error(`Piece ${index + 1} has an empty title.`);
    if (!plan) throw new Error(`Piece ${index + 1} has an empty plan.`);

    const branchName = normalizeBranchName(piece.branchName, title, input.runId, index);
    if (seenBranches.has(branchName)) throw new Error(`Duplicate fanout branch name: ${branchName}.`);
    seenBranches.add(branchName);

    const runSuffix = input.runId.slice(-8);
    const tabLabel = `pr-${index + 1}-${slugify(title).slice(0, 24)}-${runSuffix}`.slice(0, 40);
    const sessionName = `fanout-${index + 1}-${slugify(title)}`.slice(0, 60);
    const promptFile = join(input.promptDir, `${String(index + 1).padStart(2, "0")}-${slugify(title)}.md`);
    const workerPrompt = buildWorkerPrompt({
      title,
      plan,
      baseBranch: input.baseBranch,
      repoRoot: input.repoRoot,
    }).replace("<<GO_PR_PROMPT_PLACEHOLDER>>", input.goPrPrompt);

    return { title, branchName, tabLabel, sessionName, promptFile, workerPrompt };
  });
}

function buildWorkerCommand(input: {
  repoRoot: string;
  branchName: string;
  baseBranch: string;
  sessionName: string;
  promptFile: string;
}): string {
  return [
    "set -e",
    `cd ${shellQuote(input.repoRoot)}`,
    `wt switch --create ${shellQuote(input.branchName)} --base ${shellQuote(input.baseBranch)} --yes -x ${shellQuote(`pi --name ${shellQuote(input.sessionName)}`)} -- ${shellQuote(`@${input.promptFile}`)} ${shellQuote("Execute the attached independent work item instructions.")}`,
  ].join("; ");
}

function createReviewAgentName(prNumber: number, entropy = randomUUID()): string {
  const suffix = entropy.toLowerCase().replace(/[^a-z0-9]/g, "").slice(0, 8) || "handoff";
  const prefix = `pr-review-${prNumber}`.slice(0, 31 - suffix.length).replace(/-+$/g, "");
  return `${prefix}-${suffix}`;
}

function buildReviewHandoffScript(input: {
  herdrPath: string;
  paneId: string;
  repoRoot: string;
  agentName: string;
  sessionName: string;
  reviewCommand: string;
  idleTimeoutMs?: number;
}): string {
  const timeout = input.idleTimeoutMs ?? HANDOFF_IDLE_TIMEOUT_MS;
  const marker = `HERDR_CWD_READY_${input.agentName.replace(/[^a-zA-Z0-9]/g, "_")}`;
  const cdCommand = `cd ${shellQuote(input.repoRoot)} && printf '%s\\n' ${shellQuote(marker)}`;

  return `#!/bin/sh
set -eu

HERDR=${shellQuote(input.herdrPath)}
PANE=${shellQuote(input.paneId)}
MARKER=${shellQuote(marker)}
WORKTREE_COMMAND=${shellQuote(cdCommand)}
AGENT=${shellQuote(input.agentName)}
SESSION=${shellQuote(input.sessionName)}
REVIEW_COMMAND=${shellQuote(input.reviewCommand)}

cleanup() {
  rm -f -- "$0"
}
trap cleanup EXIT HUP INT TERM

echo "Waiting for fanout worker in $PANE to settle..."
"$HERDR" agent wait "$PANE" --until idle --until done --timeout ${timeout} >/dev/null

echo "Stopping settled worker agent in $PANE..."
"$HERDR" agent send-keys "$PANE" ctrl+d >/dev/null

attempt=0
while "$HERDR" agent get "$PANE" >/dev/null 2>&1; do
  attempt=$((attempt + 1))
  if [ "$attempt" -ge 120 ]; then
    echo "Timed out waiting for the previous Pi agent to exit." >&2
    exit 1
  fi
  sleep 0.5
done

"$HERDR" pane run "$PANE" "$WORKTREE_COMMAND"
"$HERDR" pane wait-output "$PANE" --regex "^${marker}$" --source recent-unwrapped --lines 120 --timeout 10000 >/dev/null

started=0
attempt=0
while [ "$attempt" -lt 12 ]; do
  attempt=$((attempt + 1))
  if "$HERDR" agent start "$AGENT" --kind pi --pane "$PANE" --timeout 10000 -- --name "$SESSION"; then
    started=1
    break
  fi
  if "$HERDR" agent get "$PANE" 2>/dev/null | grep -Eq '"agent"[[:space:]]*:[[:space:]]*"pi"'; then
    started=1
    break
  fi
  sleep 1
done

if [ "$started" -ne 1 ]; then
  echo "Failed to start fresh Pi agent $AGENT in $PANE." >&2
  exit 1
fi

echo "Submitting $REVIEW_COMMAND to Pi in $PANE..."
"$HERDR" agent prompt "$PANE" "$REVIEW_COMMAND" >/dev/null
echo "Review handoff submitted."
`;
}

function spawnDetachedHandoff(scriptPath: string, logPath: string, cwd: string): number {
  const logFd = openSync(logPath, "ax", 0o600);
  try {
    const child = spawn("/bin/sh", [scriptPath], {
      cwd,
      detached: true,
      env: { ...process.env },
      stdio: ["ignore", logFd, logFd],
    });
    child.on("error", () => undefined);
    child.unref();
    if (!child.pid) throw new Error("Detached Herdr handoff process did not start.");
    return child.pid;
  } finally {
    closeSync(logFd);
  }
}

function describeError(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

export default function (pi: ExtensionAPI) {
  pi.registerCommand("fanout-go-pr", {
    description: "Consolidate a plan into the fewest useful concurrent wt/Herdr PR agents, then launch same-tab review handoffs (-b <branch> to set the base branch)",
    handler: async (args, ctx) => {
      let parsed: FanoutOptions;
      try {
        parsed = parseArgs(args);
      } catch (error) {
        ctx.ui.notify(describeError(error), "warning");
        return;
      }

      const root = await repoRoot(pi, ctx.cwd);
      if (!root) {
        ctx.ui.notify("/fanout-go-pr must be run inside a git repository.", "warning");
        return;
      }

      try {
        for (const binary of ["herdr", "wt", "pi"]) {
          const found = await requireCommand(pi, binary, root);
          if (!found) throw new Error(`Required command not found in PATH: ${binary}`);
        }
        await currentHerdrContext(pi, root);
        await validateBranch(pi, parsed.baseBranch, root, "base branch");
        await requireGitRef(pi, parsed.baseBranch, root);
      } catch (error) {
        ctx.ui.notify(describeError(error), "warning");
        return;
      }

      const plan = parsed.plan.trim();
      pi.sendUserMessage(buildDecompositionPrompt({
        baseBranch: parsed.baseBranch,
        assumeYes: parsed.assumeYes,
        repoRoot: root,
        plan: plan || undefined,
      }));
    },
  });

  pi.registerTool({
    name: "fanout_go_pr_launch",
    label: "Launch fanout PR agents in Herdr",
    description: "Create background Herdr tabs in the current workspace, use wt to create one git worktree per tab, and start independent Pi agents for PR-sized work items. The tool preserves focus and returns exact Herdr workspace, tab, and pane IDs.",
    promptSnippet: "Launch independent Herdr-tab/wt/Pi agents for a decomposed PR fanout plan.",
    promptGuidelines: [
      "Use fanout_go_pr_launch only after /fanout-go-pr has produced a clear independent split; ask follow-up questions instead of launching ambiguous or dependent pieces.",
    ],
    parameters: Type.Object({
      repoRoot: Type.String({ minLength: 1, description: "Git repository root from which /fanout-go-pr was called." }),
      baseBranch: Type.Optional(Type.String({ minLength: 1, description: "Base branch for wt switch --create and target branch for the downstream PR/review. Defaults to develop." })),
      pieces: Type.Array(Type.Object({
        title: Type.String({ minLength: 1, description: "Short human-readable work item title." }),
        branchName: Type.Optional(Type.String({ minLength: 1, description: "Unique branch name, preferably agent/<slug>." })),
        plan: Type.String({ minLength: 1, description: "Full implementation instructions for this independent work item." }),
      }), { minItems: 1, maxItems: 12 }),
    }),
    async execute(_toolCallId, params, signal, onUpdate, ctx) {
      const root = await repoRoot(pi, params.repoRoot || ctx.cwd, signal);
      if (!root) throw new Error("fanout_go_pr_launch must run inside a git repository.");

      for (const binary of ["herdr", "wt", "pi"]) {
        const found = await requireCommand(pi, binary, root, signal);
        if (!found) throw new Error(`Required command not found in PATH: ${binary}`);
      }

      const herdr = await currentHerdrContext(pi, root, signal);
      const baseBranch = params.baseBranch?.trim() || DEFAULT_BASE_BRANCH;
      await validateBranch(pi, baseBranch, root, "base branch", signal);
      await requireGitRef(pi, baseBranch, root, signal);

      const goPrPrompt = await readGoPrPrompt(pi);
      const runId = createRunId();
      const promptDir = join(tmpdir(), `${PACKAGE_NAME}-${runId}`);
      await mkdir(promptDir, { recursive: false, mode: 0o700 });

      const prepared = preparePieces({
        pieces: params.pieces,
        baseBranch,
        repoRoot: root,
        runId,
        promptDir,
        goPrPrompt,
      });

      for (const piece of prepared) {
        await validateBranch(pi, piece.branchName, root, "fanout branch", signal);
        await requireBranchAvailable(pi, piece.branchName, root, signal);
        await writeFile(piece.promptFile, piece.workerPrompt, { encoding: "utf8", mode: 0o600, flag: "wx" });
      }

      const dispatched: Array<{
        title: string;
        branchName: string;
        tabLabel: string;
        tabId: string;
        paneId: string;
        promptFile: string;
      }> = [];

      try {
        for (const piece of prepared) {
          throwIfAborted(signal, `Creating Herdr tab for ${piece.title}`);

          onUpdate?.({
            content: [{ type: "text", text: `Dispatching ${piece.title} in background Herdr tab ${piece.tabLabel}...` }],
            details: { title: piece.title, tabLabel: piece.tabLabel, branchName: piece.branchName },
          });

          const createResult = await exec(
            pi,
            "herdr",
            ["tab", "create", "--workspace", herdr.workspaceId, "--cwd", root, "--label", piece.tabLabel, "--no-focus"],
            root,
            15_000,
          );
          const created = parseHerdrResult<HerdrTabCreatedResult>(createResult, `tab create for ${piece.title}`);
          const tabId = created.tab?.tab_id;
          const paneId = created.root_pane?.pane_id;
          if (!tabId || !paneId) {
            const cleanup = tabId
              ? await closeOwnedHerdrTab(pi, tabId, root)
              : { message: `No tab ID was returned; inspect workspace ${herdr.workspaceId} for label ${piece.tabLabel}.` };
            throw new Error(
              `Herdr tab create for ${piece.title} did not return both tab and root pane IDs. ${cleanup.message}`,
            );
          }

          if (signal?.aborted) {
            const cleanup = await closeOwnedHerdrTab(pi, tabId, root);
            throw new Error(`Fanout launch was cancelled after creating ${tabId}. ${cleanup.message}`);
          }

          const workerCommand = buildWorkerCommand({
            repoRoot: root,
            branchName: piece.branchName,
            baseBranch,
            sessionName: piece.sessionName,
            promptFile: piece.promptFile,
          });
          const runResult = await exec(pi, "herdr", ["pane", "run", paneId, workerCommand], root, 10_000);
          if (runResult.killed) {
            throw new Error(
              `Dispatch outcome is indeterminate for retained Herdr tab ${tabId} / pane ${paneId}: ${commandFailure(runResult)}. Inspect it before retrying.`,
            );
          }
          if (runResult.code !== 0) {
            const cleanup = await closeOwnedHerdrTab(pi, tabId, root);
            throw new Error(
              `Failed to dispatch ${piece.title} in Herdr pane ${paneId}: ${commandFailure(runResult)}. ${cleanup.message}`,
            );
          }

          dispatched.push({
            title: piece.title,
            branchName: piece.branchName,
            tabLabel: piece.tabLabel,
            tabId,
            paneId,
            promptFile: piece.promptFile,
          });
        }
      } catch (error) {
        const prior = dispatched.map((item) => `${item.tabId}/${item.paneId}`).join(", ") || "none";
        throw new Error(`${describeError(error)} Previously dispatched tabs retained: ${prior}.`);
      }

      onUpdate?.({
        content: [{ type: "text", text: `Verifying ${dispatched.length} dispatched Herdr worker(s)...` }],
        details: { dispatched: dispatched.map((item) => ({ tabId: item.tabId, paneId: item.paneId })) },
      });

      const readiness = await Promise.allSettled(dispatched.map(async (item) => {
        const agent = await waitForHerdrPiAgent(pi, item.paneId, item.tabId, root, signal);
        const worktreeRoot = await verifyWorkerCheckout(pi, agent, item.branchName, root, signal);
        return {
          ...item,
          agentStatus: agent.agent_status,
          worktreeRoot,
        };
      }));

      const launched = readiness.flatMap((result) => result.status === "fulfilled" ? [result.value] : []);
      const failures = readiness
        .map((result, index) => result.status === "rejected"
          ? `${dispatched[index]?.tabId}/${dispatched[index]?.paneId}: ${describeError(result.reason)}`
          : undefined)
        .filter((failure): failure is string => Boolean(failure));

      if (failures.length === 0) {
        await rm(promptDir, { recursive: true, force: true });
      }

      if (failures.length > 0) {
        const ready = launched.map((item) => `${item.tabId}/${item.paneId}`).join(", ") || "none";
        throw new Error(
          `One or more Herdr workers did not become ready. Ready tabs: ${ready}. Retained failure tabs:\n${failures.join("\n")}`,
        );
      }

      const summary = launched
        .map((item) => `- ${item.tabId} / ${item.paneId}: ${item.branchName} (${item.title}) [${item.agentStatus}]`)
        .join("\n");
      return {
        content: [{ type: "text", text: `Launched and verified ${launched.length} fanout PR agent(s) as background Herdr tabs in ${herdr.workspaceId}:\n${summary}` }],
        details: {
          launched,
          baseBranch,
          repoRoot: root,
          promptDir,
          workspaceId: herdr.workspaceId,
          callerTabId: herdr.tabId,
          callerPaneId: herdr.paneId,
        },
      };
    },
  });

  pi.registerTool({
    name: "fanout_go_pr_review_handoff",
    label: "Start fresh PR review in this Herdr tab",
    description: "As the worker's final action, rename the exact current Herdr tab to the PR number and queue a detached same-pane handoff. The handoff waits for the worker to settle, exits it, restores the worktree cwd, starts a fresh named Pi agent through Herdr, and submits /pr-review-goal with the expected target branch.",
    promptSnippet: "Rename this Herdr tab to the PR number and hand it to a clean same-pane PR review agent.",
    promptGuidelines: [
      "Use fanout_go_pr_review_handoff only as the final action after a fanout worker has created a PR and knows its PR number; pass the worker's baseBranch so /pr-review-goal verifies the intended target.",
      "Do not call other tools alongside fanout_go_pr_review_handoff; it is terminating so the Herdr handoff can wait for the worker to settle safely.",
    ],
    parameters: Type.Object({
      prNumber: Type.Integer({ minimum: 1, maximum: Number.MAX_SAFE_INTEGER, description: "GitHub PR number to review." }),
      title: Type.Optional(Type.String({ description: "Work item title, retained only as handoff metadata." })),
      repoRoot: Type.Optional(Type.String({ description: "Repo/worktree root. Defaults to current cwd." })),
      baseBranch: Type.String({ minLength: 1, description: "Expected PR target branch; always forwarded to /pr-review-goal --base." }),
    }),
    async execute(_toolCallId, params, signal, _onUpdate, ctx) {
      const prNumber = Number(params.prNumber);
      if (!Number.isSafeInteger(prNumber) || prNumber <= 0) {
        throw new Error("prNumber must be a positive integer.");
      }

      const root = await repoRoot(pi, params.repoRoot || ctx.cwd, signal);
      if (!root) throw new Error("fanout_go_pr_review_handoff must run inside a git repository.");

      const herdrPath = await requireCommand(pi, "herdr", root, signal);
      if (!herdrPath) throw new Error("Required command not found in PATH: herdr");
      const piPath = await requireCommand(pi, "pi", root, signal);
      if (!piPath) throw new Error("Required command not found in PATH: pi");

      const baseBranch = params.baseBranch.trim();
      if (!baseBranch) throw new Error("baseBranch must be nonempty.");
      await validateBranch(pi, baseBranch, root, "target branch", signal);
      await requireGitRef(pi, baseBranch, root, signal);

      const herdr = await currentHerdrContext(pi, root, signal);
      throwIfAborted(signal, "PR review handoff");
      const tabLabel = String(prNumber);
      const renameResult = await exec(pi, "herdr", ["tab", "rename", herdr.tabId, tabLabel], root, 10_000);
      throwIfKilled(renameResult, `Renaming Herdr tab ${herdr.tabId}`);
      if (renameResult.code !== 0) {
        throw new Error(`Failed to rename Herdr tab ${herdr.tabId} to ${tabLabel}: ${commandFailure(renameResult)}`);
      }

      const sessionName = `pr-review-${prNumber}`;
      const agentName = createReviewAgentName(prNumber);
      const reviewCommand = buildPrReviewCommand(prNumber, baseBranch);
      const handoffId = `${Date.now()}-${prNumber}-${randomUUID().slice(0, 8)}`;
      const scriptPath = join(tmpdir(), `${PACKAGE_NAME}-review-handoff-${handoffId}.sh`);
      const logPath = join(tmpdir(), `${PACKAGE_NAME}-review-handoff-${handoffId}.log`);
      const script = buildReviewHandoffScript({
        herdrPath,
        paneId: herdr.paneId,
        repoRoot: root,
        agentName,
        sessionName,
        reviewCommand,
      });
      await writeFile(scriptPath, script, { encoding: "utf8", mode: 0o700, flag: "wx" });

      let handoffPid: number;
      try {
        handoffPid = spawnDetachedHandoff(scriptPath, logPath, root);
      } catch (error) {
        await unlink(scriptPath).catch(() => undefined);
        throw error;
      }

      return {
        content: [{
          type: "text",
          text: `Renamed Herdr tab ${herdr.tabId} to ${prNumber}. Queued detached handoff PID ${handoffPid}: after this terminating tool settles, it will replace the agent in ${herdr.paneId} with ${agentName} and submit ${reviewCommand}. Log: ${logPath}`,
        }],
        details: {
          prNumber,
          baseBranch,
          tabLabel,
          tabId: herdr.tabId,
          paneId: herdr.paneId,
          workspaceId: herdr.workspaceId,
          scriptPath,
          logPath,
          handoffPid,
          agentName,
          sessionName,
          reviewCommand,
          repoRoot: root,
          title: params.title,
        },
        terminate: true,
      };
    },
  });
}

export const __testing = {
  buildDecompositionPrompt,
  buildPrReviewCommand,
  buildReviewHandoffScript,
  buildWorkerCommand,
  buildWorkerPrompt,
  closeOwnedHerdrTab,
  createReviewAgentName,
  createRunId,
  normalizeBranchName,
  parseArgs,
  parseHerdrResult,
  preparePieces,
  shellQuote,
  slugify,
  verifyWorkerCheckout,
  waitForHerdrPiAgent,
};
