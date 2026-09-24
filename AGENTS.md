# Working on T3CodeBox

Read [CONTRIBUTING.md](CONTRIBUTING.md) before opening a pull request: every change starts as a draft
and ends with `gh pr ready && gh pr merge --auto --squash`. In Claude Code the `ship` skill
(`.claude/skills/ship`) does the ending: review, ready, auto-merge, and CI up to the merge.

`make check` and `make test` need Docker. Without Docker, CI is the test.
