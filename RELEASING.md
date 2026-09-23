# Releasing

A release is only done when **every surface below agrees on the same version**. The gallery mirrors npm, so a
stale publish is a stale pi.dev page.

## Surfaces

| Surface | What it is | How it gets the version |
|---------|------------|-------------------------|
| npm registry | Source of truth. `pi install npm:pi-dream-rsi` reads this. | `npm publish` |
| [pi.dev/packages](https://pi.dev/packages/pi-dream-rsi) | Gallery of every npm package tagged `pi-package`. Derived, never edited by hand. | automatic, minutes after publish |
| git | Provenance for the tarball. | commit + `v<version>` tag |
| README | Install instructions. | `pi install npm:pi-dream-rsi` must match reality |
| Local installs | `~/.pi/agent/settings.json` — a local path entry tracks the working tree, an `npm:` entry does not. | `pi update npm:pi-dream-rsi` |

This repo is installed in the author's pi as a local path, so dev edits are live after `/reload` and never
require a publish. Publishing is for users, not for dogfooding — see [Development setup](#development-setup).

## Steps

```bash
# 1. Everything the tarball ships must be committed — publish the repo, not the working tree.
git status --short                     # expect no surprises
npm run typecheck && npm test          # 97 tests; also runs via prepublishOnly

# 2. Version bump (keep the surfaces in step).
npm version patch --no-git-tag-version # 0.1.1 -> 0.1.2
#   ...edit README if install instructions changed...

# 3. Commit the bump first — the published tarball must correspond to a commit, never a dirty tree.
git commit -am "release v$(node -p "require('./package.json').version")"

# 4. Publish. Needs an authenticated npm session: `npm login`, then check `npm whoami`.
npm publish

# 5. Verify npm is live before tagging, so the tag never points at an unpublished commit.
npm view pi-dream-rsi version dist.tarball

# 6. Tag that commit and push. Annotated (-a): `--follow-tags` only pushes annotated tags.
git tag -a "v$(node -p "require('./package.json').version")" -m "release v$(node -p "require('./package.json').version")"
git push origin main --follow-tags

# 7. Verify the gallery picked it up (it lags npm by a few minutes; 404 here means not listed).
curl -s -o /dev/null -w "%{http_code}\n" https://pi.dev/packages/pi-dream-rsi
```

## Check before publishing

- `npm pack --dry-run` lists the files you expect. `files` in `package.json` gates this.
- `pi-package` is still in `keywords` and `pi.extensions` / `pi.skills` still resolve. Drop either one and the
  package silently disappears from the gallery.
- Prompts and skills are shipped as-is — they are the product, and they are what goes stale first.

## Development setup

Your pi must run your checkout, not the tarball — otherwise you cannot see your own edits.

```bash
pi install "C:/Users/juanm/Documents/GitHub/pi Dream-RSI"   # dev: working tree, /reload picks up edits
pi install npm:pi-dream-rsi                                # users: unpinned, so `pi update --extensions` works
```

- Install **one** form at a time. A local path plus an `npm:` entry loads the package twice (extensions and
  skills both), and a `.dream-rsi` loop would then have two copies of the policy surface competing.
- Verify what users actually get with a throwaway install that leaves settings untouched:

```bash
pi -e npm:pi-dream-rsi
```
