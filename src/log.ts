import * as vscode from 'vscode';

let channel: vscode.LogOutputChannel | undefined;

/**
 * A single, user-discoverable log channel ("Remote VNC" under View → Output).
 *
 * Diagnostics previously went to `console.log`, which during an Extension
 * Development Host (F5) session lands only in the launching window's Debug
 * Console — easy to miss, and invisible to an installed extension. A
 * LogOutputChannel is always visible in the Output dropdown and carries
 * levels/timestamps, so the WS-bridge↔webview tunnel can be diagnosed.
 */
export function logger(): vscode.LogOutputChannel {
  if (!channel) {
    channel = vscode.window.createOutputChannel('Remote VNC', { log: true });
  }
  return channel;
}

/**
 * A URL safe to write to that channel.
 *
 * The channel is not a private diagnostic — the repo's own bug-report template
 * asks reporters to paste it into a public issue — and the URL a page tab logs
 * is the resolved, post-`asExternalUri` one, whose query carries the port
 * forwarding tunnel's auth token (see `resolveExternal` in pagePanel.ts, which
 * merges that token in by hand).
 *
 * The query is replaced wholesale rather than matched parameter by parameter:
 * which one is the token is knowledge `resolveExternal` has and a log line does
 * not, and the scheme, authority and path are the whole diagnostic value of the
 * line anyway. A marker is left behind so a reader can tell a stripped query
 * from a URL that never had one.
 */
export function logSafeUrl(url: string): string {
  const query = url.indexOf('?');
  if (query < 0) {
    return url;
  }
  const hash = url.indexOf('#', query);
  return `${url.slice(0, query)}?<redacted>${hash >= 0 ? url.slice(hash) : ''}`;
}

export function disposeLogger(): void {
  channel?.dispose();
  channel = undefined;
}
