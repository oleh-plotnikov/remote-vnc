import * as vscode from 'vscode';
import * as crypto from 'crypto';
import { brandIconPath } from './brandIcon';
import { logger } from './log';

/**
 * Web-page tabs — a saved URL rendered full-bleed in a webview iframe, so
 * design mockups and other local dev pages open as clean editor tabs next to
 * the VNC sessions, without browser chrome.
 *
 * One panel per URL: re-opening reveals (and re-titles) the existing tab AND
 * reloads its iframe — these are live dev pages, so "open" must mean "show me
 * the current state", not a memo of whatever was loaded an hour ago.
 */
interface OpenPage {
  panel: vscode.WebviewPanel;
  external: string;
  frameOrigin: string;
  canvas?: PageCanvas;
}
const openPanels = new Map<string, OpenPage>();

export interface PageCanvas {
  width: number;
  height: number;
}

export async function openPagePanel(
  extensionUri: vscode.Uri,
  name: string,
  url: string,
  canvas?: PageCanvas
): Promise<void> {
  const existing = openPanels.get(url);
  if (existing) {
    reopen(existing, name, canvas);
    return;
  }

  let external: string;
  let frameOrigin: string;
  try {
    ({ external, frameOrigin } = await resolveExternal(url));
  } catch (err) {
    void vscode.window.showErrorMessage(`Remote VNC: cannot resolve "${url}" — ${String(err)}`);
    return;
  }

  // Re-check after the await: a double-click fires the command twice, and the
  // second call can pass the first check while the first is still inside
  // asExternalUri. From here to `set` there is no await, so the upsert is
  // atomic.
  const raced = openPanels.get(url);
  if (raced) {
    reopen(raced, name, canvas);
    return;
  }

  // No retainContextWhenHidden: the mockup pages this targets run continuous
  // animations, so a retained hidden tab burns CPU; an iframe reload on
  // re-show is cheap for localhost pages.
  const panel = vscode.window.createWebviewPanel(
    'remoteVnc.page',
    name,
    vscode.ViewColumn.Active,
    { enableScripts: true }
  );
  panel.iconPath = brandIconPath(extensionUri);
  panel.webview.html = renderPageHtml(withCacheBust(external), frameOrigin, canvas);
  const entry: OpenPage = { panel, external, frameOrigin, canvas };
  openPanels.set(url, entry);
  panel.onDidDispose(() => {
    // Guard by identity — a stale dispose must not unregister a newer panel.
    if (openPanels.get(url)?.panel === panel) {
      openPanels.delete(url);
    }
  });
  logger().info(
    `page: opened "${name}" → ${external}${canvas ? ` @${canvas.width}x${canvas.height}` : ''}`
  );
}

/**
 * Re-open of an already-open page: re-title (same URL may be saved under a
 * renamed entry), rebuild the webview HTML — recreating the iframe forces a
 * full document reload — and reveal. The canvas is taken from the saved entry
 * being opened, so editing its size takes effect without closing the tab.
 */
function reopen(entry: OpenPage, name: string, canvas?: PageCanvas): void {
  entry.canvas = canvas ?? entry.canvas;
  entry.panel.title = name;
  entry.panel.webview.html = renderPageHtml(withCacheBust(entry.external), entry.frameOrigin, entry.canvas);
  entry.panel.reveal();
  logger().info(`page: reloaded "${name}" → ${entry.external}`);
}

/**
 * A per-load cache-busting query param. The framed document would otherwise
 * be served from Chromium's heuristic cache (servers that send only
 * Last-Modified, like python http.server, get cached for 10% of the file's
 * age) — a "reload" that re-renders stale content. Inserted before the
 * fragment so #state-style hashes keep working.
 */
function withCacheBust(external: string): string {
  const hashIdx = external.indexOf('#');
  const base = hashIdx >= 0 ? external.slice(0, hashIdx) : external;
  const frag = hashIdx >= 0 ? external.slice(hashIdx) : '';
  const sep = base.includes('?') ? '&' : '?';
  return `${base}${sep}rvncReload=${Date.now()}${frag}`;
}

