## What this changes

<!-- And why. The diff already shows what; the reason it had to change is the
     part that gets lost. -->

## How it was checked

<!-- `npm run typecheck` and `npm test` run in CI, so no need to say you ran
     them. What matters is what CI cannot check: which VNC server you tried it
     against, and whether VS Code was local or attached to a remote. -->

- [ ] Tried against a real VNC server — which one:
- [ ] VS Code was: local / Dev Container / Remote-SSH / WSL / Codespaces

## Worth a second look

<!-- Delete what does not apply. -->

- [ ] Touches `src/vncBridge.ts` — the token, the loopback bind or the
      single-client rule. See SECURITY.md.
- [ ] Changes a bundled dependency — the banner in `esbuild.js` and
      `THIRD-PARTY-NOTICES.md` both need updating, since minification strips the
      original copyright headers.
- [ ] Adds or renames a setting — it needs an entry under
      `contributes.configuration`, or it will not appear in the Settings UI.
- [ ] Changes what ships — check the file list `vsce package` prints.
