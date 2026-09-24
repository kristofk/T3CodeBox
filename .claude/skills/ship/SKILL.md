---
name: ship
description: Finish the current pull request - review it, mark it ready, turn on auto-merge, and watch CI until it merges. Use when the change on this branch is done, or when asked to ship, finish or land a pull request.
---

# Ship a pull request

Takes the pull request of the current branch from draft to merged, the way CONTRIBUTING.md describes.

1. **Everything pushed.** Commit and push what is left. No pull request yet: `gh pr create --draft`.
2. **Title and description.** The squash merge makes them the commit on `main`: the title a short
   subject, the description what changed and why, `Closes #N` for the issue it fixes.
   `gh pr edit --title ... --body ...` if needed.
3. **Review.** Read `gh pr diff` as a reviewer would (or run the code-review skill at low effort).
   Fix what you find, push, and review again.
4. **Ready.** `gh pr ready && gh pr merge --auto --squash`. If the checks already passed on an
   up-to-date branch, this merges at once; otherwise `gh pr view --json autoMergeRequest` shows
   auto-merge on.
5. **Watch.** Until it merges:
   - `gh pr view --json mergeStateStatus` is `BEHIND`: `gh pr update-branch`. CI runs again.
   - `gh pr checks --watch`; the test jobs take about five minutes. On a failure, read
     `gh run view <run-id> --log-failed`:
     - Upstream trouble before the tests ran (a registry's `429 Too Many Requests` or 5xx, a download
       that timed out, a lost runner): `gh run rerun <run-id> --failed`, at most twice (#28).
     - Anything else: `gh pr merge --disable-auto && gh pr ready --undo` so a later green push can't
       merge unreviewed, fix it on the branch, and go back to step 3.
6. **Merged.** `gh pr view --json state,mergeCommit` shows `MERGED`, and GitHub has deleted the branch
   (`git ls-remote --heads origin <branch>` prints nothing; if it doesn't, `git push origin --delete
   <branch>`). Report the pull request and the merge commit, or what is still blocking it.
