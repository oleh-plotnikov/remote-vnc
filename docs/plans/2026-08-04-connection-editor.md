# Connection Editor Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use
> superpowers:subagent-driven-development (recommended) or
> superpowers:executing-plans to implement this plan task-by-task. Steps use
> checkbox (`- [ ]`) syntax for tracking.

**Goal:** Make every saved-connection field reachable from the UI — including
`visibleArea` and `parkServerCursor` — and stop the wizards from deleting the
fields they do not ask about.

**Architecture:** All writes funnel through one pure merge function
(`applyConnectionEdit`) so a field absent from a wizard survives the write.
`editConnection` becomes a QuickPick property menu that saves after each
change; `addConnection` stays a linear chain and gains the two missing steps.
Field prompts are small standalone functions shared by both commands.

**Tech Stack:** TypeScript, VS Code extension API (`window.showQuickPick`,
`window.showInputBox`), esbuild bundle, hand-rolled Node test runner
(`test/run.mjs`) with a stubbed `vscode` module.

## Global Constraints

- The repository stays free of vendor, product, and assistant identifiers —
  in code, comments, documentation, and commit messages. No `Co-Authored-By`
  trailers.
- Commit messages wrap at 80 columns, subject and body alike.
- Comments and documentation are English, and explain *why* rather than
  restate the code. Match the density of the surrounding file.
- Tests exercise pure functions only. Anything reachable from a test must not
  need real VS Code API behaviour; the harness stubs the module
  (`ConfigurationTarget.Global === 1`, `Workspace === 2`).
- Verification for every task: `npm run typecheck` and `npm test` both clean.
  The suite currently reports `116 passed, 0 failed`; that number only grows.
- Spec: `docs/specs/2026-08-04-connection-editor-design.md`.

---

## File Structure

| File | Responsibility | Change |
|---|---|---|
| `src/connections.ts` | Pure connection data: parsing, merging, scoping | Add `applyConnectionEdit` |
| `test/connections.test.mjs` | Tests for the above | Add merge cases |
| `src/extension.ts` | Commands and their dialogs | Rewrite `editConnection`, extend `addConnection`, add three prompt helpers and one reader |
| `package.json` | Settings schema | Unchanged — `visibleArea` is already declared |
| `README.md`, `CHANGELOG.md` | User-facing docs | Describe the editor |

`src/extension.ts` is already ~29 KB. This plan adds roughly 120 lines to it.
Splitting it is out of scope here — the connection dialogs are not the only
thing in it, and a split would have to move sessions, pages, and screenshots
too. Task 3 keeps the new code in one contiguous region beside the dialogs it
belongs with, so a later split has an obvious seam.

---

### Task 1: The merge function

**Files:**
- Modify: `src/connections.ts` (append after `effectiveAutoReconnect`)
- Test: `test/connections.test.mjs`

**Interfaces:**
- Consumes: `SavedConnection`, `ConnectionEntry` (already defined at the top
  of `src/connections.ts`).
- Produces: `applyConnectionEdit` with overloaded signatures (see Step 3)

- [ ] **Step 1: Write the failing tests**

Append inside the exported function in `test/connections.test.mjs`, before the
closing brace. Also add `applyConnectionEdit` to the destructured import on
line 4.

