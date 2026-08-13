// Bundle a TypeScript module from src/ to CJS with a minimal `vscode` stub,
// so pure logic can be unit-tested in plain Node.
import { build } from 'esbuild';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { createRequire } from 'node:module';

const require = createRequire(import.meta.url);
const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');

const vscodeStub = `
  export const ConfigurationTarget = { Global: 1, Workspace: 2, WorkspaceFolder: 3 };
  export const TreeItemCollapsibleState = { None: 0, Collapsed: 1, Expanded: 2 };
  export class TreeItem { constructor(label, state) { this.label = label; this.collapsibleState = state; } }
  export class ThemeIcon { constructor(id, color) { this.id = id; this.color = color; } }
  export class ThemeColor { constructor(id) { this.id = id; } }
  export class EventEmitter { constructor(){ this._l=[]; this.event=(cb)=>{ this._l.push(cb); return { dispose(){} }; }; } fire(v){ for (const cb of this._l) cb(v); } dispose(){} }
  // getConfiguration/fs are injectable per-test via globalThis.__config and
  // globalThis.__fsWrites, the same pattern as __asExternalUri below. See
  // __dialogStub below for window.show*/showSaveDialog — throwing unless a
  // test opts in is the same "must not be called" tripwire, kept working now
  // that some tests need those calls to actually succeed.
  export const workspace = {
    // __config is the USER layer and __configWorkspace the workspace one, so a
    // test that only ever set __config keeps meaning what it always meant while
    // trust-gated reads (see src/trustedSetting.ts) can be driven separately.
    // __isTrusted defaults to true: an untrusted window is the exception, and
    // every test written before the gate existed assumed a trusted one. A
    // getter, not a value — the stub is bundled INTO the module under test, so
    // a plain property could never be reached from the test that needs to flip it.
    get isTrusted() { return globalThis.__isTrusted !== false; },
    getConfiguration: (section) => ({
      // Real precedence: folder, then workspace, then user, then the caller's
      // default. Without the first two layers a trust-gate test would pass
      // against ungated code, because the workspace value it plants would be
      // invisible to get() anyway.
      get: (key, def) =>
        globalThis.__configFolder?.[section]?.[key] ??
        globalThis.__configWorkspace?.[section]?.[key] ??
        globalThis.__config?.[section]?.[key] ??
        def,
      inspect: (key) => ({
        defaultValue: globalThis.__configDefaults?.[section]?.[key],
        globalValue: globalThis.__config?.[section]?.[key],
        workspaceValue: globalThis.__configWorkspace?.[section]?.[key],
        workspaceFolderValue: globalThis.__configFolder?.[section]?.[key],
      }),
    }),
    fs: {
      createDirectory: async () => {},
      writeFile: async (uri, bytes) => {
        globalThis.__fsWrites?.push({ path: uri.fsPath, bytes });
      },
      readDirectory: async () => [],
      delete: async () => {},
    },
  };
  // Minimal LogOutputChannel: a no-op sink so logic under test can log freely,
  // except warn() also records to globalThis.__logWarnings when a test has
  // set it up (same injectable-array pattern as __executedCommands/
  // __dialogCalls below) — some fixes on this branch (like the mirror's
  // rate-restart failure) exist ONLY to make a log line appear where none
  // did before, and that has to be observable to be tested at all.
  // info() records the same way warn() does (globalThis.__logInfos): the
  // mirror's input-pressure numbers — the depth, its peak, how many pointer
  // moves were dropped — are reported at info level, and "the next
  // investigation reads a number instead of inferring one" is only true if
  // something can read them back.
  const __noopChannel = {
    name: 'stub', logLevel: 0,
    onDidChangeLogLevel: () => ({ dispose() {} }),
    trace() {}, debug() {}, error() {},
    info(msg) { globalThis.__logInfos?.push(msg); },
    warn(msg) { globalThis.__logWarnings?.push(msg); },
    append() {}, appendLine() {}, replace() {}, clear() {}, show() {}, hide() {}, dispose() {},
  };
  // The four dialog-shaped window.* calls exist but THROW unless a test opts
  // in via globalThis.__dialogsEnabled. That preserves the exact tripwire
  // test/vncCapture.test.mjs's "Ruling 2" depends on — a registry-path call
  // that dialogs by mistake must fail loudly, and it still does, just with a
  // clearer message than the old "is not a function". A test that DOES want
  // to prove an interactive path dialogs sets __dialogsEnabled = true, reads
  // back what was called from globalThis.__dialogCalls, and answers a call
  // via globalThis.__dialogAnswers (keyed by function name) — undefined by
  // default, i.e. "the user dismissed it", which is what every one of these
  // calls means when nobody chose a button.
  function __dialogStub(name) {
    return (...args) => {
      if (!globalThis.__dialogsEnabled) {
        throw new Error(name + ' called with no dialog possible in this test (globalThis.__dialogsEnabled is not set)');
      }
      globalThis.__dialogCalls?.push({ name, args });
      return globalThis.__dialogAnswers?.[name];
    };
  }
  export const window = {
    createOutputChannel: () => __noopChannel,
    showInformationMessage: __dialogStub('showInformationMessage'),
    showWarningMessage: __dialogStub('showWarningMessage'),
    showErrorMessage: __dialogStub('showErrorMessage'),
    showSaveDialog: __dialogStub('showSaveDialog'),
  };
  // executeCommand calls are recorded rather than acted on — injectable per-test
  // via globalThis.__executedCommands, the same pattern as __config/__fsWrites.
  export const commands = {
    executeCommand: (...args) => {
      globalThis.__executedCommands?.push(args);
    },
  };
  // Minimal Uri: enough of parse/with/toString for ws<->http rewriting.
  export class Uri {
    constructor(scheme, authority, path, query) {
      this.scheme = scheme; this.authority = authority; this.path = path; this.query = query;
    }
    static parse(s) {
      const m = /^([^:]+):\\/\\/([^/?#]*)([^?#]*)(?:\\?([^#]*))?/.exec(s);
      return new Uri(m[1], m[2] || '', m[3] || '', m[4] || '');
    }
    static file(path) {
      return new Uri('file', '', path, '');
    }
    static joinPath(base, ...segments) {
      const path = [base.path.replace(/\\/+$/, ''), ...segments].join('/');
      return new Uri(base.scheme, base.authority, path, '');
    }
    get fsPath() {
      return this.path;
    }
    with(ch) {
      return new Uri(
        ch.scheme ?? this.scheme,
        ch.authority ?? this.authority,
        ch.path ?? this.path,
        ch.query ?? this.query,
      );
    }
    toString() {
      let s = this.scheme + '://' + this.authority + this.path;
      // Mirror vscode-uri: the query component is percent-encoded, so '=' in a
      // token becomes '%3D'. Code that round-trips a token through Uri.toString
      // therefore corrupts it — this keeps the regression test honest.
      if (this.query) s += '?' + this.query.replace(/=/g, '%3D');
      return s;
    }
  }
  // asExternalUri behaviour is injectable per-test via globalThis.__asExternalUri.
  export const env = {
    asExternalUri: async (u) => (globalThis.__asExternalUri ? globalThis.__asExternalUri(u) : u),
  };
  export default {};
`;

