# Remote VNC — Connection Editor Design

**Date:** 2026-08-04
**Status:** Approved (brainstorming) — pending implementation plan

## Goal

Make every saved-connection field reachable from the UI, `visibleArea` included.
Today `visibleArea` and `parkServerCursor` exist in the settings schema but in
no dialog, so the only way to set them is to hand-edit `settings.json` — and
editing the connection afterwards silently deletes them again.

## The regression this starts from

`addConnection` and `editConnection` build the record field by field:

```ts
await saveConnection(entry.scope, {
  name, host, port, autoReconnect, forceRawEncoding
}, entry.name);
```

Any field the wizard does not ask about is absent from that literal, so the
write drops it. One pass through **Edit Connection…** erases a hand-written
`visibleArea` or `parkServerCursor`. Adding new fields to the wizard would not
prevent the next field from repeating the bug — the shape of the code is the
defect.

**Fix:** a pure merge function, the single path by which either command writes.

```ts
/** Merge a wizard's patch onto a saved entry: fields the wizard never
    asked about survive. An explicit `undefined` in the patch clears. */
export function applyConnectionEdit(
  base: SavedConnection | undefined,
  patch: Partial<SavedConnection>
): SavedConnection
```

It lives in `connections.ts` beside `collectConnections`, and is testable
without the VS Code API — like `cropLayout` and `parseVisibleArea` already are.

Clearing has to be expressible: choosing **Auto** for the visible area must
remove the key, not leave a stale one. So a key present in the patch with value
`undefined` deletes, while a key absent from the patch is inherited. This is
the one place where `'k' in patch` and `patch.k === undefined` must be told
apart, and the tests state it explicitly.

## Edit Connection — a property menu

`editConnection` becomes a loop around `showQuickPick`. Each item names a field
and carries its current value in `description`; picking one opens that field's
dialog and returns to the menu.

```
Edit Connection — hmi
─────────────────────────────────────────
$(edit) Name                 hmi
$(server) Address            10.0.0.5:5900
$(sync) Auto-reconnect       On
$(zap) Force raw encoding    Off
$(target) Park server cursor Default (Off)
$(screen-full) Visible area  Auto
─────────────────────────────────────────
$(check) Done
```

**Writes happen after each change, not at the end.** Esc then means "I am
finished" rather than "discard everything", and a rename — which
`saveConnection(scope, conn, oldName)` implements by removing the previous
record — does not depend on the user reaching a final confirmation step. The
menu re-reads the entry after every write, so the values shown stay true.

Two fields follow the global default when unset (`autoReconnect`,
`parkServerCursor`). The menu shows the *effective* value and marks it as
inherited (`Default (Off)`), for the reason `editConnection` already documents
for auto-reconnect: displaying the raw absent value invites the user to
"confirm" it and write an explicit `false`, which silences a default they may
later change globally.

The first four items reuse the existing prompts unchanged.

## Add Connection — the full chain

Creation stays linear and now asks for everything:

`name → address → scope → auto-reconnect → force raw → park cursor →
visible area`

The scope step only appears when a folder is open, so a fixed denominator
would lie in a window without one. The step number is computed from the list
of steps that will actually run.

## The Visible Area step

Shared by both commands.

```
Visible area
─────────────────────────────────────────────
▸ Auto            Show the whole framebuffer
  Custom size…    Currently: 480x272
```

- **Auto** patches `visibleArea: undefined` — the key leaves `settings.json`
  and the viewer behaves exactly as it does today.
- **Custom size…** opens an input seeded with the current value, validated by
  the existing `parseVisibleArea` (accepts `x` and `×`, rejects dimensions
  below 16 or above 16384). An empty input returns to Auto.

Auto explicitly does **not** mean "detect the padding". No heuristic scans the
framebuffer for dead columns: a panel whose own content is black along an edge
would be cropped wrongly, and the failure would be silent and hard to attribute.
Cropping stays something the user states.

Knowing what to type means knowing the advertised size, and the `connected`
line in the Remote VNC output already reports it (`framebuffer 512x272`). The
input's prompt points there. Naming the number in the dialog itself would mean
carrying the framebuffer size from the webview's `status` message through
`SessionRegistry` — which is deliberately free of session detail — into a
lookup by connection name: three files of plumbing for one line of prompt text.
The pointer is enough.

## Testing

`test/connections.test.mjs` covers `applyConnectionEdit`:

- a patch of name/host/port leaves `visibleArea` and `parkServerCursor` intact
  (the regression above, stated as a test)
- an explicit `undefined` in the patch removes the key
- a patch onto no base yields exactly the patch
- `scope` never leaks into the written record

The menu loop itself is not unit-tested — it is VS Code API surface. That is
precisely why the merge, the parse, and the geometry live outside it.

## Out of scope

- Detecting the visible area automatically.
- A webview-based connection editor. The property menu is native QuickPick.
- Touching `pages.ts` and its editor, which has the same linear shape but no
  fields hidden from its wizard.