```js
  // applyConnectionEdit: a wizard patch must not delete fields the wizard
  // never asked about. Editing a connection used to rewrite the record from a
  // literal, which silently dropped visibleArea and parkServerCursor.
  const saved = {
    name: 'hmi',
    host: '10.0.0.5',
    port: 5900,
    visibleArea: '480x272',
    parkServerCursor: true,
    scope: G,
  };
  const renamed = applyConnectionEdit(saved, { name: 'panel', host: '10.0.0.6' });
  eq(renamed.visibleArea, '480x272', 'untouched visibleArea survives an edit');
  eq(renamed.parkServerCursor, true, 'untouched parkServerCursor survives an edit');
  eq(renamed.name, 'panel', 'the patch wins for fields it names');
  eq(renamed.host, '10.0.0.6', 'the patch wins for host too');
  eq(renamed.scope, undefined, 'scope never reaches the written record');

  // An explicit undefined clears — this is how "Auto" removes the crop.
  const cleared = applyConnectionEdit(saved, { visibleArea: undefined });
  eq('visibleArea' in cleared, false, 'an explicit undefined removes the key');
  eq(cleared.parkServerCursor, true, 'clearing one field leaves the others');

  // No base: creating a connection yields exactly the patch.
  const created = applyConnectionEdit(undefined, { name: 'n', host: 'h' });
  eq(created, { name: 'n', host: 'h' }, 'no base yields exactly the patch');

  // A base value that is already undefined does not appear as a key.
  const sparse = applyConnectionEdit({ name: 'n', host: 'h', port: undefined }, {});
  eq('port' in sparse, false, 'an undefined base field is not written');
```

- [ ] **Step 2: Run the tests to verify they fail**

Run: `npm test`
Expected: FAIL — the run throws `applyConnectionEdit is not a function`
before any assertion is counted.

- [ ] **Step 3: Write the implementation**

Append to `src/connections.ts`:

```ts
/**
 * Merge a wizard's patch onto a saved connection.
 *
 * A dialog only knows the fields it asks about. Rebuilding the record from a
 * literal therefore deletes every other field — which is how an edit used to
 * erase `visibleArea` and `parkServerCursor`. Merging keeps them.
 *
 * A key present in `patch` with the value `undefined` clears that field (the
 * visible-area "Auto" choice removes the key); a key absent from `patch` is
 * inherited from `base`. Keys are dropped rather than written as `undefined`
 * so settings.json does not accumulate empty properties, and `scope` — which
 * tags where an entry came from and is not part of the stored shape — never
 * reaches the record. The overloads enforce that creating a connection from
 * nothing (base=undefined) requires providing mandatory fields in the patch.
 */
export function applyConnectionEdit(
  base: ConnectionEntry | SavedConnection,
  patch: Partial<SavedConnection>
): SavedConnection;
export function applyConnectionEdit(
  base: undefined,
  patch: SavedConnection
): SavedConnection;
export function applyConnectionEdit(
  base: Partial<ConnectionEntry> | undefined,
  patch: Partial<SavedConnection>
): SavedConnection {
  const { scope: _scope, ...merged } = { ...(base ?? {}), ...patch };
  const record: Record<string, unknown> = merged;
  for (const key of Object.keys(record)) {
    if (record[key] === undefined) {
      delete record[key];
    }
  }
  return record as unknown as SavedConnection;
}
```

The overloads keep the internal cast honest: without a base, the patch must be
a complete `SavedConnection` (including `name` and `host`); with a base, those
fields are already present.


- [ ] **Step 4: Run the tests to verify they pass**

Run: `npm test`
Expected: PASS — `125 passed, 0 failed`.

Run: `npm run typecheck`
Expected: no output.

- [ ] **Step 5: Commit**

```bash
git add src/connections.ts test/connections.test.mjs
git commit -F - <<'EOF'
fix: merge connection edits instead of rewriting the record

Both wizards built the saved entry from a literal holding only the
fields they asked about, so every other field vanished on write. One
pass through Edit Connection deleted a hand-written visibleArea or
parkServerCursor.

applyConnectionEdit merges a patch onto the stored entry: an absent key
is inherited, a key set to undefined is cleared, and the scope tag never
reaches the record. The commands move onto it next.
EOF
```

---

### Task 2: Route both wizards through the merge

This task fixes the data loss with no UI change, so it can be verified on its
own before the dialogs move underneath it.

**Files:**
- Modify: `src/extension.ts:276` (the `saveConnection` call in `addConnection`)
- Modify: `src/extension.ts:328-332` (the `saveConnection` call in `editConnection`)
- Modify: `src/extension.ts` import from `./connections`

**Interfaces:**
- Consumes: `applyConnectionEdit` from Task 1.
- Produces: nothing new.

