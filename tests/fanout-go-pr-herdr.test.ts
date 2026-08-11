import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { mkdtempSync, rmSync, statSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import extension, { __testing } from "../extensions/fanout-go-pr-herdr.ts";

test("parseArgs keeps the source command contract", () => {
  assert.deepEqual(__testing.parseArgs("--yes --base release/2026 ship the feature"), {
    baseBranch: "release/2026",
    assumeYes: true,
    plan: "ship the feature",
  });
  assert.deepEqual(__testing.parseArgs("-b 'feature/base' plan text"), {
    baseBranch: "feature/base",
    assumeYes: false,
    plan: "plan text",
  });
  assert.deepEqual(__testing.parseArgs(undefined), {
    baseBranch: "develop",
    assumeYes: false,
    plan: "",
  });
  assert.deepEqual(__testing.parseArgs("--base=release/o'hai ship it"), {
    baseBranch: "release/o'hai",
    assumeYes: false,
    plan: "ship it",
  });
  assert.deepEqual(__testing.parseArgs('--base="release/quoted" "plan with spaces"'), {
    baseBranch: "release/quoted",
    assumeYes: false,
    plan: "plan with spaces",
  });
  assert.throws(() => __testing.parseArgs("--base"), /Missing value/);
  assert.throws(() => __testing.parseArgs("--base="), /cannot be empty/);
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

test("worker and decomposition prompts describe Herdr behavior", () => {
  const worker = __testing.buildWorkerPrompt({
    title: "Add API",
    plan: "Implement the endpoint",
    baseBranch: "develop",
    repoRoot: "/repo",
  });
  const decomposition = __testing.buildDecompositionPrompt({
    baseBranch: "develop",
    assumeYes: true,
    repoRoot: "/repo",
    plan: "Implement the endpoint",
  });

  assert.match(worker, /dedicated Herdr tab/);
  assert.match(worker, /terminating tool/);
  const literalGoPrPiece = __testing.preparePieces({
    pieces: [{ title: "Ship", plan: "Implement, then run /go-pr" }],
    baseBranch: "develop",
    repoRoot: "/repo",
    runId: "20260102030405-abcdef12",
    promptDir: "/tmp/prompts",
    goPrPrompt: "INSTALLED GO PR CONTRACT",
  })[0];

  assert.match(decomposition, /background Herdr tab/);
  assert.match(literalGoPrPiece?.workerPrompt ?? "", /INSTALLED GO PR CONTRACT/);
  assert.doesNotMatch(worker, /tmux/);
  assert.doesNotMatch(decomposition, /tmux/);
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
        pieces: [
          { title: "API", branchName: "agent/api", plan: "Implement API" },
          { title: "UI", branchName: "agent/ui", plan: "Implement UI" },
        ],
      },
      new AbortController().signal,
      undefined,
      { cwd: "/repo" },
    );

    assert.equal(result.details.workspaceId, "w9");
    assert.equal(result.details.launched.length, 2);
    assert.deepEqual(
      result.details.launched.map((item: { worktreeRoot: string }) => item.worktreeRoot),
      ["/repo.worktree-api", "/repo.worktree-ui"],
    );
    assert.equal(statSync(result.details.promptDir).mode & 0o777, 0o700);
    for (const item of result.details.launched as Array<{ promptFile: string }>) {
      assert.equal(statSync(item.promptFile).mode & 0o777, 0o600);
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
