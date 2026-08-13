// What may be written to the "Remote VNC" output channel.
//
// The channel is not a private diagnostic: .github/ISSUE_TEMPLATE/bug_report.yml
// asks reporters to paste it into a public issue. And the URL pagePanel logs on
// every open and reload is the post-asExternalUri one, whose query carries the
// port-forwarding tunnel's auth token — resolveExternal merges it in by hand
// and says so in its own comment. So the one thing the log line must not carry
// is a query.
import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { load } from './bundle.mjs';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');

export default async function ({ ok, eq }) {
  const { logSafeUrl } = await load('log.ts');

  // The shape resolveExternal builds when asExternalUri tunnels: token first,
  // the saved entry's own query appended after it.
  const tunnelled = 'https://abc-8080.devtunnels.ms/app?tkn=S3CRET-TUNNEL-TOKEN&view=grid';
  const safe = logSafeUrl(tunnelled);
  ok(!safe.includes('S3CRET-TUNNEL-TOKEN'), 'the tunnel token never reaches the log');
  ok(safe.startsWith('https://abc-8080.devtunnels.ms/app'), 'origin and path survive — they are the diagnostic');

  // Not token-matched: which parameter is the token is knowledge resolveExternal
  // has and a log line does not, so the whole query goes.
  ok(!safe.includes('view=grid'), 'the rest of the query goes too rather than guessing which part is secret');

  eq(logSafeUrl('http://127.0.0.1:8080/panel'), 'http://127.0.0.1:8080/panel', 'a URL with no query is untouched');
  eq(logSafeUrl('http://h/p#anchor'), 'http://h/p#anchor', 'a bare fragment is untouched');
  eq(logSafeUrl('http://h/p?tkn=x#anchor'), 'http://h/p?<redacted>#anchor', 'the fragment survives the query being cut');
  eq(logSafeUrl('http://h/p?'), 'http://h/p?<redacted>', 'an empty query is still marked, not silently dropped');

  // And the wiring. A correct helper nobody calls fixes nothing, and
  // `openPagePanel` needs a real WebviewPanel, so — as test/pageUseClaim.test.mjs
  // says of its own subject — the shape of the call is what is reachable here.
  const src = readFileSync(join(ROOT, 'src/pagePanel.ts'), 'utf8');
  ok(
    !/→ \$\{external\}|→ \$\{entry\.external\}/.test(src),
    'no log line interpolates a resolved URL raw — that URL carries the tunnel token'
  );
  ok(
    /logSafeUrl\(external\)/.test(src),
    'the open line logs through logSafeUrl'
  );
  ok(
    /logSafeUrl\(entry\.external\)/.test(src),
    'and so does the reload line — it logs the same resolved URL'
  );
}