- [ ] **Step 1: Extend the import**

Find the existing `import { ... } from './connections';` near the top of
`src/extension.ts` and add `applyConnectionEdit` to the named imports.

- [ ] **Step 2: Merge in `addConnection`**

Replace the `await saveConnection(...)` line in `addConnection` (currently
line 276) with:

```ts
  await saveConnection(
    target,
    applyConnectionEdit(undefined, {
      name: name.trim(),
      host: parsed.host,
      port: parsed.port,
      autoReconnect,
      forceRawEncoding,
    })
  );
```

- [ ] **Step 3: Merge in `editConnection`**

Replace the `await saveConnection(...)` call at the end of `editConnection`
(currently lines 328-332) with:

```ts
  await saveConnection(
    entry.scope,
    applyConnectionEdit(entry, {
      name: name.trim(),
      host: parsed.host,
      port: parsed.port,
      autoReconnect,
      forceRawEncoding,
    }),
    entry.name
  );
```

- [ ] **Step 4: Verify**

Run: `npm run typecheck`
Expected: no output.

Run: `npm test`
Expected: `125 passed, 0 failed`.

- [ ] **Step 5: Commit**

```bash
git add src/extension.ts
git commit -F - <<'EOF'
fix: keep untouched fields when a connection is edited

Editing a connection now merges the wizard's answers onto the stored
entry, so visibleArea and parkServerCursor survive. Adding one merges
onto nothing, which is the same record it wrote before.
EOF
```

---

### Task 3: Edit Connection as a property menu

The three new prompts land in this task rather than one of their own:
`tsconfig.json` sets `noUnusedLocals`, so a commit that adds a function
nothing calls yet would leave `npm run typecheck` failing.

**Files:**
- Modify: `src/extension.ts` (append prompts beside `promptForceRaw`, ~line 672)
- Modify: `src/extension.ts:287-333` (replace `editConnection` entirely)
- Modify: `src/extension.ts` import from `./connections` (add `baseFor`)

**Interfaces:**
- Consumes: `applyConnectionEdit` (Task 1), `parseVisibleArea` from
  `./cropLayout` (already imported — used at line 213), and the existing
  `promptAutoReconnect`, `promptForceRaw`, `parseAddress`, `saveConnection`,
  `DEFAULT_PORT`, `effectiveAutoReconnect`, `getAutoReconnectDefault`.
- Produces:
  - `getParkServerCursorDefault(): boolean`
  - `promptParkServerCursor(current: boolean): Promise<boolean | undefined>`
  - `promptVisibleArea(current: string | undefined): Promise<{ visibleArea: string | undefined } | undefined>`
  - `readConnection(target: vscode.ConfigurationTarget, name: string): ConnectionEntry | undefined`

`promptVisibleArea` returns a one-key patch rather than a bare string because
its "Auto" answer and its cancellation are both otherwise `undefined`, and
they must not be confused: Auto clears the field, cancel changes nothing.

- [ ] **Step 1: Add the default reader**

Append after `getAutoReconnectDefault` (line 633):

```ts
/** The global `remoteVnc.parkServerCursor` default for connections without their own value. */
function getParkServerCursorDefault(): boolean {
  return vscode.workspace.getConfiguration('remoteVnc').get<boolean>('parkServerCursor', false);
}
```

- [ ] **Step 2: Add the park-cursor prompt**

Append after `promptForceRaw` (line 672):

```ts
/** Ask whether to park the server-drawn cursor when idle. Returns undefined on cancel. */
async function promptParkServerCursor(current = false): Promise<boolean | undefined> {
  const pick = await vscode.window.showQuickPick(
    [
      { label: 'No', description: 'Leave the pointer where the server draws it', value: false },
      { label: 'Yes', description: 'Move it to the bottom-right corner after a few idle seconds', value: true },
    ],
    {
      title: 'Park server cursor',
      placeHolder: current ? 'Currently: Yes' : 'Currently: No',
    }
  );
  return pick?.value;
}
```

