# pi-parallel-go-pr-herdr

A personal [Pi coding agent](https://github.com/earendil-works/pi) package that fans a large implementation plan into independent, worktree-backed PR agents.

The package now supports two orchestrators:

- **Orca** — the default. Orca creates each worktree and launches Pi in its first terminal.
- **Herdr** — the original implementation. Worktrunk creates each worktree inside an explicitly targeted background Herdr tab.

It extends [`matifuentes2/pi-parallel-go-pr`](https://github.com/matifuentes2/pi-parallel-go-pr) without reintroducing tmux.

## What it does

```text
/fanout-go-pr [--orchestrator <orca|herdr>] [--base <branch>] [--yes] [plan text...]
```

Defaults:

- orchestrator: `orca`
- base branch: `develop`

The flow is:

1. Pi decomposes the plan into the fewest independently shippable PR-sized pieces.
2. `fanout_go_pr_launch` creates one isolated worktree and Pi worker per piece using the selected orchestrator.
3. The launch tool verifies that every worker is in a separate worktree on its expected branch.
4. After opening its PR, each worker calls `fanout_go_pr_review_handoff` with the same orchestrator.
5. A fresh Pi agent starts in the same worktree and receives `/pr-review-goal <number> --base=<branch>`.

### Orca launch behavior

The Orca path uses agent-first worktree creation:

```text
orca worktree create \
  --repo path:<repo-root> \
  --name <agent/branch> \
  --base-branch <base> \
  --no-parent \
  --setup run \
  --agent pi \
  --prompt <worker-prompt> \
  --json
```

It forces configured repository setup hooks with `--setup run` and deliberately omits `--activate`, so workers remain in the background and do not steal focus. It uses the exact worktree ID, path, and terminal handle returned by Orca, verifies that the terminal is connected and writable, and lets older runtimes fall back to an unambiguous terminal lookup.

For review, the terminating handoff renames the Orca worktree to the PR number, requests a graceful shutdown of the worker Pi process, and starts a detached handoff. After the old process exits, the handoff creates a fresh Pi terminal in the same worktree, waits for TUI readiness, and submits `/pr-review-goal`.

### Herdr launch behavior

The Herdr path preserves the original safety properties:

1. create one background tab in the caller's current workspace with `--no-focus`;
2. run `wt switch --create` in the exact returned root pane;
3. wait until Herdr detects Pi in that pane;
4. verify the pane's worktree and branch; and
5. perform the review handoff in that exact pane.

The extension never guesses a focused Herdr tab or pane.

## Requirements

All modes require:

- Pi `0.84.1` or newer
- `git`
- `gh` for the downstream `/go-pr` and `/pr-review-goal` flows
- The `/go-pr` prompt and `/pr-review-goal` extension available to every spawned Pi session
- Pi available as `pi` in `PATH`

The extension fails closed if it cannot read `/go-pr`. Set `PI_GO_PR_PROMPT_PATH` for a nonstandard prompt location.

### Orca mode

- A running Orca app and its current CLI
- The repository registered with Orca
- The `pi` TUI agent available to Orca

Check the setup:

```bash
orca status --json
orca repo list --json
orca repo add --path "$(git rev-parse --show-toplevel)" --json  # only if missing
command -v pi gh
```

The extension follows Orca's CLI selection rules: `ORCA_CLI_COMMAND`, then `orca-dev` for a dev checkout, `orca` inside an Orca-managed Linux terminal, `orca-ide` elsewhere on Linux, and otherwise `orca`.

### Herdr mode

- Herdr `0.8.0` or newer
- The parent Pi session running inside Herdr (`HERDR_ENV=1`)
- [`wt`](https://worktrunk.dev) (Worktrunk CLI)
- The Herdr Pi integration is strongly recommended (`herdr integration install pi`)

Check the setup:

```bash
herdr --version
herdr integration status
printf '%s\n' "$HERDR_ENV" "$HERDR_WORKSPACE_ID" "$HERDR_PANE_ID"
command -v wt pi gh
```

## Install

Install directly from GitHub:

```bash
pi install git:github.com/matifuentes2/pi-parallel-go-pr-herdr
```

Or try a checkout for one Pi run:

```bash
pi -e ./extensions/fanout-go-pr-herdr.ts
```

Do not enable this package and another package that registers `fanout-go-pr`, `fanout_go_pr_launch`, or `fanout_go_pr_review_handoff` at the same time unless you intentionally want Pi's suffixed duplicate-command behavior.

## Usage

Use Orca (default):

```text
/fanout-go-pr --base develop --yes Implement the approved plan from docs/plan.md
```

Select Herdr explicitly:

```text
/fanout-go-pr --orchestrator herdr --base develop Implement the approved plan
```

The short orchestrator flag is also supported:

```text
/fanout-go-pr -o orca -b release/2026 Ship the release plan
```

Without `--yes`, Pi presents or clarifies the proposed split before launch. Without plan text, Pi infers the plan from the preceding conversation and asks questions instead of launching if the context is not concrete enough.

Before creating worktrees, the extension verifies that the base branch resolves to a commit and every proposed local fanout branch is available.

### Registered surfaces

- `/fanout-go-pr`
- `fanout_go_pr_launch`
- `fanout_go_pr_review_handoff`

The tool names are primarily for Pi's model loop; normal usage starts with `/fanout-go-pr`.

## Review handoff safety

`fanout_go_pr_review_handoff` is terminating and must be the worker's final tool call.

- **Orca:** the detached Node process waits for the worker Pi process to exit, creates a uniquely titled terminal in the same worktree, waits for `tui-idle`, and targets the exact returned terminal handle.
- **Herdr:** the detached shell process waits only for `idle` or `done`, exits the settled worker, restores the worktree cwd, starts a fresh named Pi agent, and targets the exact Herdr pane ID.

The detached process survives the old Pi process exiting. Its `0600` log is written under the system temporary directory and returned in the handoff tool result. The log is intentionally retained for recovery; remove it after inspection because it can contain local operational metadata. If a handoff fails, inspect that log and recover manually in the worker worktree:

```text
/pr-review-goal <pr-number> --base=<branch>
```

## Development

```bash
npm install
npm run check
```

The tests cover command parsing and the Orca default, both JSON envelope formats, Orca agent-first arguments, Herdr no-focus dispatch, branch/worktree verification, both detached review scripts, shell safety, and duplicate branch protection.

## Notes

- Fanout prompt files and review handoff logs use cryptographically unique names in the system temporary directory. Prompt directories use mode `0700`; prompt/log files use `0600` and exclusive creation.
- Prompt directories are removed after every worker reaches verified readiness. They are retained when dispatch or readiness fails so affected Orca worktrees or Herdr tabs remain diagnosable; remove those directories manually after recovery.
- Review handoff logs are retained for diagnostics and should be removed after successful handoff or completed recovery.
- Successfully created Orca worktrees or dispatched Herdr tabs are retained on later partial/readiness failure so their state remains inspectable.
- Herdr tabs proven not to have received a worker command are closed; the extension never closes Herdr tabs or workspaces it did not create.
- Orca worktrees are never automatically removed after a partial failure.

## License

MIT
