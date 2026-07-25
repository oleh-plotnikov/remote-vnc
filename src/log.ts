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

export function disposeLogger(): void {
  channel?.dispose();
  channel = undefined;
}
