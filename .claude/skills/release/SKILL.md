---
name: release
description: Cut a new release of the claude-converse plugin. Use when the user says "release", "cut a release", "ship X.Y.Z", or "tag a version".
---

# Releasing claude-converse

## When to release

**Only release when the user explicitly says to.** Do not infer readiness from completing a feature.

## The release process

1. **Confirm the tree is clean and pushed.**
   ```bash
   git status
   git pull --rebase
   ```
   Abort if there are uncommitted changes or unpushed commits that aren't meant to ship.

2. **Bump the version.**
   ```bash
   cz bump
   ```
   Infers patch/minor from commit types. To override: `cz bump --increment MINOR` or `cz bump X.Y.Z`.

3. **Push.**
   ```bash
   git push --follow-tags
   ```

4. **Write release notes.** Do **not** use `--generate-notes`. Use the commit log as raw material, but write human-readable prose — not a mechanical dump of commit messages. Use the log to jog your memory:
   ```bash
   git --no-pager log --oneline vPREV..vX.Y.Z
   ```
   Then:
   ```bash
   gh release create vX.Y.Z --title "vX.Y.Z" --notes "$(cat <<'EOF'
   ## Theme

   - Bullet referencing (abc1234)
   EOF
   )"
   ```
   Or `--notes-file path.md` if the notes are long.

## Verification

After release:

```bash
gh release view vX.Y.Z            # release exists with notes
git --no-pager tag -l --sort=v:refname | tail -5   # tag is there
gh repo view nafg/claude-converse --json latestRelease
```

