import { load } from './bundle.mjs';

export default async function ({ ok, eq }) {
  const { chromeCandidates, pickChrome } = await load('chromeLocator.ts');

  const mac = chromeCandidates('darwin');
  ok(mac[0].includes('Google Chrome.app'), 'macOS probes Chrome.app first');
  ok(mac.some((p) => p.includes('Chromium')), 'macOS also probes Chromium');

  const win = chromeCandidates('win32');
  ok(win.some((p) => p.includes('Program Files')), 'windows probes Program Files');

  const linux = chromeCandidates('linux');
  ok(linux.includes('google-chrome'), 'linux probes a bare PATH name');

  // pickChrome returns the FIRST candidate that exists
  const present = new Set(['/b', '/c']);
  eq(pickChrome(['/a', '/b', '/c'], (p) => present.has(p)), '/b', 'first existing wins');
  eq(pickChrome(['/a'], () => false), undefined, 'none found → undefined');
  eq(pickChrome([], () => true), undefined, 'empty list → undefined');
}
