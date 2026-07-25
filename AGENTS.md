# Working on this repository

A VS Code extension that shows a remote screen over VNC in an editor tab. This
file records the things that are not visible from the code alone — the release
machinery, the conventions, and the traps that have already cost time once.

## Commands

```bash
npm install
npm run build      # bundle both outputs once
npm run watch      # rebuild on change; reload the window to pick changes up
npm run typecheck  # tsc --noEmit
npm test           # 63 tests, plain Node, no framework
npm run package    # production build (minified, no sourcemaps)
```

`F5` launches an Extension Development Host.

## Layout

| Path | What it is |
| --- | --- |
| `src/extension.ts` | Command registration and connect flows (the largest file) |
| `src/vncPanel.ts` | The VNC editor panel, reconnect logic, remote URL resolution |
| `src/vncBridge.ts` | The WebSocket-to-TCP bridge — the security-sensitive part |
| `src/pagePanel.ts` | The "Web Pages" editor tabs |
| `src/*View.ts` | Activity Bar tree views |
| `media/webview.ts` | Runs inside the panel; imports noVNC. Never touches VS Code APIs |
| `test/run.mjs` | Discovers `*.test.mjs`, calls each default export with `{ ok, eq }` |
| `test/bundle.mjs` | Builds a module from `src/` against a `vscode` stub, for unit tests |
| `esbuild.js` | Two bundles: extension host (CJS/node) and webview (ESM/browser) |

## Things that are easy to get wrong

**Attribution banners are load-bearing.** `esbuild.js` injects a `banner` into
each bundle naming the third-party code inside it. This is not decoration:
minification strips every original copyright header, and esbuild's
`legalComments` setting does **not** help, because it only preserves comments
marked `@license`/`@preserve` or opening with `/*!` — and neither noVNC nor `ws`
marks its headers that way. Verified by building with `legalComments: 'eof'` and
`'inline'`: both produced zero notices. If you add a dependency that ends up
bundled, add it to the banner and to `THIRD-PARTY-NOTICES.md`.

What actually ships inside `media/webview.js` is 52 noVNC files, which include
`vendor/pako/` (MIT) and `core/crypto/des.js` (its notice must be kept intact) —
not just noVNC's own MPL-2.0 code. To re-check after a dependency bump:

```bash
node -e "require('esbuild').build({entryPoints:['media/webview.ts'],bundle:true,
  format:'esm',platform:'browser',write:false,metafile:true}).then(r=>
  console.log(Object.keys(r.metafile.inputs).filter(k=>k.includes('node_modules'))))"
```

**`.vscodeignore` matches source by extension, not by filename.** It used to list
`media/webview.ts` by name; a sync-conflict copy called `media/webview 2.ts`
slipped past it and shipped 9 KB of TypeScript in a release candidate — carrying
stale content that undid edits already made. There is also a rule for
`**/* [0-9].*`. Always read the file list `vsce package` prints.

**This directory is under file sync, and sync conflicts have corrupted `.git`.**
Duplicates named `refs/remotes/origin/HEAD 2` once broke every `git log --all`
with `fatal: bad object`. If git starts failing on a ref that looks almost right:

```bash
find .git -name '* [0-9]' -type f -print -delete && git fsck
```

**The Marketplace cannot delete a single version.** `vsce` offers only
`unpublish` (the whole extension) and `delete-publisher`. Unpublishing frees the
`OlehPlotnikov.remote-vnc` identifier, which may not be reclaimable, and discards
install counts and ratings. Superseding a bad version by publishing a newer one
is the only sane move; users only ever see the latest.

## Releasing

```bash
npm version patch     # or minor / major — also updates package-lock
git push --follow-tags
```

Pushing a `v*` tag runs `.github/workflows/release.yml`, which type-checks,
tests, refuses to continue if the tag and `package.json` disagree on the version,
then creates the GitHub release with the `.vsix` attached and publishes to both
registries. Update `CHANGELOG.md` before tagging.

To retry a publish that was skipped or failed, without moving a tag:

```bash
gh workflow run release.yml              # newest v* tag
gh workflow run release.yml -f tag=v1.2.0
```

Both publishes pass `--skip-duplicate`, so a retry does not trip over the half
that already succeeded.

### Registries and tokens

| Registry | Secret | Where the token comes from |
| --- | --- | --- |
| VS Code Marketplace | `VSCE_PAT` | Azure DevOps, scope **Marketplace → Manage**, organization **All accessible organizations** |
| Open VSX | `OVSX_PAT` | open-vsx.org, sign in with GitHub |

Open VSX is what VSCodium, Cursor, Windsurf and Gitpod install from; Microsoft's
Marketplace is closed to them by its terms, so both matter.

Two things bite here. `VSCE_PAT` **expires within a year at most** — when it
does, releases fail with a 401 and nothing warns you beforehand. And set these
secrets through the GitHub web form: `gh secret set` without a terminal that can
prompt reads empty stdin and silently stores an empty value, which only shows up
as a publish step quietly skipping.

## Conventions

**Commit messages wrap at 80 characters**, subject and body alike. Explain *why*
in the body — the diff already shows what. Check before pushing:

```bash
git log -1 --format='%B' | awk 'length($0)>80'   # any output is a violation
```

**Keep the repository free of employer, client and internal identifiers** —
hostnames, device names, internal addresses, tooling names. It is public. The
sample connection in `.devcontainer/devcontainer.json` must stay illustrative.

**Prefer generic technical language over one industry's jargon** in anything
user-visible; setting descriptions appear both in the Settings UI and on the
Marketplace page.

## Architecture notes worth knowing before changing things

A webview cannot open raw TCP sockets, but RFB is a TCP protocol. So the
extension host runs a WebSocket server on `127.0.0.1`, guarded by a single-use
192-bit token compared with `crypto.timingSafeEqual`, serving only the first
client, and pipes bytes verbatim to a fresh TCP connection. Everything about
that design is deliberate; see `SECURITY.md` before relaxing any of it.

Under a remote (Dev Container, Remote-SSH, WSL, Codespaces) the bridge runs on
the remote while the webview renders locally, so `127.0.0.1` means two different
machines. The bridge URL therefore goes through `asExternalUri`. A **local** Dev
Container is the awkward case: ephemeral ports are not forwarded automatically,
so it needs a fixed `remoteVnc.bridgePort` plus a matching `forwardPorts` entry,
and a fixed port allows only one session at a time.

`forceRawEncoding` exists because some fixed-function embedded servers answer the
first request with a pseudo-encoding-only update for *any* advertised
pseudo-encoding, after which noVNC switches to incremental requests they never
answer — leaving a blank screen. The mode advertises only Raw and CopyRect and
polls for full updates. This is not in the RFC; it is an observed quirk.