- [ ] **Step 3: Add the visible-area prompt**

Append after `promptParkServerCursor`:

```ts
/**
 * Ask for the visible panel area. Returns a patch — `{ visibleArea: undefined }`
 * means "Auto", which clears the field — or undefined when cancelled. The two
 * must stay distinguishable: cancelling has to leave the setting alone.
 */
async function promptVisibleArea(
  current: string | undefined
): Promise<{ visibleArea: string | undefined } | undefined> {
  const pick = await vscode.window.showQuickPick(
    [
      { label: 'Auto', description: 'Show the whole framebuffer', custom: false },
      {
        label: 'Custom size…',
        description: current ? `Currently: ${current}` : 'Crop to a WIDTHxHEIGHT area',
        custom: true,
      },
    ],
    {
      title: 'Visible area',
      placeHolder: current ? `Currently: ${current}` : 'Currently: Auto',
    }
  );
  if (!pick) {
    return undefined;
  }
  if (!pick.custom) {
    return { visibleArea: undefined };
  }

  const value = await vscode.window.showInputBox({
    title: 'Visible area',
    prompt:
      'Visible panel size as WIDTHxHEIGHT. The "connected" line in the Remote VNC output reports the size the server advertises.',
    value: current ?? '',
    placeHolder: '480x272',
    ignoreFocusOut: true,
    validateInput: (v) =>
      !v.trim() || parseVisibleArea(v) ? undefined : 'Enter a size like 480x272.',
  });
  if (value === undefined) {
    return undefined;
  }
  return { visibleArea: value.trim() ? value.trim() : undefined };
}
```

- [ ] **Step 4: Add the single-scope reader**

`getSavedConnections()` layers scopes and lets a global entry shadow a
same-named workspace one, so it cannot re-read the record being edited. Append
beside `getSavedConnections` (line 678):

```ts
/**
 * Re-read one connection from one scope. The layered reader deduplicates by
 * name across scopes, so it cannot see a workspace entry shadowed by a global
 * one — the menu needs the record it is actually writing.
 */
function readConnection(
  target: vscode.ConfigurationTarget,
  name: string
): ConnectionEntry | undefined {
  const config = vscode.workspace.getConfiguration('remoteVnc');
  const found = baseFor(config.inspect<SavedConnection[]>('connections'), target).find(
    (c) => c.name === name
  );
  return found ? { ...found, scope: target } : undefined;
}
```

Add `baseFor` to the `./connections` import.

- [ ] **Step 5: Replace `editConnection`**

Replace the whole function (lines 287-333) with:

