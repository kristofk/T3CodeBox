---
name: ship
description: Finish the current pull request - review it, mark it ready, and watch CI until GitHub auto-merges it. Use when the change on this branch is done, or when asked to ship, finish or land a pull request.
---

# Ship a pull request

Takes the pull request of the current branch from draft to merged. The automerge workflow turns on
auto-merge when the pull request is marked ready; this skill never merges or turns on auto-merge itself.

1. **Everything pushed.** Commit and push what is left. No pull request yet: `gh pr create --draft`.
2. **Title and description.** The squash merge makes them the commit on `main`: the title a short
   subject, the description what changed and why, `Closes #N` for the issue it fixes.
   `gh pr edit --title ... --body ...` if needed.
3. **Review.** Read `gh pr diff` as a reviewer would (or run the code-review skill at low effort).
   Fix what you find, push, and review again.
4. **Ready.** `gh pr ready`. Within a minute `gh pr view --json state,autoMergeRequest` shows
   auto-merge on, or the pull request already merged if its checks had passed while it was a draft.
   If neither, look at the automerge run (`gh run list --workflow automerge.yml`) and report it
   instead of turning auto-merge on by hand.
5. **Watch CI.** `gh pr checks --watch`; the test jobs take about five minutes. On a failure, read
   `gh run view <run-id> --log-failed`:
   - Upstream trouble before the tests ran (a registry's `429 Too Many Requests` or 5xx, a download
     that timed out, a lost runner): `gh run rerun <run-id> --failed`, at most twice (#28).
   - Anything else: `gh pr ready --undo` so a later green push can't merge unreviewed, fix it on the
     branch, and go back to step 3.
6. **Merged.** `gh pr view --json state,mergeCommit` shows `MERGED`. Report the pull request and
   the merge commit, or what is still blocking it.
