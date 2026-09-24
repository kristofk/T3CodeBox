# Working on T3CodeBox

## Pull requests

Every change goes through a pull request, one-line fixes included; `main` takes nothing else.

1. Branch from `main` and open the pull request as a draft: `gh pr create --draft`.
2. Push until the change is done. Drafts run CI but never merge.
3. `gh pr ready`. The automerge workflow turns on auto-merge, and GitHub squash-merges as soon as
   `check` and both `test` jobs pass. No approval needed.
4. More work after that: `gh pr ready --undo` first, or the next green push merges. Marking it ready
   again turns auto-merge back on.

A failing check blocks the merge; push the fix to the same branch.

The pull request title becomes the commit subject on `main`, and the description its body: say what
changed and why.

## Checks

`make check` and `make test` run the same scripts as CI and need Docker. Without Docker, CI is the test.
