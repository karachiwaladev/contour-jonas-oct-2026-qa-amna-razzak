#!/usr/bin/env bash
# Stop hook: commit any leftover changes and push the current branch (main or a ticket-* branch),
# so finished work always reaches GitHub. It never merges: PRs are opened and merged by the factory loop.
# Non-destructive by design: no force-push, no reset of the working tree, no deletes.
# Prints a {"systemMessage": ...} line only when something happened or the push status changed.
set -u
cd "${CLAUDE_PROJECT_DIR:-.}" || exit 0
git rev-parse --is-inside-work-tree >/dev/null 2>&1 || exit 0

say() { node -e 'process.stdout.write(JSON.stringify({systemMessage: process.argv[1]}))' "$1"; }

# Only act on main or a ticket branch, and never in the middle of a merge, rebase or cherry-pick.
branch=$(git symbolic-ref --short -q HEAD)
case "$branch" in main|ticket-*) ;; *) exit 0 ;; esac
gitdir=$(git rev-parse --git-dir)
for f in MERGE_HEAD rebase-merge rebase-apply CHERRY_PICK_HEAD REVERT_HEAD; do
  [ -e "$gitdir/$f" ] && exit 0
done

msg=""
git add -A
if ! git diff --cached --quiet; then
  # Refuse to commit anything that looks like a secret; unstage only (files stay on disk).
  secrets=$(git diff --cached --name-only | grep -Ei '(^|/)(\.env(\..*)?|id_rsa.*|id_ed25519.*|.*\.pem|.*\.key|.*\.p12|hosts\.yml|credentials.*|.*secret.*)$')
  if [ -n "$secrets" ]; then
    git reset -q
    say "Auto-commit skipped: possible secrets staged ($(echo "$secrets" | tr '\n' ' ')). Nothing was committed."
    exit 0
  fi
  files=$(git diff --cached --name-only)
  count=$(echo "$files" | wc -l | tr -d ' ')
  summary=$(echo "$files" | head -5 | tr '\n' ',' | sed 's/,$//; s/,/, /g')
  [ "$count" -gt 5 ] && summary="$summary, +$((count - 5)) more"
  git commit -q -F - <<EOF
Auto-commit: $summary

Committed by the factory-loop Stop hook.

Co-Authored-By: Claude Opus 5.5 (1M context) <noreply@anthropic.com>
EOF
  msg="Auto-committed $count file(s): $summary."
fi

# Push if the branch is ahead of origin (or has never been pushed). Remember failures so a blocked
# push doesn't repeat the message every stop.
marker="$gitdir/factory-loop-push-failed"
if git rev-parse -q --verify '@{u}' >/dev/null 2>&1; then
  ahead=$(git rev-list --count '@{u}..HEAD')
else
  ahead=$(git rev-list --count "origin/main..HEAD" 2>/dev/null || echo 1)
fi
if [ "$ahead" -gt 0 ]; then
  if out=$(git push -q -u origin "$branch" 2>&1); then
    rm -f "$marker"
    msg="${msg:+$msg }Pushed $ahead commit(s) to origin/$branch."
  else
    reason=$(echo "$out" | grep -m1 -E 'remote:|fatal:|error:' | sed 's/^remote: //')
    if [ ! -f "$marker" ] || [ -n "$msg" ]; then
      msg="${msg:+$msg }Push failed ($ahead commit(s) waiting): $reason"
    fi
    echo "$reason" > "$marker"
  fi
fi

[ -n "$msg" ] && say "$msg"
exit 0
