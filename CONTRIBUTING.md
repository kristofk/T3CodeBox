# Contributing

## Pull requests

Every change goes through a pull request, one-line fixes included; `main` takes nothing else. A pull
request squash-merges once `check` and both `test` jobs pass on a branch that is up to date with `main`.

1. Branch from `main` and open the pull request as a draft: `gh pr create --draft`. Drafts run CI but
   never merge.
2. Push until the change is done.
3. Mark it ready and turn on auto-merge:

   ```sh
   gh pr ready && gh pr merge --auto --squash
   ```

   On GitHub: "Ready for review", then "Enable auto-merge". GitHub merges once the checks pass, and
   deletes the branch.
4. Behind `main` because another pull request landed first: `gh pr update-branch` ("Update branch" on
   GitHub). CI runs again and auto-merge stays on.
5. More work once it is ready: `gh pr merge --disable-auto && gh pr ready --undo` first, or the next
   green push merges. Step 3 again when done.

A failing check blocks the merge. If it failed before the tests ran (a registry's 429, a lost runner),
re-run it: `gh run rerun <run-id> --failed`. Otherwise step 5: back to draft, fix, step 3.

The pull request title becomes the commit subject on `main`, and the description its body: say what
changed and why, and `Closes #N` for the issue it fixes.

### From a fork

Open the pull request from your fork as usual. A maintainer approves its CI run, reviews it, and merges.

## Checks

`make check` and `make test` run the same scripts as CI and need Docker.