const stubPlugin = {
  name: 'stub-vscode',
  setup(b) {
    b.onResolve({ filter: /^vscode$/ }, () => ({ path: 'vscode', namespace: 'stub' }));
    b.onLoad({ filter: /.*/, namespace: 'stub' }, () => ({ contents: vscodeStub, loader: 'js' }));
  },
};

/**
 * Bundle `media/<entry>` — a webview module — and load it as CommonJS.
 *
 * No `vscode` stub: these run in a browser context and import none. What they
 * DO import is the DOM, and every one of them runs work at load time (that is
 * how a webview bundle wires its listeners up), so the caller must install the
 * globals it touches BEFORE calling this. That load-time run is exactly what
 * makes the module testable at all: the listeners it registers are the only
 * handle a test has on it.
 */
export async function loadMedia(entry) {
  const out = join(mkdtempSync(join(tmpdir(), 'rv-test-')), 'm.cjs');
  await build({
    entryPoints: [join(ROOT, 'media', entry)],
    bundle: true, format: 'cjs', platform: 'browser', target: 'es2022',
    outfile: out, logLevel: 'silent',
  });
  return require(out);
}

/** Bundle `src/<entry>` and return the loaded CommonJS module. */
export async function load(entry) {
  const out = join(mkdtempSync(join(tmpdir(), 'rv-test-')), 'm.cjs');
  await build({
    entryPoints: [join(ROOT, 'src', entry)],
    bundle: true, format: 'cjs', platform: 'node', outfile: out, logLevel: 'silent',
    plugins: [stubPlugin],
  });
  return require(out);
}
