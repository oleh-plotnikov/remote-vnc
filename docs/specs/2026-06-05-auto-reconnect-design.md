# Remote VNC — Auto-Reconnect Design

**Date:** 2026-06-05
**Status:** Approved (brainstorming) — pending implementation plan

## Goal

Let a saved connection automatically re-establish itself after an unexpected
drop (server restart, network blip, container recycle). Opt-in **per
connection**. While reconnecting, show an **animated status icon**.

## Approach

Reconnect is driven **host-side** inside `VncSession` (the bridge is single-use
and torn down on close, so the webview/noVNC cannot revive itself). Rejected
alternatives: webview-side reconnect (dead WS URL), manager-orchestrated
reconnect (`connect()` opens a new panel → duplicates).

Each reconnect attempt **re-renders the webview HTML** with a fresh `clientUrl`.
This is required because the panel's CSP `connect-src` is locked to the *first*
bridge's origin; a new bridge has a different ephemeral port (and, behind a
remote tunnel, possibly a different forwarded authority), so reusing the
existing document would be blocked by CSP. Re-rendering yields a fresh CSP that
matches the new attempt's URL and naturally re-initialises noVNC (the existing
`ready` → `connect` handshake replays).

## Strategy

- **Infinite** attempts, **fixed 10 s** interval (no backoff, no cap).
- Stops only on: user **Disconnect** / panel close, or an **auth/security
  failure** (a retry cannot fix bad credentials).
- A successful reconnect resets state to `connected`.

## Reconnect trigger (precise)

The trigger is **`bridge.onClosed` firing** in a live session. This is exact:
`VncSession.dispose()` calls `bridge.dispose()` → `finalize()`, which does **not**
call `notifyClosed`, so `onClosed` never fires for a user-initiated teardown.
Therefore *`onClosed` firing ⟺ the connection dropped on its own* (server/
network), which is precisely when we want to reconnect.

Reconnect proceeds when: `onClosed` fired AND `!disposed` AND `autoReconnect`
AND `!authFailed`. `authFailed` is set when the webview posts `securityfailure`
(covers `credentialsrequired` too), and also cancels any pending timer.

## Components

### `src/reconnectPolicy.ts` (new) — pure, testable
```
class ReconnectPolicy {
  constructor(intervalMs: number)
  // decide what to do when the bridge closes
  onBridgeClosed(ctx: { autoReconnect; disposed; authFailed }): { action: 'reconnect' | 'stop'; delayMs }
  onConnected(): void   // reset
}
```
No vscode/Node dependency → unit-tested with the existing `test/bundle.mjs`
harness. (The infinite/10 s policy is trivial but isolating the decision keeps
`VncSession` honest and tested.)

### `src/connections.ts` — `autoReconnect`
- `SavedConnection` gains `autoReconnect?: boolean` (carried through
  `ConnectionEntry`). `collectConnections` passes it through unchanged.

### `src/vncPanel.ts` — reconnect engine
- A **connector** closure `() => Promise<{ bridge, clientUrl }>` (built by the
  manager, capturing `host/port/listenPort` + `toWebviewWsUrl`) is handed to
  `VncSession`. The manager still performs the **initial** establish (fail-fast
  error + EADDRINUSE hint unchanged); the session uses the connector for every
  reconnect.
- `ConnectionRequest` gains `autoReconnect?: boolean`.
- `VncSession` gains: `reconnecting` state, a `ReconnectPolicy`, a 10 s timer,
  `authFailed`/`disposed` guards, and the connector. On `onClosed`: ask the
  policy; if `reconnect`, set status `reconnecting`, post `reconnecting` to the
  webview, after the delay call the connector, swap in the new bridge (dispose
  old, rewire `onClosed`), set `pendingConnect`, and **re-render** the HTML with
  the new `clientUrl`. On webview `connected`: status `connected`, reset policy.
  `dispose()` clears the timer and disposes the current bridge.
- The "closed unexpectedly" toast is **suppressed while auto-reconnect is
  active**; a single info-level toast is shown only when reconnection ultimately
  stops for a non-user reason (auth failure).

### `src/sessionRegistry.ts` + `SessionInfo` — per-session status
- `SessionInfo` gains `status: 'connected' | 'reconnecting'`.
- `SessionRegistry`: `add(id, label)` defaults to `connected`;
  `setStatus(id, status)` updates and notifies; `list()` returns status.
- `VncSessionManager` exposes `setSessionStatus(id, status)` used by `VncSession`.

### `src/sessionsView.ts` — animated icon
- `SessionTreeItem` renders by status: `connected` → `ThemeIcon('circle-filled',
  charts.green)`; `reconnecting` → `ThemeIcon('sync~spin', charts.yellow)` with
  tooltip "Reconnecting…". (`~spin` animates the codicon.)

### `media/webview.ts` + `media/style.css` — panel spinner
- New extension→webview message `{ type: 'reconnecting' }`. The webview shows a
  CSS spinner + "Reconnecting…" in the status bar. The existing `connect`
  message (after re-render) returns it to "Connecting…" → "Connected".

### `package.json`
- `remoteVnc.connections` items schema gains `autoReconnect` (boolean, default
  false, description).

### `src/extension.ts`
- `addConnection` / `editConnection`: after the address step, a Yes/No quick
  pick "Reconnect automatically if the connection drops?" (prefilled on edit).
- `ConnectionRequest` built in `connectEntry` carries `autoReconnect` from the
  entry. **Ad-hoc** connects (`connectAdHoc`) do not auto-reconnect (not saved).

## Data flow
```
SavedConnection.autoReconnect ─▶ ConnectionEntry ─▶ connectEntry ─▶ ConnectionRequest.autoReconnect
                                                                         │
                                                          VncSessionManager.connect
                                                                         │ builds connector, initial establish
                                                                         ▼
   bridge.onClosed (≡ non-user drop) ─▶ ReconnectPolicy ─▶ status:reconnecting ─▶ tree sync~spin + webview spinner
                                                                         │ wait 10s, connector() → re-render
                                                                         ▼
                                              webview 'connected' ─▶ status:connected ─▶ tree green
```

## Edge cases / decisions
- **CSP:** fresh per attempt via re-render (see Approach) — keeps the tight
  per-origin `connect-src`.
- **Reuse vs duplicate:** the session keeps the same `id`/panel across
  reconnects; `findByTarget` still dedupes manual reconnect-to-same-target.
- **Auth failure:** `securityfailure`/`credentialsrequired` → stop, no loop.
- **Connector failure during reconnect** (e.g., bridge bind fails): logged, and
  the next attempt is scheduled in 10 s (still infinite).
- **Fixed `bridgePort`:** reconnect reuses the same `listenPort`; only one
  session can hold it, which is already the documented constraint.

## Testing
- Unit (`test/reconnectPolicy.test.mjs`): `onBridgeClosed` returns `reconnect`
  only when `autoReconnect && !disposed && !authFailed`, else `stop`; delay is
  10 000 ms; `onConnected` resets.
- Manual: a saved connection with auto-reconnect on → kill the server → tree
  icon spins + panel shows "Reconnecting…" → restart server → auto-reconnects;
  Disconnect stops it; a connection with the flag off does nothing.

## Out of scope (YAGNI)
Backoff, attempt cap, global setting, desktop notifications/sound, reconnect for
ad-hoc (unsaved) connections.
