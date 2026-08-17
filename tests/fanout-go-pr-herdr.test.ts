import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { chmodSync, existsSync, mkdtempSync, readFileSync, rmSync, statSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import extension, { __testing } from "../extensions/fanout-go-pr-herdr.ts";

test("parseArgs defaults to Orca and accepts an explicit orchestrator", () => {
  assert.deepEqual(__testing.parseArgs("--yes --base release/2026 ship the feature"), {
    baseBranch: "release/2026",
    assumeYes: true,
    orchestrator: "orca",
    plan: "ship the feature",
  });
  assert.deepEqual(__testing.parseArgs("-o herdr -b 'feature/base' plan text"), {
    baseBranch: "feature/base",
    assumeYes: false,
    orchestrator: "herdr",
    plan: "plan text",
  });
  assert.deepEqual(__testing.parseArgs(undefined), {
    baseBranch: "develop",
    assumeYes: false,
    orchestrator: "orca",
    plan: "",
  });
  assert.deepEqual(__testing.parseArgs("--base=release/o'hai --orchestrator=orca ship it"), {
    baseBranch: "release/o'hai",
    assumeYes: false,
    orchestrator: "orca",
    plan: "ship it",
  });
  assert.deepEqual(__testing.parseArgs('--base="release/quoted" "plan with spaces"'), {
    baseBranch: "release/quoted",
    assumeYes: false,
    orchestrator: "orca",
    plan: "plan with spaces",
  });
  assert.throws(() => __testing.parseArgs("--base"), /Missing value/);
  assert.throws(() => __testing.parseArgs("--base="), /cannot be empty/);
  assert.throws(() => __testing.parseArgs("--orchestrator"), /Missing value/);
  assert.throws(() => __testing.parseArgs("--orchestrator tmux"), /Unsupported orchestrator/);
});

test("Herdr JSON parsing requires a successful result envelope", () => {
  const parsed = __testing.parseHerdrResult<{ pane: { pane_id: string } }>({
    code: 0,
    stdout: JSON.stringify({ id: "cli:pane:current", result: { pane: { pane_id: "w1:p2" } } }),
  }, "pane current");
  assert.equal(parsed.pane.pane_id, "w1:p2");

  assert.throws(
    () => __testing.parseHerdrResult({ code: 1, stderr: "socket unavailable" }, "pane current"),
    /socket unavailable/,
  );
  assert.throws(
    () => __testing.parseHerdrResult({ code: 0, killed: true, stdout: "{}" }, "pane current"),
    /killed or cancelled/,
  );
  assert.throws(
    () => __testing.parseHerdrResult({ code: 0, stdout: "not-json" }, "pane current"),
    /invalid JSON/,
  );
  assert.throws(
    () => __testing.parseHerdrResult({ code: 0, stdout: "{}" }, "pane current"),
    /did not include a result/,
  );
});

test("Orca JSON parsing requires an ok result envelope", () => {
  const parsed = __testing.parseOrcaResult<{ runtime: { reachable: boolean } }>({
    code: 0,
    stdout: JSON.stringify({ id: "cli:status", ok: true, result: { runtime: { reachable: true } } }),
  }, "status");
  assert.equal(parsed.runtime.reachable, true);

  assert.throws(
    () => __testing.parseOrcaResult({
      code: 1,
      stdout: JSON.stringify({ ok: false, error: { code: "runtime_down", message: "runtime unavailable" } }),
    }, "status"),
    /runtime unavailable/,
  );
  assert.throws(
    () => __testing.parseOrcaResult({ code: 0, killed: true, stdout: "{}" }, "status"),
    /killed or cancelled/,
  );
  assert.throws(
    () => __testing.parseOrcaResult({ code: 0, stdout: "not-json" }, "status"),
    /invalid JSON/,
  );
  assert.throws(
    () => __testing.parseOrcaResult({ code: 0, stdout: JSON.stringify({ ok: true }) }, "status"),
    /did not include a result/,
  );
});

test("worker launch command uses Worktrunk in a Herdr pane and never tmux", () => {
  const command = __testing.buildWorkerCommand({
    repoRoot: "/tmp/repo with space",
    branchName: "agent/quote-test",
    baseBranch: "develop",
    sessionName: "fanout-1-test",
    promptFile: "/tmp/prompt file.md",
  });

  assert.match(command, /wt switch --create/);
  assert.match(command, /pi --name/);
  assert.match(command, /@\/tmp\/prompt file\.md/);
  assert.doesNotMatch(command, /tmux/);
});

test("Orca worker arguments use agent-first background worktree creation", () => {
  const args = __testing.buildOrcaWorkerArgs({
    repoRoot: "/tmp/repo with space",
    branchName: "agent/quote-test",
    baseBranch: "develop",
    workerPrompt: "Implement the scoped item",
  });

  assert.deepEqual(args.slice(0, 6), [
    "worktree",
    "create",
    "--repo",
    "path:/tmp/repo with space",
    "--name",
    "agent/quote-test",
  ]);
  assert.ok(args.includes("--no-parent"));
  assert.equal(args[args.indexOf("--setup") + 1], "run");
  assert.ok(args.includes("--agent"));
  assert.equal(args[args.indexOf("--agent") + 1], "pi");
  assert.equal(args[args.indexOf("--prompt") + 1], "Implement the scoped item");
  assert.ok(args.includes("--json"));
  assert.ok(!args.includes("--activate"));
  assert.ok(!args.some((arg) => /herdr|wt switch|tmux/.test(arg)));
});

test("worker and decomposition prompts describe the selected orchestrator", () => {
  const orcaWorker = __testing.buildWorkerPrompt({
    title: "Add API",
    plan: "Implement the endpoint",
    baseBranch: "develop",
    repoRoot: "/repo",
  });
  const orcaDecomposition = __testing.buildDecompositionPrompt({
    baseBranch: "develop",
    assumeYes: true,
    repoRoot: "/repo",
    plan: "Implement the endpoint",
  });
  const herdrWorker = __testing.buildWorkerPrompt({
    title: "Add API",
    plan: "Implement the endpoint",
    baseBranch: "develop",
    repoRoot: "/repo",
    orchestrator: "herdr",
  });
  const herdrDecomposition = __testing.buildDecompositionPrompt({
    baseBranch: "develop",
    assumeYes: true,
    repoRoot: "/repo",
    orchestrator: "herdr",
    plan: "Implement the endpoint",
  });

  assert.match(orcaWorker, /dedicated Orca worktree/);
  assert.match(orcaWorker, /orchestrator orca/);
  assert.match(orcaDecomposition, /orchestrator: orca/);
  assert.match(orcaDecomposition, /background Orca worktree/);
  assert.match(herdrWorker, /dedicated Herdr tab/);
  assert.match(herdrWorker, /orchestrator herdr/);
  assert.match(herdrDecomposition, /background Herdr tab/);
  const literalGoPrPiece = __testing.preparePieces({
    pieces: [{ title: "Ship", plan: "Implement, then run /go-pr" }],
    baseBranch: "develop",
    repoRoot: "/repo",
    orchestrator: "orca",
    runId: "20260102030405-abcdef12",
    promptDir: "/tmp/prompts",
    goPrPrompt: "INSTALLED GO PR CONTRACT",
  })[0];

  assert.match(literalGoPrPiece?.workerPrompt ?? "", /INSTALLED GO PR CONTRACT/);
  assert.doesNotMatch(orcaWorker, /tmux/);
  assert.doesNotMatch(herdrDecomposition, /tmux/);
});

test("review handoff script targets the exact Herdr pane", () => {
  const script = __testing.buildReviewHandoffScript({
    herdrPath: "/opt/herdr",
    paneId: "w7:p11",
    repoRoot: "/tmp/worktree's root",
    agentName: "pr-review-42-abc123",
    sessionName: "pr-review-42",
    reviewCommand: "/pr-review-goal 42 --base=release/one",
    idleTimeoutMs: 12345,
  });

  assert.match(script, /agent wait "\$PANE" --until idle --until done --timeout 12345/);
  assert.match(script, /agent send-keys "\$PANE" ctrl\+d/);
  assert.match(script, /pane run "\$PANE" "\$WORKTREE_COMMAND"/);
  assert.match(script, /pane wait-output "\$PANE" --regex "\^HERDR_CWD_READY_/);
  assert.match(script, /agent start "\$AGENT" --kind pi --pane "\$PANE"/);
  assert.match(script, /agent prompt "\$PANE" "\$REVIEW_COMMAND"/);
  assert.match(script, /w7:p11/);
  assert.match(script, /pr-review-goal 42 --base=release\/one/);
  assert.doesNotMatch(script, /tmux/);

  const syntax = spawnSync("/bin/sh", ["-n"], { input: script, encoding: "utf8" });
  assert.equal(syntax.status, 0, syntax.stderr);
});

test("Orca review handoff waits for exit and creates a fresh terminal", () => {
  const script = __testing.buildOrcaReviewHandoffScript({
    orcaPath: "/opt/orca",
    piPath: "/opt/pi",
    parentPid: 4321,
    repoRoot: "/tmp/worktree's root",
    agentName: "pr-review-42-abc123",
    sessionName: "pr-review-42",
    reviewCommand: "/pr-review-goal 42 --base=release/one",
    idleTimeoutMs: 12345,
  });

  assert.match(script, /PARENT_PID = 4321/);
  assert.match(script, /terminal", "create"/);
  assert.match(script, /"--worktree", WORKTREE/);
  assert.match(script, /"--for", "tui-idle"/);
  assert.match(script, /terminal", "send"/);
  assert.match(script, /pr-review-goal 42 --base=release\/one/);
  assert.doesNotMatch(script, /herdr|tmux/i);

  const fixtureDir = mkdtempSync(join(tmpdir(), "pi-orca-script-test-"));
  const scriptPath = join(fixtureDir, "handoff.mjs");
  try {
    writeFileSync(scriptPath, script, { mode: 0o600 });
    const syntax = spawnSync(process.execPath, ["--check", scriptPath], { encoding: "utf8" });
    assert.equal(syntax.status, 0, syntax.stderr);
  } finally {
    rmSync(fixtureDir, { recursive: true, force: true });
  }
});

test("Orca review handoff script targets the returned terminal handle", () => {
  const fixtureDir = mkdtempSync(join(tmpdir(), "pi-orca-handoff-run-"));
  const fakeOrcaPath = join(fixtureDir, "fake orca");
  const callsPath = join(fixtureDir, "calls.jsonl");
  const scriptPath = join(fixtureDir, "handoff.mjs");
  writeFileSync(fakeOrcaPath, `#!/usr/bin/env node
const fs = require("node:fs");
const args = process.argv.slice(2);
fs.appendFileSync(${JSON.stringify(callsPath)}, JSON.stringify(args) + "\\n");
const result = args[0] === "terminal" && args[1] === "create"
  ? { terminal: { handle: "term-review" } }
  : {};
process.stdout.write(JSON.stringify({ ok: true, result }));
`, { mode: 0o700 });
  chmodSync(fakeOrcaPath, 0o700);
  const script = __testing.buildOrcaReviewHandoffScript({
    orcaPath: fakeOrcaPath,
    piPath: "/opt/pi",
    parentPid: 999_999_999,
    repoRoot: "/tmp/worktree",
    agentName: "pr-review-42-abc123",
    sessionName: "pr-review-42",
    reviewCommand: "/pr-review-goal 42 --base=develop",
    idleTimeoutMs: 1_000,
  });
  writeFileSync(scriptPath, script, { mode: 0o600 });

  try {
    const run = spawnSync(process.execPath, [scriptPath], { encoding: "utf8", timeout: 10_000 });
    assert.equal(run.status, 0, run.stderr);
    const calls = readFileSync(callsPath, "utf8").trim().split("\n").map((line) => JSON.parse(line) as string[]);
    assert.deepEqual(calls.map((args) => args.slice(0, 2)), [
      ["terminal", "create"],
      ["terminal", "wait"],
      ["terminal", "send"],
    ]);
    assert.equal(calls[1]?.[calls[1].indexOf("--terminal") + 1], "term-review");
    assert.equal(calls[2]?.[calls[2].indexOf("--terminal") + 1], "term-review");
    assert.equal(calls[2]?.[calls[2].indexOf("--text") + 1], "/pr-review-goal 42 --base=develop");
  } finally {
    rmSync(fixtureDir, { recursive: true, force: true });
  }
});

test("piece preparation produces unique files and rejects duplicate branches", () => {
  const pieces = __testing.preparePieces({
    pieces: [
      { title: "First API", branchName: "agent/first", plan: "Do first" },
      { title: "Second API", plan: "Do second" },
    ],
    baseBranch: "develop",
    repoRoot: "/repo",
    runId: "20260102030405",
    promptDir: "/tmp/prompts",
    goPrPrompt: "GO PR",
  });

  assert.equal(pieces.length, 2);
  assert.equal(pieces[0]?.branchName, "agent/first");
  assert.equal(pieces[1]?.branchName, "agent/second-api-20260102030405-2");
  assert.notEqual(pieces[0]?.promptFile, pieces[1]?.promptFile);
  assert.match(pieces[0]?.workerPrompt ?? "", /GO PR/);

  assert.throws(() => __testing.preparePieces({
    pieces: [
      { title: "One", branchName: "agent/same", plan: "A" },
      { title: "Two", branchName: "agent/same", plan: "B" },
    ],
    baseBranch: "develop",
    repoRoot: "/repo",
    runId: "run",
    promptDir: "/tmp/prompts",
    goPrPrompt: "GO PR",
  }), /Duplicate fanout branch/);
});

test("helpers preserve shell safety and stable naming", () => {
  assert.equal(__testing.shellQuote("a'b"), "'a'\"'\"'b'");
  assert.equal(
    __testing.createRunId(new Date("2026-01-02T03:04:05.000Z"), "abcdef12-3456-7890-abcd-ef1234567890"),
    "20260102030405-abcdef12",
  );
  assert.equal(__testing.buildPrReviewCommand(17, "release/one"), "/pr-review-goal 17 --base=release/one");
  assert.equal(__testing.normalizeOrchestrator(undefined), "orca");
  assert.equal(__testing.normalizeOrchestrator("HERDR"), "herdr");
  assert.equal(__testing.resolveOrcaCommand({ ORCA_CLI_COMMAND: "/custom/orca" }, "darwin"), "/custom/orca");
  assert.equal(__testing.resolveOrcaCommand({ ORCA_DEV_REPO_ROOT: "/src/orca" }, "darwin"), "orca-dev");
  assert.equal(__testing.resolveOrcaCommand({}, "linux"), "orca-ide");
  assert.equal(__testing.resolveOrcaCommand({ ORCA_WORKTREE_ID: "repo::/worktree" }, "linux"), "orca");
  assert.equal(__testing.resolveOrcaCommand({ ORCA_TERMINAL_HANDLE: "terminal:1" }, "linux"), "orca");
  assert.equal(__testing.resolveOrcaCommand({}, "darwin"), "orca");
  assert.match(
    __testing.describeOrcaLaunchFailure(new Error("timed out"), [], "agent/api"),
    /none identified.*branch agent\/api may have completed.*before retrying/,
  );
  assert.equal(
    __testing.createReviewAgentName(17, "12345678-abcd-efab-cdef-1234567890ab"),
    "pr-review-17-12345678",
  );
  assert.match(
    __testing.createReviewAgentName(Number.MAX_SAFE_INTEGER, "abcdef12-0000-0000-0000-000000000000"),
    /^[a-z][a-z0-9_-]{0,31}$/,
  );
});

test("owned-tab cleanup reports closed, retained, and indeterminate outcomes accurately", async () => {
  const cleanup = async (result: { code: number; killed?: boolean; stderr?: string }) => {
    const pi = { async exec() { return result; } } as unknown as Parameters<typeof __testing.closeOwnedHerdrTab>[0];
    return __testing.closeOwnedHerdrTab(pi, "w1:t2", "/repo");
  };

  assert.equal((await cleanup({ code: 0 })).status, "closed");
  assert.equal((await cleanup({ code: 1, stderr: "refused" })).status, "retained");
  assert.equal((await cleanup({ code: 0, killed: true })).status, "indeterminate");
});

test("worker readiness rejects blocked agents and wrong worktree branches", async () => {
  const blockedPi = {
    async exec() {
      return {
        code: 0,
        stdout: JSON.stringify({
          id: "cli:agent:get",
          result: {
            type: "agent_info",
            agent: { agent: "pi", agent_status: "blocked", pane_id: "w1:p2", tab_id: "w1:t2", workspace_id: "w1" },
          },
        }),
      };
    },
  } as unknown as Parameters<typeof __testing.waitForHerdrPiAgent>[0];

  await assert.rejects(
    () => __testing.waitForHerdrPiAgent(blockedPi, "w1:p2", "w1:t2", "/repo", undefined, 10),
    /blocked and needs user input/,
  );

  const wrongBranchPi = {
    async exec(command: string, args: string[]) {
      if (command === "git" && args[0] === "rev-parse") return { code: 0, stdout: "/worktree\n" };
      if (command === "git" && args[0] === "branch") return { code: 0, stdout: "agent/wrong\n" };
      throw new Error(`Unexpected command: ${command} ${args.join(" ")}`);
    },
  } as unknown as Parameters<typeof __testing.verifyWorkerCheckout>[0];

  await assert.rejects(
    () => __testing.verifyWorkerCheckout(
      wrongBranchPi,
      { agent: "pi", agent_status: "working", pane_id: "w1:p2", foreground_cwd: "/worktree" },
      "agent/expected",
      "/repo",
    ),
    /expected agent\/expected/,
  );
});

test("launch tool creates no-focus Herdr tabs and dispatches workers to returned panes", async () => {
  const commands = new Map<string, unknown>();
  const tools = new Map<string, any>();
  const calls: Array<{ command: string; args: string[] }> = [];
  let tabCounter = 0;

  const fakePi = {
    registerCommand(name: string, definition: unknown) {
      commands.set(name, definition);
    },
    registerTool(definition: { name: string }) {
      tools.set(definition.name, definition);
    },
    sendUserMessage() {},
    getCommands() {
      return [];
    },
    async exec(command: string, args: string[], options?: { cwd?: string }) {
      calls.push({ command, args });
      if (command === "git" && args[0] === "rev-parse" && args[1] === "--show-toplevel") {
        return { code: 0, stdout: `${options?.cwd ?? "/repo"}\n` };
      }
      if (command === "git" && args[0] === "rev-parse") return { code: 0, stdout: "deadbeef\n" };
      if (command === "git" && args[0] === "check-ref-format") return { code: 0, stdout: "" };
      if (command === "git" && args[0] === "show-ref") return { code: 1, stdout: "" };
      if (command === "git" && args[0] === "branch") {
        return { code: 0, stdout: options?.cwd?.endsWith("-api") ? "agent/api\n" : "agent/ui\n" };
      }
      if (command === "sh" && args[0] === "-lc") return { code: 0, stdout: "/mock/bin\n" };
      if (command === "herdr" && args[0] === "pane" && args[1] === "current") {
        return {
          code: 0,
          stdout: JSON.stringify({
            id: "cli:pane:current",
            result: {
              type: "pane_current",
              pane: { pane_id: "w9:p1", tab_id: "w9:t1", workspace_id: "w9" },
            },
          }),
        };
      }
      if (command === "herdr" && args[0] === "tab" && args[1] === "create") {
        tabCounter += 1;
        return {
          code: 0,
          stdout: JSON.stringify({
            id: "cli:tab:create",
            result: {
              type: "tab_created",
              tab: { tab_id: `w9:t${tabCounter + 1}`, workspace_id: "w9" },
              root_pane: { pane_id: `w9:p${tabCounter + 1}`, workspace_id: "w9" },
            },
          }),
        };
      }
      if (command === "herdr" && args[0] === "pane" && args[1] === "run") return { code: 0, stdout: "" };
      if (command === "herdr" && args[0] === "agent" && args[1] === "get") {
        return {
          code: 0,
          stdout: JSON.stringify({
            id: "cli:agent:get",
            result: {
              type: "agent_info",
              agent: {
                agent: "pi",
                agent_status: "working",
                pane_id: args[2],
                tab_id: args[2] === "w9:p2" ? "w9:t2" : "w9:t3",
                workspace_id: "w9",
                foreground_cwd: args[2] === "w9:p2" ? "/repo.worktree-api" : "/repo.worktree-ui",
              },
            },
          }),
        };
      }
      throw new Error(`Unexpected command: ${command} ${args.join(" ")}`);
    },
  };

  extension(fakePi as unknown as Parameters<typeof extension>[0]);
  assert.ok(commands.has("fanout-go-pr"));
  const launch = tools.get("fanout_go_pr_launch");
  const handoff = tools.get("fanout_go_pr_review_handoff");
  assert.ok(launch);
  assert.ok(handoff);
  assert.ok(handoff.parameters.required.includes("baseBranch"));
  assert.equal(handoff.parameters.properties.prNumber.type, "integer");
  assert.equal(handoff.parameters.properties.prNumber.minimum, 1);

  const fixtureDir = mkdtempSync(join(tmpdir(), "pi-herdr-test-"));
  const goPrPromptPath = join(fixtureDir, "go-pr.md");
  writeFileSync(goPrPromptPath, "GO PR TEST CONTRACT", { mode: 0o600 });
  const previousHerdrEnv = process.env.HERDR_ENV;
  const previousPromptPath = process.env.PI_GO_PR_PROMPT_PATH;
  let generatedPromptDir: string | undefined;
  process.env.HERDR_ENV = "1";
  process.env.PI_GO_PR_PROMPT_PATH = goPrPromptPath;
  try {
    const result = await launch.execute(
      "tool-call",
      {
        repoRoot: "/repo",
        baseBranch: "develop",
        orchestrator: "herdr",
        pieces: [
          { title: "API", branchName: "agent/api", plan: "Implement API" },
          { title: "UI", branchName: "agent/ui", plan: "Implement UI" },
        ],
      },
      new AbortController().signal,
      undefined,
      { cwd: "/repo" },
    );

    assert.equal(result.details.orchestrator, "herdr");
    assert.equal(result.details.workspaceId, "w9");
    assert.equal(result.details.launched.length, 2);
    assert.deepEqual(
      result.details.launched.map((item: { worktreeRoot: string }) => item.worktreeRoot),
      ["/repo.worktree-api", "/repo.worktree-ui"],
    );
    assert.equal(existsSync(result.details.promptDir), false);
    for (const item of result.details.launched as Array<{ promptFile: string }>) {
      assert.equal(existsSync(item.promptFile), false);
    }
    generatedPromptDir = result.details.promptDir;
  } finally {
    if (previousHerdrEnv === undefined) delete process.env.HERDR_ENV;
    else process.env.HERDR_ENV = previousHerdrEnv;
    if (previousPromptPath === undefined) delete process.env.PI_GO_PR_PROMPT_PATH;
    else process.env.PI_GO_PR_PROMPT_PATH = previousPromptPath;
    if (generatedPromptDir) rmSync(generatedPromptDir, { recursive: true, force: true });
    rmSync(fixtureDir, { recursive: true, force: true });
  }

  const tabCreates = calls.filter((call) => call.command === "herdr" && call.args[0] === "tab" && call.args[1] === "create");
  const paneRuns = calls.filter((call) => call.command === "herdr" && call.args[0] === "pane" && call.args[1] === "run");
  assert.equal(tabCreates.length, 2);
  assert.equal(paneRuns.length, 2);
  for (const call of tabCreates) {
    assert.ok(call.args.includes("--no-focus"));
    assert.deepEqual(call.args.slice(2, 5), ["--workspace", "w9", "--cwd"]);
  }
  assert.equal(paneRuns[0]?.args[2], "w9:p2");
  assert.equal(paneRuns[1]?.args[2], "w9:p3");
  assert.ok(paneRuns.every((call) => call.args[3]?.includes("wt switch --create")));
  assert.ok(calls.every((call) => !call.args.some((arg) => arg.includes("tmux"))));
});

test("launch tool defaults to Orca and starts Pi in background worktrees", async () => {
  const tools = new Map<string, any>();
  const calls: Array<{ command: string; args: string[]; cwd?: string }> = [];

  const fakePi = {
    registerCommand() {},
    registerTool(definition: { name: string }) {
      tools.set(definition.name, definition);
    },
    sendUserMessage() {},
    getCommands() {
      return [];
    },
    async exec(command: string, args: string[], options?: { cwd?: string }) {
      calls.push({ command, args, cwd: options?.cwd });
      if (command === "git" && args[0] === "rev-parse" && args[1] === "--show-toplevel") {
        return { code: 0, stdout: `${options?.cwd ?? "/repo"}\n` };
      }
      if (command === "git" && args[0] === "rev-parse") return { code: 0, stdout: "deadbeef\n" };
      if (command === "git" && args[0] === "check-ref-format") return { code: 0, stdout: "" };
      if (command === "git" && args[0] === "show-ref") return { code: 1, stdout: "" };
      if (command === "git" && args[0] === "branch") {
        return { code: 0, stdout: options?.cwd?.endsWith("-api") ? "agent/api\n" : "agent/ui\n" };
      }
      if (command === "sh" && args[0] === "-lc") return { code: 0, stdout: `/mock/${args[2]?.includes("pi") ? "pi" : "orca"}\n` };
      if (command === "orca" && args[0] === "status") {
        return { code: 0, stdout: JSON.stringify({ ok: true, result: { runtime: { reachable: true, state: "ready" } } }) };
      }
      if (command === "orca" && args[0] === "repo" && args[1] === "show") {
        return { code: 0, stdout: JSON.stringify({ ok: true, result: { repo: { id: "repo-1" } } }) };
      }
      if (command === "orca" && args[0] === "worktree" && args[1] === "create") {
        const branch = args[args.indexOf("--name") + 1];
        const suffix = branch === "agent/api" ? "api" : "ui";
        const path = `/repo.orca-${suffix}`;
        return {
          code: 0,
          stdout: JSON.stringify({
            ok: true,
            result: {
              worktree: { id: `repo-1::${path}`, path, branch },
              agentTerminalHandle: `term-${suffix}`,
            },
          }),
        };
      }
      if (command === "orca" && args[0] === "terminal" && args[1] === "show") {
        const handle = args[args.indexOf("--terminal") + 1];
        const suffix = handle === "term-api" ? "api" : "ui";
        const path = `/repo.orca-${suffix}`;
        return {
          code: 0,
          stdout: JSON.stringify({
            ok: true,
            result: {
              terminal: {
                handle,
                worktreeId: `repo-1::${path}`,
                worktreePath: path,
                connected: true,
                writable: true,
                orphaned: false,
              },
            },
          }),
        };
      }
      throw new Error(`Unexpected command: ${command} ${args.join(" ")}`);
    },
  };

  extension(fakePi as unknown as Parameters<typeof extension>[0]);
  const launch = tools.get("fanout_go_pr_launch");
  assert.ok(launch);
  assert.deepEqual(launch.parameters.properties.orchestrator.enum, ["orca", "herdr"]);

  const fixtureDir = mkdtempSync(join(tmpdir(), "pi-orca-test-"));
  const goPrPromptPath = join(fixtureDir, "go-pr.md");
  writeFileSync(goPrPromptPath, "GO PR TEST CONTRACT", { mode: 0o600 });
  const previousOrcaCommand = process.env.ORCA_CLI_COMMAND;
  const previousPromptPath = process.env.PI_GO_PR_PROMPT_PATH;
  let generatedPromptDir: string | undefined;
  process.env.ORCA_CLI_COMMAND = "orca";
  process.env.PI_GO_PR_PROMPT_PATH = goPrPromptPath;
  try {
    const result = await launch.execute(
      "tool-call",
      {
        repoRoot: "/repo",
        baseBranch: "develop",
        pieces: [
          { title: "API", branchName: "agent/api", plan: "Implement API" },
          { title: "UI", branchName: "agent/ui", plan: "Implement UI" },
        ],
      },
      new AbortController().signal,
      undefined,
      { cwd: "/repo" },
    );

    assert.equal(result.details.orchestrator, "orca");
    assert.equal(result.details.launched.length, 2);
    assert.deepEqual(
      result.details.launched.map((item: { worktreeRoot: string; terminalHandle: string }) => [item.worktreeRoot, item.terminalHandle]),
      [["/repo.orca-api", "term-api"], ["/repo.orca-ui", "term-ui"]],
    );
    assert.equal(existsSync(result.details.promptDir), false);
    for (const item of result.details.launched as Array<{ promptFile: string }>) {
      assert.equal(existsSync(item.promptFile), false);
    }
    generatedPromptDir = result.details.promptDir;
  } finally {
    if (previousOrcaCommand === undefined) delete process.env.ORCA_CLI_COMMAND;
    else process.env.ORCA_CLI_COMMAND = previousOrcaCommand;
    if (previousPromptPath === undefined) delete process.env.PI_GO_PR_PROMPT_PATH;
    else process.env.PI_GO_PR_PROMPT_PATH = previousPromptPath;
    if (generatedPromptDir) rmSync(generatedPromptDir, { recursive: true, force: true });
    rmSync(fixtureDir, { recursive: true, force: true });
  }

  const creates = calls.filter((call) => call.command === "orca" && call.args[0] === "worktree" && call.args[1] === "create");
  assert.equal(creates.length, 2);
  assert.equal(calls.filter((call) => call.command === "orca" && call.args[0] === "terminal" && call.args[1] === "show").length, 2);
  for (const call of creates) {
    assert.equal(call.args[call.args.indexOf("--agent") + 1], "pi");
    assert.equal(call.args[call.args.indexOf("--repo") + 1], "path:/repo");
    assert.equal(call.args[call.args.indexOf("--base-branch") + 1], "develop");
    assert.ok(call.args.includes("--no-parent"));
    assert.equal(call.args[call.args.indexOf("--setup") + 1], "run");
    assert.ok(call.args.includes("--prompt"));
    assert.ok(!call.args.includes("--activate"));
  }
  assert.ok(calls.every((call) => call.command !== "herdr"));
  assert.ok(calls.every((call) => !call.args.some((arg) => arg.includes("wt switch") || arg.includes("tmux"))));
});
