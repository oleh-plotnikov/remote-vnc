/**
 * Quick commands: named shell commands attached to a session — "Reboot" being
 * the case that motivated them — run in an integrated terminal against the
 * session's host.
 *
 * Pure (no vscode runtime dependency) so the parsing, layering and expansion
 * rules can be unit-tested in plain Node; the tree and the terminal live in
 * sessionsView.ts and extension.ts.
 */

export interface QuickCommand {
  /** Label shown in the Active Sessions tree. */
  name: string;
  /** Shell command line. `${host}` and `${port}` are replaced at run time. */
  command: string;
  /** Ask before running (default true). */
  confirm?: boolean;
}

/** Where a resolved command is defined — and therefore where an edit writes. */
export type QuickCommandSource = 'connection' | 'global';

export interface ResolvedQuickCommand extends QuickCommand {
  source: QuickCommandSource;
}

/**
 * Keep only well-formed entries; settings.json is hand-editable. A repeated
 * name keeps its first entry: the name identifies a command for edit and
 * delete, and it is part of the tree item id, which VS Code requires unique.
 */
export function sanitizeQuickCommands(list: unknown): QuickCommand[] {
  if (!Array.isArray(list)) {
    return [];
  }
  const out: QuickCommand[] = [];
  const seen = new Set<string>();
  for (const item of list) {
    if (
      item &&
      typeof item === 'object' &&
      typeof (item as QuickCommand).name === 'string' &&
      (item as QuickCommand).name.trim() &&
      typeof (item as QuickCommand).command === 'string' &&
      (item as QuickCommand).command.trim() &&
      !seen.has((item as QuickCommand).name)
    ) {
      const { name, command, confirm } = item as QuickCommand;
      seen.add(name);
      out.push(typeof confirm === 'boolean' ? { name, command, confirm } : { name, command });
    }
  }
  return out;
}

/**
 * The commands a session offers: its saved connection's own first, then the
 * global ones. A connection command shadows a global one of the same name, so
 * one device can override the shared "Reboot" without renaming it.
 */
export function resolveQuickCommands(
  connectionCommands: unknown,
  globalCommands: unknown
): ResolvedQuickCommand[] {
  const own = sanitizeQuickCommands(connectionCommands).map(
    (c): ResolvedQuickCommand => ({ ...c, source: 'connection' })
  );
  const taken = new Set(own.map((c) => c.name));
  const shared = sanitizeQuickCommands(globalCommands)
    .filter((c) => !taken.has(c.name))
    .map((c): ResolvedQuickCommand => ({ ...c, source: 'global' }));
  return [...own, ...shared];
}

/**
 * A host safe to splice into a shell command line: names, IPv4, bracketed or
 * bare IPv6 with an optional zone. Anything else — a space, `;`, `$`, a quote —
 * is refused rather than quoted, because quoting rules differ between the
 * shells a terminal may be running.
 */
export function isShellSafeHost(host: string): boolean {
  return /^[A-Za-z0-9._:%\-[\]]+$/.test(host);
}

export type ExpandResult = { ok: true; command: string } | { ok: false; error: string };

/**
 * Substitute `${host}` and `${port}`. Every other `${…}` is left for the shell,
 * so `${HOME}` and friends keep working. The connection name is deliberately
 * not a variable: it is free text and routinely contains spaces.
 */
export function expandQuickCommand(
  template: string,
  target: { host: string; port: number }
): ExpandResult {
  const usesHost = template.includes('${host}');
  if (usesHost && !isShellSafeHost(target.host)) {
    return {
      ok: false,
      error: `the host "${target.host}" contains characters that are unsafe in a shell command`,
    };
  }
  const command = template
    .split('${host}')
    .join(target.host)
    .split('${port}')
    .join(String(target.port));
  return { ok: true, command };
}

/**
 * The saved connection a session was opened from. A session carries only its
 * label and target, so match on both and fall back to the target alone — an
 * ad-hoc session to a saved device's address still gets that device's
 * commands, which is what the user would expect of the same machine.
 */
export function findConnectionFor<T extends { name: string; host: string; port?: number }>(
  session: { label: string; host: string; port: number },
  connections: T[],
  defaultPort: number
): T | undefined {
  const sameTarget = connections.filter(
    (c) => c.host === session.host && (c.port ?? defaultPort) === session.port
  );
  return sameTarget.find((c) => c.name === session.label) ?? sameTarget[0];
}

/** Default for a new command's command line. */
export const QUICK_COMMAND_TEMPLATE = 'ssh root@${host} ';
