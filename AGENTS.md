# Repository guidance

- Keep the extension compatible with Pi packages loaded directly from Git.
- Preserve explicit Herdr workspace, tab, and pane targeting; never rely on UI focus.
- Background fanout must use `--no-focus`.
- Do not reintroduce tmux.
- Keep `fanout_go_pr_review_handoff` terminating and preserve its detached-process boundary.
- Run `npm run check` after changes.
