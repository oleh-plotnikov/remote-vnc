/**
 * Where Chrome lives, per platform. Chromium and Edge are accepted too: the
 * DevTools protocol is the same, and a user who has only Chromium should not
 * be told to install Chrome.
 *
 * Bare names (no slash) are PATH lookups, resolved by the caller's `exists`.
 */
export function chromeCandidates(platform: NodeJS.Platform): string[] {
  if (platform === 'darwin') {
    return [
      '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome',
      '/Applications/Chromium.app/Contents/MacOS/Chromium',
      '/Applications/Microsoft Edge.app/Contents/MacOS/Microsoft Edge',
    ];
  }
  if (platform === 'win32') {
    return [
      'C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe',
      'C:\\Program Files (x86)\\Google\\Chrome\\Application\\chrome.exe',
      'C:\\Program Files (x86)\\Microsoft\\Edge\\Application\\msedge.exe',
    ];
  }
  return ['google-chrome', 'google-chrome-stable', 'chromium', 'chromium-browser', 'microsoft-edge'];
}

/** The first candidate that exists, or undefined when none do. */
export function pickChrome(
  candidates: string[],
  exists: (path: string) => boolean
): string | undefined {
  return candidates.find(exists);
}
