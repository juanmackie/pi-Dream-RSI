# Releasing

A release is only done when **every surface below agrees on the same version**. The gallery mirrors npm, so a
stale publish is a stale pi.dev page.

## Surfaces

| Surface | What it is | How it gets the version |
|---------|------------|-------------------------|
| npm registry | Source of truth. `pi install npm:pi-dream-rsi` reads this; the package page renders the packaged README and metadata. | GitHub Actions publishes when `package.json`'s version changes on `main`; maintainers can use interactive 2FA when no publish job will run |
| [pi.dev/packages](https://pi.dev/packages/pi-dream-rsi) | Gallery of every npm package tagged `pi-package`. Derived, never edited by hand. | automatic, minutes after publish |
| [GitHub repository](https://github.com/juanmackie/pi-Dream-RSI) | Source, issues and canonical README. | Merge the release commit to `main` |
| git | Provenance for the tarball. | release commit + `v<version>` tag |
| README | Install, command and feature documentation on GitHub and npm. | Ship the same README in the package tarball |
| Local installs | `~/.pi/agent/settings.json` — a local path entry tracks the working tree, an `npm:` entry does not. | `pi update npm:pi-dream-rsi` |

This repo is installed in the author's pi as a local path, so dev edits are live after `/reload` and never
require a publish. Publishing is for users, not for dogfooding — see [Development setup](#development-setup).

## One-time npm setup

The automated workflow uses npm trusted publishing with GitHub's short-lived OIDC identity, so no npm write token
or SSH key is stored in GitHub. To enable that path, open `pi-dream-rsi` on npmjs.com → **Settings → Trusted Publisher**
and add a GitHub Actions publisher with these values:

- Organization or user: `juanmackie`
- Repository: `pi-Dream-RSI`
- Workflow filename: `publish.yml` (filename only)
- Environment name: leave blank
- Allowed action: enable direct `npm publish`

The package's `repository.url` already matches this repository. A version-change publish requires npm's trusted
publisher association to match this repository and workflow; if that association is missing or mismatched, the
job will fail. GitHub Actions publishes public packages with provenance automatically when the association is
valid. This setup is required for automation, not for the interactive 2FA path below. See
[npm's trusted publisher setup](https://docs.npmjs.com/trusted-publishers/).

## Interactive 2FA publishing

The default is automated trusted publishing. Use the interactive path when no publish workflow will run for the
release (for example, the version is already on `main` but has not yet been published) or after the workflow has
failed before publishing. If a workflow is pending, wait for its final result first. Before any manual publish,
check `npm view pi-dream-rsi@<version> version`; never try to replace an existing version.

From the exact clean release commit, run `npm ci`, `npm run typecheck`, `npm test`, and `npm pack --dry-run`.
Then use `npm login` and run `npm publish` in an interactive terminal. Complete npm's security-key or
authenticator challenge at its prompt. Do not store or use a bypass-2FA token. After publishing, verify the
registry version and tarball and continue with the git tag and gallery checks below.

npm requires account 2FA or a granular token with bypass enabled for package publishing; this project documents
the interactive 2FA route only. See [npm's publishing 2FA rules](https://docs.npmjs.com/requiring-2fa-for-package-publishing-and-settings-modification/)
and [2FA CLI flow](https://docs.npmjs.com/accessing-npm-using-2fa/). Do not rerun the automated publish after a
manual publish of the same version.

## Steps

```bash
# 1. Everything the tarball ships must be committed — publish the repo, not the working tree.
git status --short                     # expect no surprises
npm run typecheck && npm test          # full suite; also runs via prepublishOnly

# 2. Choose a version that is not already published. Bump it only for a new release; if the intended version
#    is already committed but unpublished, keep it and use the interactive path below when no version-change
#    workflow will run. npm version updates package.json and package-lock.json when present.
npm view "pi-dream-rsi@<version>" version
#   For a new version only: npm version patch --no-git-tag-version
#   ...edit README if install instructions changed...

# 3. Commit the changes and push through a PR to main. A package version change triggers publishing;
#    changes to code/docs without a version bump do not.
git add -A
git commit -m "release v$(node -p "require('./package.json').version")"
git push -u origin HEAD
#   ...open and merge the PR into main...

# 4. If the package version changed, wait for the publish workflow's final result. If no workflow ran because
#    the version was unchanged, or it failed before publishing, use the interactive 2FA path above only after
#    checking the exact version is unpublished. Verify the published version and tarball:
npm view "pi-dream-rsi@$(node -p "require('./package.json').version")" version dist.tarball

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
- Keep automated `npm publish` permission limited to the `publish.yml` trusted publisher. Publishing a second
  tarball for the same version is rejected by npm.
- README, four skills, command help/completions and tool descriptions must agree on all seven tools, assessment
  and campaign lifecycle, dashboard root selection, mode gating, campaign limits and interrupted live-tree
  recovery. Historical plans are labelled as such.
- Linux and Windows CI must pass on the commit being released; recovery tests exercise process cleanup and
  durable checkpoints. On a scratch task, check `/dream-rsi help`, headless status and `Ctrl+Shift+D` while
  work runs. Interrupt and explicitly resume a live tree; confirm completed attempts are kept, original
  settings stay fixed, and only the completed world enters dream replay.
- `npm pack --dry-run` must include `dashboard.ts`, agent output decoding, progress/checkpoint/ownership and
  campaign modules, prompts and all four skills. Terminal UI APIs come from the pi host; there are no package
  runtime deps.

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
