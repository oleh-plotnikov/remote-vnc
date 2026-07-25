// Discover and run every test/*.test.mjs. Each test file default-exports an
// async function receiving an { ok, eq } assertion API and returns nothing;
// it throws on failure.
import { readdirSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

const here = dirname(fileURLToPath(import.meta.url));
let pass = 0, fail = 0;
const ok = (cond, msg) => { if (cond) { pass++; } else { fail++; console.log(`  ✗ ${msg}`); } };
const eq = (a, b, msg) => ok(JSON.stringify(a) === JSON.stringify(b), `${msg} (got ${JSON.stringify(a)}, want ${JSON.stringify(b)})`);

const files = readdirSync(here).filter((f) => f.endsWith('.test.mjs')).sort();
for (const f of files) {
  console.log(f);
  const mod = await import(pathToFileURL(join(here, f)).href);
  await mod.default({ ok, eq });
}
console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
