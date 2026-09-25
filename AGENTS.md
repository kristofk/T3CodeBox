# Working on T3CodeBox

Read [CONTRIBUTING.md](CONTRIBUTING.md) before opening a pull request: every change starts as a draft
and ends with `gh pr ready && gh pr merge --auto --squash`. In Claude Code the `ship` skill
(`.claude/skills/ship`) does the ending: review, ready, auto-merge, and CI up to the merge.

`make check` and `make test` need Docker. Without Docker, CI is the test.

How the images and the dashboard work, what the tools they drive actually do, and why things are the way
they are: [docs/](docs/README.md). A change that makes a page there wrong updates it in the same pull request.