```ts
type ConnectionField =
  | 'name'
  | 'address'
  | 'autoReconnect'
  | 'forceRawEncoding'
  | 'parkServerCursor'
  | 'visibleArea'
  | 'done';

/** Describe a tri-state flag: explicit On/Off, or the global default it inherits. */
function describeFlag(value: boolean | undefined, fallback: boolean): string {
  if (value === undefined) {
    return `Default (${fallback ? 'On' : 'Off'})`;
  }
  return value ? 'On' : 'Off';
}

/**
 * Edit a saved connection through a menu of its properties.
 *
 * Each choice writes immediately instead of collecting answers for a final
 * confirmation: Esc then means "I am done" rather than "discard everything",
 * and a rename — which removes the previous record — does not depend on the
 * user reaching the end. The entry is re-read after every write so the values
 * on screen stay true.
 *
 * Inherited flags show the effective value marked as inherited. Showing the
 * raw absent value would invite the user to confirm it, writing an explicit
 * false that silences a global default they may later change.
 */
async function editConnection(entry: ConnectionEntry): Promise<void> {
  let current: ConnectionEntry = entry;
  for (;;) {
    const items: Array<vscode.QuickPickItem & { id?: ConnectionField }> = [
      { id: 'name', label: '$(edit) Name', description: current.name },
      {
        id: 'address',
        label: '$(server) Address',
        description: `${current.host}:${current.port ?? DEFAULT_PORT}`,
      },
      {
        id: 'autoReconnect',
        label: '$(sync) Auto-reconnect',
        description: describeFlag(current.autoReconnect, getAutoReconnectDefault()),
      },
      {
        id: 'forceRawEncoding',
        label: '$(zap) Force raw encoding',
        description: current.forceRawEncoding ? 'On' : 'Off',
      },
      {
        id: 'parkServerCursor',
        label: '$(target) Park server cursor',
        description: describeFlag(current.parkServerCursor, getParkServerCursorDefault()),
      },
      {
        id: 'visibleArea',
        label: '$(screen-full) Visible area',
        description: current.visibleArea ?? 'Auto',
      },
      { label: '', kind: vscode.QuickPickItemKind.Separator },
      { id: 'done', label: '$(check) Done' },
    ];

    const pick = await vscode.window.showQuickPick(items, {
      title: `Edit Connection — ${current.name}`,
      placeHolder: 'Pick a property to change',
    });
    if (!pick?.id || pick.id === 'done') {
      return;
    }

    const patch = await promptConnectionField(pick.id, current);
    if (!patch) {
      continue;
    }

    const previousName = current.name;
    await saveConnection(
      current.scope,
      applyConnectionEdit(current, patch),
      previousName
    );

    // Settings writes are asynchronous; re-reading is what keeps the menu
    // honest after a rename or a cleared field.
    const reread = readConnection(current.scope, patch.name ?? previousName);
    if (!reread) {
      return;
    }
    current = reread;
  }
}

/** Prompt for one field. Returns the patch to apply, or undefined if cancelled. */
async function promptConnectionField(
  field: Exclude<ConnectionField, 'done'>,
  current: ConnectionEntry
): Promise<Partial<SavedConnection> | undefined> {
  switch (field) {
    case 'name': {
      const name = await vscode.window.showInputBox({
        title: 'Name',
        prompt: 'Display name for this connection',
        value: current.name,
        ignoreFocusOut: true,
        validateInput: (v) => (v.trim() ? undefined : 'A name is required.'),
      });
      return name ? { name: name.trim() } : undefined;
    }
    case 'address': {
      const address = await vscode.window.showInputBox({
        title: 'Address',
        prompt: 'Server address: host, host:port, or host:display',
        value: `${current.host}:${current.port ?? DEFAULT_PORT}`,
        ignoreFocusOut: true,
        validateInput: (v) =>
          parseAddress(v) ? undefined : 'Enter a valid host (and optional port).',
      });
      const parsed = address ? parseAddress(address) : undefined;
      return parsed ? { host: parsed.host, port: parsed.port } : undefined;
    }
    case 'autoReconnect': {
      const value = await promptAutoReconnect(
        effectiveAutoReconnect(current.autoReconnect, getAutoReconnectDefault())
      );
      return value === undefined ? undefined : { autoReconnect: value };
    }
    case 'forceRawEncoding': {
      const value = await promptForceRaw(current.forceRawEncoding ?? false);
      return value === undefined ? undefined : { forceRawEncoding: value };
    }
    case 'parkServerCursor': {
      const value = await promptParkServerCursor(
        current.parkServerCursor ?? getParkServerCursorDefault()
      );
      return value === undefined ? undefined : { parkServerCursor: value };
    }
    case 'visibleArea':
      return promptVisibleArea(current.visibleArea);
  }
}
```

- [ ] **Step 6: Verify it compiles and the suite still passes**

Run: `npm run typecheck`
Expected: no output.

Run: `npm test`
Expected: `125 passed, 0 failed`.

- [ ] **Step 7: Verify by hand**

The menu is VS Code API surface and has no unit test, so exercise it once:

```bash
npm run build
npx --yes @vscode/vsce package --no-dependencies --out /tmp/connection-editor.vsix
code --profile "Barto profile" --install-extension /tmp/connection-editor.vsix --force
```