/**
 * Resolve a (possibly container-local) URL to one the webview client can
 * reach. Mirrors toWebviewWsUrl (vncPanel.ts): asExternalUri forwards by
 * authority and must not see the query — vscode.Uri stores components
 * percent-DECODED, so a round-tripped query would come back mangled
 * (`a%26b` → `a&b`). The original raw query/fragment is carried by hand;
 * a tunnel token appended by asExternalUri itself is merged back in.
 *
 * In a *local Dev Container*, asExternalUri does NOT auto-forward and returns
 * the loopback authority unchanged — fine when the port is statically
 * forwarded (forwardPorts / Ports panel), a dead black iframe otherwise, so
 * that case is logged.
 */
async function resolveExternal(url: string): Promise<{ external: string; frameOrigin: string }> {
  const parsed = vscode.Uri.parse(url);
  const tailIndex = url.search(/[?#]/);
  const rawTail = tailIndex >= 0 ? url.slice(tailIndex) : '';

  const ext = await vscode.env.asExternalUri(parsed.with({ query: '', fragment: '' }));
  if (vscode.env.remoteName && ext.authority === parsed.authority) {
    logger().warn(
      `page: asExternalUri left ${parsed.authority} unchanged in a remote window (${vscode.env.remoteName}). ` +
        'The iframe loads on the client — if the tab stays blank, forward the port ' +
        '(forwardPorts in devcontainer.json, or the Ports panel).'
    );
  }

  const path = ext.path && ext.path !== '/' ? ext.path : '/';
  const extQuery = ext.query; // tunnel auth token, if any (plain alphanumerics)
  let tail: string;
  if (rawTail.startsWith('?')) {
    tail = extQuery ? `?${extQuery}&${rawTail.slice(1)}` : rawTail;
  } else {
    tail = (extQuery ? `?${extQuery}` : '') + rawTail; // rawTail is '' or '#…'
  }
  return {
    external: `${ext.scheme}://${ext.authority}${path}${tail}`,
    frameOrigin: `${ext.scheme}://${ext.authority}`,
  };
}

/** Minimal attribute escaping for a URL placed in src="…". */
function escapeAttr(value: string): string {
  return value.replace(/&/g, '&amp;').replace(/"/g, '&quot;').replace(/</g, '&lt;');
}

function renderPageHtml(src: string, frameOrigin: string, canvas?: PageCanvas): string {
  const nonce = crypto.randomBytes(16).toString('base64');
  // frame-src is pinned to the resolved page origin (same idiom as
  // vncPanel's exact-origin connect-src): the framed page can navigate
  // within its own origin, but a link/redirect cannot silently take the
  // full-bleed tab — which has no URL bar — to an arbitrary external site.
  const csp = `default-src 'none'; frame-src ${frameOrigin}; style-src 'unsafe-inline'; script-src 'nonce-${nonce}';`;

  // Fixed canvas (design mockups): render the page in a width×height viewport
  // and scale it to fit the tab, centered — the same look as the VNC viewer's
  // scaleViewport, letterboxed on the editor background instead of black.
  const body = canvas
    ? `<div class="stage"><iframe class="fixed" width="${canvas.width}" height="${canvas.height}"
         src="${escapeAttr(src)}" allow="clipboard-read; clipboard-write"></iframe></div>
  <script nonce="${nonce}">
    (function () {
      const W = ${canvas.width}, H = ${canvas.height};
      const frame = document.querySelector('iframe');
      const fit = () => {
        const s = Math.min(window.innerWidth / W, window.innerHeight / H);
        frame.style.transform = 'scale(' + s + ')';
      };
      window.addEventListener('resize', fit);
      fit();
    })();
  </script>`
    : `<iframe class="fill" src="${escapeAttr(src)}" allow="clipboard-read; clipboard-write"></iframe>`;

  return `<!DOCTYPE html>
<html lang="en">
<head>
  <meta charset="utf-8" />
  <meta http-equiv="Content-Security-Policy" content="${csp}" />
  <style>
    html, body { margin: 0; padding: 0; width: 100%; height: 100%; overflow: hidden;
                 background: var(--vscode-editor-background, #1e1e1e); }
    iframe { border: none; }
    iframe.fill { display: block; width: 100%; height: 100%; }
    .stage { width: 100%; height: 100%; display: flex; align-items: center; justify-content: center; }
    iframe.fixed { flex: none; transform-origin: center center; }
  </style>
</head>
<body>
  ${body}
</body>
</html>`;
}
