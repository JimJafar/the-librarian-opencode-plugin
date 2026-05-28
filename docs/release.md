# Releasing the OpenCode plugin

This is the per-repo release file. The full cross-family runbook
(branching strategy, semver rules, version-coordination across the
plugin family) lives in the monorepo at
[`the-librarian/docs/release-runbook.md`](https://github.com/JimJafar/the-librarian/blob/main/docs/release-runbook.md).
Read that first if you're new to releases here.

## When to cut a release

Any merged PR that's user-visible (provider change, hook change,
install / config change, README claim change) earns a release.
Internal-only refactors, test-only changes, and CI-only changes don't.

A coordinated cross-repo change ships at the **same MINOR version**
as the monorepo. PATCH numbers drift freely.

## Semver, the short version

- **MAJOR** — provider interface break, hook signature break, removal
  of a public export.
- **MINOR** — new provider method, new hook, additive feature, new env
  var with a default.
- **PATCH** — bug fix, doc tweak, internal refactor, test-only change.

## OpenCode specifics: npm publish required

This is the only plugin in the family with an npm artifact —
`opencode plugin install` resolves against the npm registry, not
GitHub. A git tag alone won't reach users; the version on npm is what
they install.

## Steps

```sh
cd ~/code/the-librarian-opencode-plugin
git checkout main && git pull

# 1. Bump package.json
NEW=<X.Y.Z>
jq ".version = \"$NEW\"" package.json > tmp && mv tmp package.json

# 2. Move CHANGELOG [Unreleased] entries under [vX.Y.Z] - YYYY-MM-DD.
$EDITOR CHANGELOG.md

# 3. Branch, commit, PR
git checkout -b release/v$NEW
git add -A
git commit -m "chore(release): v$NEW"
git push -u origin release/v$NEW
gh pr create --title "chore(release): v$NEW"

# 4. After CI green + merge
git checkout main && git pull
git tag -a v$NEW -m "v$NEW"
git push origin v$NEW
gh release create v$NEW --title "v$NEW" --notes-from-tag

# 5. Publish to npm (separate step from the tag)
npm pack --dry-run                       # eyeball the file list
npm login                                # if not already
npm publish --access public
npm view the-librarian-opencode-plugin version   # confirm
```

Notes:

- Always `npm pack --dry-run` first. Anything outside `src/`,
  `commands/`, `README.md`, `LICENSE`, `package.json` is a smell.
- The repo's `.npmignore` (or `package.json` `files`) is the gate,
  not `.gitignore`.
- If a publish fails after a tag is already pushed, fix the publish
  problem and re-run `npm publish` against the same tag. Don't bump
  the version to "force" a republish — npm doesn't allow republishing
  the same version anyway.

Users update via `opencode plugin update the-librarian-opencode-plugin`
(which calls `npm install` under the hood).
