# Remote VNC — Sidebar Views Design

**Date:** 2026-06-04
**Status:** Approved (brainstorming) — pending implementation plan

## Goal

Give Remote VNC a presence in the VS Code sidebar. Today the extension is
command-only (Command Palette). Add a dedicated Activity Bar container with two
views: **Saved Connections** (manage + click-to-connect) and **Active
Sessions** (see/reveal/disconnect what's currently open).

## Approach

Chosen: **two `TreeView`s inside a dedicated Activity Bar container** (over a
single multi-node tree, or an Explorer-hosted view). Rationale: matches the
mental model, gives each view its own title actions and welcome content, and is
idiomatic for VS Code.

## Contributions (package.json)

- `viewsContainers.activitybar`: one container `remote-vnc` with a monochrome
  SVG icon at `resources/remote-vnc.svg` (the Activity Bar requires a 1-colour
  SVG; the existing `icon.png` stays as the Marketplace/extension icon).
- `views."remote-vnc"`: two views —
  - `remoteVnc.connectionsView` — "Saved Connections"
  - `remoteVnc.sessionsView` — "Active Sessions"
- `viewsWelcome` on `remoteVnc.connectionsView` (when empty):
  > No saved connections yet.
  > [Add Connection](command:remoteVnc.addConnection)
- `menus`:
  - `view/title` → **Add Connection** (`$(add)`) on the connections view;
    optional **Refresh** on both.
  - `view/item/context` (`group: "inline"`):
    - connection item (`contextValue: remoteVnc.connection`): **Connect**
      (`$(plug)`), **Edit** (`$(edit)`), **Delete** (`$(trash)`),
      **Forget Password** (`$(key)`).
    - session item (`contextValue: remoteVnc.session`): **Reveal**
      (`$(eye)`), **Disconnect** (`$(debug-disconnect)`).

## New commands

- `remoteVnc.editConnection` — edit name/host/port of a saved connection,
  writing back to **the same configuration scope** the entry lives in.
- `remoteVnc.deleteConnection` — remove a saved connection from its scope.
- Tree wrappers that accept a tree item argument and delegate to existing logic:
  - `remoteVnc.connectConnection(item)` → `doConnect(...)`
  - `remoteVnc.forgetConnectionPassword(item)` → existing forget flow
  - `remoteVnc.revealSession(item)` / `remoteVnc.disconnectSession(item)`

Existing commands (`connect`, `connectSaved`, `addConnection`,
`forgetPassword`, `disconnect`) remain for the Command Palette.

## Components

### `src/connectionsView.ts` — `ConnectionsTreeProvider`
- `implements vscode.TreeDataProvider<ConnectionItem>`.
- Reads saved connections **per scope** via `config.inspect(...)` so each
  `ConnectionItem` carries its `vscode.ConfigurationTarget` (global / workspace /
  workspaceFolder). This is required because Edit/Delete must target the exact
  scope, and because global now wins name collisions (see existing
  `getSavedConnections`).
- In an **untrusted** workspace, workspace/folder-scoped entries are omitted
  (same gate as `getSavedConnections`).
- Each item: label = connection name, description = `host:port`, icon
  `$(vm)`/`$(device-desktop)`, `contextValue = remoteVnc.connection`, and a
  `command` that runs `remoteVnc.connectConnection` on click.
- Refreshes (`onDidChangeTreeData`) on `workspace.onDidChangeConfiguration`
  (filter `remoteVnc.connections`) and on `onDidGrantWorkspaceTrust`.

### `src/sessionsView.ts` — `SessionsTreeProvider`
- `implements vscode.TreeDataProvider<SessionItem>`.
- Reads from `VncSessionManager`; item label = session label, icon a green
  `$(circle-filled)`, `contextValue = remoteVnc.session`, click runs
  `remoteVnc.revealSession`.
- Refreshes on `VncSessionManager.onDidChangeSessions`.

### `VncSessionManager` (existing `src/vncPanel.ts`) — extensions
- Each `VncSession` gets a stable `id` and a `label`.
- Manager exposes: `getSessions(): { id, label }[]`, `reveal(id)`,
  `disconnect(id)`, and `onDidChangeSessions: vscode.Event<void>` fired on
  connect, dispose, and disconnect.

### `extension.ts` — wiring
- Register both providers and their `TreeView`s; push to subscriptions.
- Register the new commands.
- Refactor connection persistence into shared helpers:
  `writeConnections(target, list)` and `saveConnection(target, conn, oldName?)`,
  used by `addConnection`, `editConnection`, and `deleteConnection`.
- `editConnection(item)` reuses the add input flow, pre-filled, and writes back
  to `item.scope`.

## Data flow

```
remoteVnc.connections (per scope) ─▶ ConnectionsTreeProvider ─▶ items (scope-tagged)
        ▲                                                         │ click → connect
        └── edit/delete/add write to the item's scope ◀───────────┘ inline → edit/delete/forget

VncSessionManager registry ─▶ SessionsTreeProvider ─▶ items
        ▲   onDidChangeSessions                          │ click → reveal
        └────────────────────────────────────────────────┘ inline → disconnect
```

## Edge cases / decisions

- Clicking a connection that **already has** an active session reveals that
  session instead of opening a duplicate (match by resolved `host:port`).
- Edit/Delete operate **only** in the scope where the entry is defined.
- Untrusted workspace: workspace-scoped entries are hidden (existing behavior).
- Forget Password uses the existing **host-scoped** secret key.
- Deleting a connection offers to also forget its stored password.

## Testing

- Headless unit tests (same esbuild-bundle-with-`vscode`-stub harness already
  proven for `parseAddress`):
  - `ConnectionsTreeProvider.getChildren()`: scope tagging, untrusted filter,
    empty state, global-wins-collision.
  - `VncSessionManager`: add/remove session fires `onDidChangeSessions`;
    `getSessions()` reflects state.
- Manual visual pass in the Extension Development Host: Activity Bar icon, both
  sections, click-to-connect, Edit/Delete/Forget, Reveal/Disconnect, welcome
  view when empty.

## Out of scope (YAGNI)

Drag-to-reorder, connection groups/tags, import/export, live ping/status
indicators beyond connected/not, and per-connection custom RFB options.