Reload the window, then in the Remote VNC sidebar run **Edit Connection…** on
a saved entry and confirm:
- every property shows its current value in the menu
- setting Visible area → Custom size… → `480x272` writes
  `"visibleArea": "480x272"` into the right `settings.json`
- reopening the menu shows `480x272`, and choosing Auto removes the key
- renaming keeps `visibleArea` and does not leave a duplicate old entry
- Esc closes the menu without reverting what was already saved

- [ ] **Step 8: Commit**

```bash
git add src/extension.ts
git commit -F - <<'EOF'
feat: edit a connection through a menu of its properties

Editing walked a fixed chain of dialogs, so changing one field meant
answering all of them, two settings had nowhere to appear, and the step
counter claimed 1/2 while asking four questions.

The menu lists every property with its current value and writes after
each change. Writing immediately makes Esc mean "done" rather than
"discard", and a rename no longer depends on reaching a final step.
Inherited flags read as Default (Off) so confirming one does not write
an explicit false over a global default.
EOF
```

---

### Task 4: Add Connection asks for everything

**Files:**
- Modify: `src/extension.ts:217-285` (the body of `addConnection`)

**Interfaces:**
- Consumes: everything from Tasks 1 and 3 (the prompts and the merge).
- Produces: nothing new.

- [ ] **Step 1: Replace the step titles and add the two steps**

The scope step only exists when a folder is open, so a hard-coded denominator
would be wrong in a window without one. Rewrite `addConnection` as:

```ts
async function addConnection(): Promise<void> {
  // The scope question only appears when a folder is open, so the step count
  // is derived rather than written down — a fixed denominator would be a lie
  // in a window with no folder.
  const hasFolder = Boolean(vscode.workspace.workspaceFolders);
  const total = hasFolder ? 7 : 6;
  let step = 0;
  const title = () => `Add Saved Connection (${++step}/${total})`;

  const name = await vscode.window.showInputBox({
    title: title(),
    prompt: 'Display name for this connection',
    ignoreFocusOut: true,
    validateInput: (v) => (v.trim() ? undefined : 'A name is required.'),
  });
  if (!name) {
    return;
  }

  const address = await vscode.window.showInputBox({
    title: title(),
    prompt: 'Server address: host, host:port, or host:display',
    placeHolder: 'hostname[:port]',
    ignoreFocusOut: true,
    validateInput: (v) => (parseAddress(v) ? undefined : 'Enter a valid host (and optional port).'),
  });
  if (!address) {
    return;
  }
  const parsed = parseAddress(address);
  if (!parsed) {
    return;
  }

  // Default to global; only offer workspace scope when a folder is open, and
  // make the "may be committed" implication explicit.
  let target = vscode.ConfigurationTarget.Global;
  if (hasFolder) {
    const scope = await vscode.window.showQuickPick(
      [
        {
          label: 'User (global)',
          description: 'Available in every window',
          target: vscode.ConfigurationTarget.Global,
        },
        {
          label: 'Workspace',
          description: 'Stored in .vscode/settings.json — may be committed to source control',
          target: vscode.ConfigurationTarget.Workspace,
        },
      ],
      { title: title(), placeHolder: 'Where should this connection be saved?' }
    );
    if (!scope) {
      return;
    }
    target = scope.target;
  }

  const autoReconnect = await promptAutoReconnect(getAutoReconnectDefault());
  if (autoReconnect === undefined) {
    return;
  }
  const forceRawEncoding = await promptForceRaw();
  if (forceRawEncoding === undefined) {
    return;
  }
  const parkServerCursor = await promptParkServerCursor(getParkServerCursorDefault());
  if (parkServerCursor === undefined) {
    return;
  }
  const area = await promptVisibleArea(undefined);
  if (!area) {
    return;
  }

  await saveConnection(
    target,
    applyConnectionEdit(undefined, {
      name: name.trim(),
      host: parsed.host,
      port: parsed.port,
      autoReconnect,
      forceRawEncoding,
      parkServerCursor,
      visibleArea: area.visibleArea,
    })
  );

  const choice = await vscode.window.showInformationMessage(
    `Remote VNC: saved "${name.trim()}".`,
    'Connect Now'
  );
  if (choice) {
    await vscode.commands.executeCommand('remoteVnc.connectSaved');
  }
}
```

