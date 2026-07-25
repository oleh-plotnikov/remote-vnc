import * as vscode from 'vscode';

/**
 * The Remote VNC screen mark (same glyph as the activity-bar icon) used as the
 * editor-tab icon for every tab the extension opens — VNC sessions and web
 * pages alike — as a theme-aware light/dark pair.
 *
 * Editor-tab webview icons (engine ^1.84) are drawn as-is from the SVG's own
 * fill and are NOT recolored by the active theme (unlike a `ThemeIcon`/codicon),
 * so a single `currentColor` mark resolves to black and turns near-invisible on
 * a dark tab strip. The explicit pair fixes that: the dark glyph on light
 * themes, the white glyph on dark.
 */
export function brandIconPath(extensionUri: vscode.Uri): { light: vscode.Uri; dark: vscode.Uri } {
  return {
    light: vscode.Uri.joinPath(extensionUri, 'resources', 'remote-vnc-light.svg'),
    dark: vscode.Uri.joinPath(extensionUri, 'resources', 'remote-vnc-dark.svg'),
  };
}
