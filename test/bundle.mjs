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
  export const workspace = {};
  // Minimal LogOutputChannel: no-op sink so logic under test can log freely.
  const __noopChannel = {
    name: 'stub', logLevel: 0,
    onDidChangeLogLevel: () => ({ dispose() {} }),
    trace() {}, debug() {}, info() {}, warn() {}, error() {},
    append() {}, appendLine() {}, replace() {}, clear() {}, show() {}, hide() {}, dispose() {},
  };
  export const window = { createOutputChannel: () => __noopChannel };
  export const commands = {};
  // Minimal Uri: enough of parse/with/toString for ws<->http rewriting.
  export class Uri {
    constructor(scheme, authority, path, query) {
      this.scheme = scheme; this.authority = authority; this.path = path; this.query = query;
    }
    static parse(s) {
      const m = /^([^:]+):\\/\\/([^/?#]*)([^?#]*)(?:\\?([^#]*))?/.exec(s);
      return new Uri(m[1], m[2] || '', m[3] || '', m[4] || '');
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