Note the remaining four prompts keep their own titles (`Auto-reconnect`,
`Force raw encoding`, `Park server cursor`, `Visible area`) because they are
shared with the edit menu, where a step number would be meaningless. The
counter still advances for them via `total`, which is why `title()` is called
only for the first three.

- [ ] **Step 2: Verify**

Run: `npm run typecheck`
Expected: no output.

Run: `npm test`
Expected: `125 passed, 0 failed`.

- [ ] **Step 3: Verify by hand**

Rebuild and reinstall as in Task 4, Step 4. Run **Remote VNC: Add Saved
Connection…** and confirm the chain asks all seven questions with a folder
open, that cancelling any step aborts without writing, and that a connection
created with `480x272` carries the key.

- [ ] **Step 4: Commit**

```bash
git add src/extension.ts
git commit -F - <<'EOF'
feat: ask for every field when adding a connection

Creating a connection skipped park cursor and visible area, so a new
entry could only get them by hand-editing settings.json. The step
counter is derived because the scope question is absent in a window
with no folder open.
EOF
```

---

### Task 5: Documentation

**Files:**
- Modify: `README.md`
- Modify: `CHANGELOG.md`

- [ ] **Step 1: Update the README feature list**

`remoteVnc.editConnection` is hidden from the Command Palette
(`contributes.menus.commandPalette` sets `"when": "false"`), so it does not
belong in the Usage command table — it is reached from the pencil icon on a
saved-connection row. Amend the existing Features bullet at `README.md:36-37`:

```markdown
- 💾 **Saved connections** stored in settings, with passwords kept in VS Code's
  encrypted **Secret Storage**. The pencil on a connection row opens a menu of
  every property — address, auto-reconnect, raw encoding, cursor parking,
  visible area — and each change is saved as you make it.
```

- [ ] **Step 2: Update the CHANGELOG**

The file follows Keep a Changelog and already has a `## [Unreleased]` section
with an `### Added` list (the screenshot, `parkServerCursor` and `visibleArea`
entries). Append to that `### Added` list:

```markdown
- **Connection property menu.** Editing a saved connection now lists every
  property with its current value instead of walking a fixed chain of
  dialogs, so a single field can be changed on its own. Adding a connection
  asks for `parkServerCursor` and `visibleArea` too — both previously had to
  be written into `settings.json` by hand.
```

Then add a `### Fixed` section after the `### Added` list (create it if the
Unreleased section has none):

```markdown
### Fixed

- **Editing a connection no longer deletes fields the dialogs never asked
  about.** Both wizards rebuilt the saved entry from the answers they
  collected, so one pass through **Edit Connection…** discarded a
  hand-written `visibleArea` or `parkServerCursor`.
```

- [ ] **Step 3: Verify**

Run: `npm test`
Expected: `125 passed, 0 failed`.

- [ ] **Step 4: Commit**

```bash
git add README.md CHANGELOG.md
git commit -F - <<'EOF'
docs: describe the connection property menu

Records that editing lists every property and saves per change, that
adding now asks for park cursor and visible area, and that an edit no
longer deletes fields its dialogs never mentioned.
EOF
```

---

## Verification of the whole change

- [ ] `npm run typecheck` — clean
- [ ] `npm test` — `125 passed, 0 failed`
- [ ] A connection with a hand-written `visibleArea` survives a full pass
      through **Edit Connection…**, including a rename
- [ ] Choosing **Auto** removes the key from `settings.json` rather than
      writing `null` or an empty string
- [ ] A workspace-scoped connection whose name matches a global one is edited
      in its own scope (this is what `readConnection` exists for)
- [ ] `git log --oneline` shows five commits, none carrying an assistant
      trailer, none wrapping past 80 columns
