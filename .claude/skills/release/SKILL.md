---
name: release
description: Cut a new release of the claude-converse plugin — bump version in both manifests, tag the bump commit, push the tag, create a GitHub release with auto-generated notes. Use when the user says "release", "cut a release", "ship X.Y.Z", "tag a version", or after landing a set of changes they want to publish.
---

# Releasing claude-converse

## When to release

Release when landing user-visible changes:

- New features (voice behaviors, configuration options, statusline integration changes)
- Bug fixes that change observable behavior
- Breaking changes to plugin manifest, hooks, environment variables, or statusline contract

Don't release for:

- Internal refactors with identical behavior
- Documentation-only changes (README tweaks, CLAUDE.md updates)
- Test or CI-only changes

**Cadence**: no fixed schedule. Release when there's something worth publishing and the tree is clean.

## Version numbers

Follow semver loosely:

- **Patch (0.5.0 → 0.5.1)**: bug fixes, backward-compatible polish
- **Minor (0.5.x → 0.6.0)**: new features, backward-compatible. Also any change to statusline or hook contract that users install-side need to know about.
- **Major (0.x → 1.0)**: when the plugin is considered stable and we commit to not breaking users. Not there yet.

## The release process

1. **Confirm the tree is clean and pushed.**
   ```bash
   git status
   git pull --rebase
   ```
   Abort if there are uncommitted changes or unpushed commits that aren't meant to ship.

2. **Bump the version in both manifests** — `.claude-plugin/plugin.json` and `.claude-plugin/marketplace.json`. Both must match.
   ```bash
   # Edit both files, then:
   git add .claude-plugin/plugin.json .claude-plugin/marketplace.json
   git commit -m "Bump plugin version to X.Y.Z"
   git push
   ```

3. **Tag the bump commit, push the tag, create the GitHub release with auto-generated notes.**
   ```bash
   git tag -a vX.Y.Z -m "vX.Y.Z"
   git push origin vX.Y.Z
   gh release create vX.Y.Z --title "vX.Y.Z" --generate-notes --notes-start-tag vPREV
   ```
   `--generate-notes` pulls commit messages between `--notes-start-tag` and the new tag; review the output and edit if a bullet is confusing out of context.

## Verification

After release:

```bash
gh release view vX.Y.Z            # release exists with notes
git --no-pager tag -l --sort=v:refname | tail -5   # tag is there
gh repo view nafg/claude-converse --json latestRelease
```

## Notes

- **Tag the bump commit, not HEAD**. If you accidentally let another commit land on main between the bump and the tag, users who `git checkout vX.Y.Z` get a version mismatch. `git tag -a vX.Y.Z <bump-commit-sha>` avoids this.
- **Both manifests**. `plugin.json` is what Claude Code reads after install; `marketplace.json` is what the marketplace UI shows pre-install. A mismatch means users see one version in the marketplace and another once installed.
- **Pre-tag sanity check**: `grep -H version .claude-plugin/*.json` should show the same version in both files.
- **Don't pre-push the tag** before the bump commit is on origin/main. `git push` the commit first; only tag+push the tag once the bump is upstream.
