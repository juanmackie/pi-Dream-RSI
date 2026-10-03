# Releasing

A release is only done when **every surface below agrees on the same version**. The gallery mirrors npm, so a
stale publish is a stale pi.dev page.

## Surfaces

| Surface | What it is | How it gets the version |
|---------|------------|-------------------------|
| npm registry | Source of truth. `pi install npm:pi-dream-rsi` reads this. | GitHub Actions publishes when `package.json`'s version changes on `main` |
| [pi.dev/packages](https://pi.dev/packages/pi-dream-rsi) | Gallery of every npm package tagged `pi-package`. Derived, never edited by hand. | automatic, minutes after publish |
| git | Provenance for the tarball. | commit + `v<version>` tag |
| README | Install instructions. | `pi install npm:pi-dream-rsi` must match reality |
| Local installs | `~/.pi/agent/settings.json` — a local path entry tracks the working tree, an `npm:` entry does not. | `pi update npm:pi-dream-rsi` |

This repo is installed in the author's pi as a local path, so dev edits are live after `/reload` and never
require a publish. Publishing is for users, not for dogfooding — see [Development setup](#development-setup).

## One-time npm setup

The workflow uses npm trusted publishing with GitHub's short-lived OIDC identity, so no npm write token or SSH key
is stored in GitHub. Before its first release, open `pi-dream-rsi` on npmjs.com → **Settings → Trusted Publisher**
and add a GitHub Actions publisher with these values:

- Organization or user: `juanmackie`
- Repository: `pi-Dream-RSI`
- Workflow filename: `publish.yml` (filename only)
- Environment name: leave blank
- Allowed action: enable direct `npm publish`

The package's `repository.url` already matches this repository. npm verifies the publisher when a publish runs,
so the first version bump will fail until this one-time setup is saved. GitHub Actions then publishes public
packages with provenance automatically. See [npm's trusted publisher setup](https://docs.npmjs.com/trusted-publishers/).

## Steps

```bash
# 1. Everything the tarball ships must be committed — publish the repo, not the working tree.
git status --short                     # expect no surprises
npm run typecheck && npm test          # full suite; also runs via prepublishOnly

# 2. Version bump (keep the surfaces in step). npm version updates package.json and package-lock.json.
npm version patch --no-git-tag-version
#   ...edit README if install instructions changed...

# 3. Commit the changes and push through a PR to main. A package version change triggers publishing;
#    changes to code/docs without a version bump do not.
git add -A
git commit -m "release v$(node -p "require('./package.json').version")"
git push -u origin HEAD
#   ...open and merge the PR into main...

# 4. After merge, GitHub Actions runs the package's prepublishOnly checks and publishes through OIDC.
#    Wait for "Publish to npm" to succeed, then verify the registry:
npm view pi-dream-rsi version dist.tarball

# 5. Tag the published commit. Annotated (-a): `--follow-tags` only pushes annotated tags.
git tag -a "v$(node -p "require('./package.json').version")" -m "release v$(node -p "require('./package.json').version")"
git push origin main --follow-tags

# 6. Verify the gallery picked it up (it lags npm by a few minutes; 404 here means not listed).
curl -s -o /dev/null -w "%{http_code}\n" https://pi.dev/packages/pi-dream-rsi
```

## Check before publishing

- `npm pack --dry-run` lists the files you expect. `files` in `package.json` gates this.
- `pi-package` is still in `keywords` and `pi.extensions` / `pi.skills` still resolve. Drop either one and the
  package silently disappears from the gallery.
- Prompts and skills are shipped as-is — they are the product, and they are what goes stale first.
- `.github/workflows/publish.yml` only publishes a changed package version pushed to `main`. Its `npm publish`
  invokes `prepublishOnly`, which runs the typecheck and full test suite before upload; a failed check blocks release.
- Keep `npm publish` permission limited to the `publish.yml` trusted publisher. Publishing same-version code is
  rejected by npm, so every release needs a package version bump.
- README, both skills, command help/completions and tool descriptions must agree on all six tools,
  dashboard controls, mode gating and interrupted live-tree recovery. Historical plans are labelled as such.
- Linux and Windows CI must pass on the commit being released; recovery tests exercise process cleanup and
  durable checkpoints. On a scratch task, check `/dream-rsi help`, headless status and `Ctrl+Shift+D` while
  work runs. Interrupt and explicitly resume a live tree; confirm completed attempts are kept, original
  settings stay fixed, and only the completed world enters dream replay.
- `npm pack --dry-run` must include `dashboard.ts`, agent output decoding, progress/checkpoint/ownership
  modules, prompts and both skills. Terminal UI APIs come from the pi host; there are no package runtime deps.

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
