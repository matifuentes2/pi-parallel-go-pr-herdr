# pi-parallel-go-pr-herdr

A personal [Pi coding agent](https://github.com/earendil-works/pi) package that fans a large implementation plan into independent, worktree-backed PR agents running in background [Herdr](https://herdr.dev) tabs.

It is inspired by [`matifuentes2/pi-parallel-go-pr`](https://github.com/matifuentes2/pi-parallel-go-pr), but replaces tmux windows and tmux-driven review respawns with explicit Herdr workspace/tab/pane targeting and Herdr's agent lifecycle commands.

## What it does

```text
/fanout-go-pr [--base <branch>] [--yes] [plan text...]
```

The default base branch is `develop`.

1. Pi decomposes the plan into the fewest independently shippable PR-sized pieces.
2. `fanout_go_pr_launch` creates one **background Herdr tab** per piece in the caller's current workspace (`--no-focus`).
3. Each tab runs `wt switch --create` to create an isolated worktree and starts a named Pi worker with its scoped prompt. The launch tool reports success only after Herdr detects Pi in the exact returned pane and Git confirms that pane is on the expected branch in a separate worktree.
4. After opening its PR, the worker calls `fanout_go_pr_review_handoff` as its final action.
5. The handoff renames that exact Herdr tab to the PR number, waits for the worker to settle, exits it, restores the worktree cwd, starts a fresh Pi agent in the same pane, and submits `/pr-review-goal <number> --base=<branch>`.

Herdr IDs returned by the CLI are parsed from JSON. The extension never guesses a focused tab or pane, and background launches do not steal focus.

## Requirements

- Pi `0.84.1` or newer
- Herdr `0.8.0` or newer
- The parent Pi session must be running inside Herdr (`HERDR_ENV=1`)
- The Herdr Pi integration is strongly recommended (`herdr integration install pi`) so lifecycle state is authoritative; Herdr's screen-detection fallback may work but is less reliable for the review handoff
- [`wt`](https://worktrunk.dev) (Worktrunk CLI)
- `git`
- `gh` for the downstream `/go-pr` and `/pr-review-goal` flows
- The `/go-pr` prompt and `/pr-review-goal` extension available to every spawned Pi session. The extension fails closed if it cannot read `/go-pr`; set `PI_GO_PR_PROMPT_PATH` for a nonstandard prompt location

Check the local setup:

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

Do not enable this package and the tmux-based `pi-parallel-go-pr` package at the same time: they intentionally register the same command and tool names.

## Usage

From a Pi session running inside Herdr and inside the repository to change:

```text
/fanout-go-pr --base develop --yes Implement the approved plan from docs/plan.md
```

Without `--yes`, Pi presents or clarifies the proposed split before launch. Without plan text, Pi infers the plan from the preceding conversation and asks questions instead of launching if the context is not concrete enough.

Before creating tabs, the extension verifies that the base branch resolves to a commit and that every proposed local fanout branch is available.

### Registered surfaces

- `/fanout-go-pr`
- `fanout_go_pr_launch`
- `fanout_go_pr_review_handoff`

The tool names are primarily for Pi's model loop; normal usage starts with `/fanout-go-pr`.

## Review handoff safety

The review handoff is a terminating Pi tool. It starts a detached shell script that:

1. targets the worker's exact `HERDR_PANE_ID`;
2. waits only for Herdr `idle` or `done` (not `blocked`);
3. sends logical `ctrl+d` to exit the settled worker;
4. restores the worktree cwd in the pane's shell and waits for an exact, unique readiness marker;
5. starts a fresh named Pi agent with `herdr agent start`; and
6. verifies and prompts Pi through the exact pane ID, so a global agent-name collision cannot redirect the review.

The detached process survives the old Pi process exiting. Its log is written under the system temporary directory and returned in the handoff tool result. If a handoff fails, inspect that log and recover manually in the same tab:

```text
/pr-review-goal <pr-number> --base=<branch>
```

## Development

```bash
npm install
npm run check
```

The tests cover command parsing, Herdr JSON envelopes and killed outcomes, Worktrunk launch construction, exact-pane handoff generation, shell quoting, worker readiness/worktree verification, and duplicate branch protection.

## Notes

- Fanout prompt files and review handoff logs are stored under cryptographically unique names in the system temporary directory. Prompt directories use mode `0700`; prompt/log files use `0600` and exclusive creation.
- Successfully launched or dispatched tabs are left open on later partial/readiness failure so their agents and terminal output remain inspectable.
- A tab created for a command that is proven not to have been dispatched is closed by the extension.
- The extension never closes tabs or workspaces it did not create.

## License

MIT
