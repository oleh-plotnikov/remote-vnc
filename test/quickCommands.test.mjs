import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { load } from './bundle.mjs';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');

export default async function ({ ok, eq }) {
  const {
    sanitizeQuickCommands,
    resolveQuickCommands,
    expandQuickCommand,
    isShellSafeHost,
    findConnectionFor,
  } = await load('quickCommands.ts');

  // --- sanitize -------------------------------------------------------------
  eq(sanitizeQuickCommands(undefined), [], 'a missing list is empty');
  eq(sanitizeQuickCommands('ssh'), [], 'a non-array value is empty');
  eq(
    sanitizeQuickCommands([
      { name: 'Reboot', command: 'ssh root@${host} reboot' },
      { name: '', command: 'x' },
      { name: 'No command', command: '   ' },
      { command: 'nameless' },
      null,
      { name: 'Reboot', command: 'shadowed duplicate' },
      { name: 'Quiet', command: 'true', confirm: false },
      { name: 'Odd', command: 'true', confirm: 'yes' },
    ]),
    [
      { name: 'Reboot', command: 'ssh root@${host} reboot' },
      { name: 'Quiet', command: 'true', confirm: false },
      { name: 'Odd', command: 'true' },
    ],
    'sanitize drops malformed entries, keeps the first of a repeated name, and ignores a non-boolean confirm'
  );

  // --- resolve --------------------------------------------------------------
  eq(
    resolveQuickCommands(
      [{ name: 'Reboot', command: 'ssh admin@${host} /sbin/reboot' }],
      [
        { name: 'Reboot', command: 'ssh root@${host} reboot' },
        { name: 'Ping', command: 'ping -c 3 ${host}' },
      ]
    ),
    [
      { name: 'Reboot', command: 'ssh admin@${host} /sbin/reboot', source: 'connection' },
      { name: 'Ping', command: 'ping -c 3 ${host}', source: 'global' },
    ],
    'connection commands come first and shadow a global command of the same name'
  );
  eq(resolveQuickCommands(undefined, undefined), [], 'nothing configured resolves to nothing');

  // --- expand ---------------------------------------------------------------
  eq(
    expandQuickCommand('ssh root@${host} reboot', { host: '10.0.0.20', port: 5900 }),
    { ok: true, command: 'ssh root@10.0.0.20 reboot' },
    '${host} is substituted'
  );
  eq(
    expandQuickCommand('nc -z ${host} ${port} && echo ${host}:${port}', { host: 'panel.example.test', port: 5901 }),
    { ok: true, command: 'nc -z panel.example.test 5901 && echo panel.example.test:5901' },
    'every ${host} and ${port} occurrence is substituted'
  );
  eq(
    expandQuickCommand('scp ${HOME}/x root@${host}:', { host: 'h', port: 1 }),
    { ok: true, command: 'scp ${HOME}/x root@h:' },
    'other ${…} placeholders are left for the shell'
  );
  const injected = expandQuickCommand('ssh root@${host} reboot', { host: 'h; rm -rf ~', port: 5900 });
  ok(!injected.ok, 'a host with shell metacharacters is refused, not spliced into the command');
  eq(
    expandQuickCommand('echo hi', { host: 'h; rm -rf ~', port: 5900 }),
    { ok: true, command: 'echo hi' },
    'a command that never mentions ${host} runs whatever the host is'
  );

  ok(isShellSafeHost('192.168.1.10'), 'IPv4 is shell-safe');
  ok(isShellSafeHost('fe80::1%eth0'), 'IPv6 with a zone is shell-safe');
  ok(isShellSafeHost('[::1]'), 'bracketed IPv6 is shell-safe');
  ok(isShellSafeHost('device-1.example.test'), 'a DNS name is shell-safe');
  for (const bad of ['a b', 'a;b', 'a$b', "a'b", 'a`b', 'a|b', 'a&b', 'a>b', '']) {
    ok(!isShellSafeHost(bad), `"${bad}" is not shell-safe`);
  }

  // --- connection matching --------------------------------------------------
  const conns = [
    { name: 'Panel B', host: '10.0.0.20' },
    { name: 'Panel', host: '10.0.0.20', port: 5900 },
    { name: 'Other', host: '10.0.0.21' },
  ];
  eq(
    findConnectionFor({ label: 'Panel', host: '10.0.0.20', port: 5900 }, conns, 5900)?.name,
    'Panel',
    'the same target with the same name wins over another name on that target'
  );
  eq(
    findConnectionFor({ label: '10.0.0.20', host: '10.0.0.20', port: 5900 }, conns, 5900)?.name,
    'Panel B',
    'an ad-hoc session falls back to the first saved connection on its target (port defaulted)'
  );
  eq(
    findConnectionFor({ label: 'Panel', host: '10.0.0.20', port: 5901 }, conns, 5900),
    undefined,
    'a different port is a different target'
  );

  // --- tree -----------------------------------------------------------------
  const view = await load('sessionsView.ts');
  const session = { id: 's1', label: 'Panel', host: '10.0.0.20', port: 5900, status: 'connected', recording: false };
  const reboot = { name: 'Reboot', command: 'ssh root@${host} reboot', source: 'connection' };
  const conn = { name: 'Panel', host: '10.0.0.20', port: 5900, scope: 1 };

  const withCommands = () => ({ connection: conn, commands: [reboot] });
  const none = () => ({ connection: undefined, commands: [] });

  const [row] = view.sessionChildren(undefined, [session], withCommands);
  eq(row.collapsibleState, 2, 'a session with commands starts expanded');
  eq(row.contextValue, 'remoteVnc.session', 'the session row keeps its context value, so its inline buttons stay');
  eq(
    view.sessionChildren(undefined, [session], none)[0].collapsibleState,
    1,
    'a session without commands starts collapsed'
  );

  const [group] = view.sessionChildren(row, [session], withCommands);
  eq(group.label, 'Quick commands', 'a session has one "Quick commands" group');
  eq(group.contextValue, 'remoteVnc.quickCommands', 'the group carries the context value its inline + keys off');

  const [cmd] = view.sessionChildren(group, [session], withCommands);
  eq(cmd.label, 'Reboot', 'a command row is labelled with the command name');
  eq(cmd.description, 'ssh root@10.0.0.20 reboot', 'the row previews the expanded command line');
  eq(cmd.command.command, 'remoteVnc.runQuickCommand', 'clicking a command row runs it');
  eq(cmd.contextValue, 'remoteVnc.quickCommand', 'the command row carries the context value its inline buttons key off');

  const [emptyGroup] = view.sessionChildren(
    view.sessionChildren(undefined, [session], none)[0],
    [session],
    none
  );
  const [placeholder] = view.sessionChildren(emptyGroup, [session], none);
  eq(placeholder.command.command, 'remoteVnc.addQuickCommand', 'an empty group offers an "Add quick command…" row');
  ok(placeholder.command.arguments[0] === emptyGroup, 'the placeholder passes its group, the argument add expects');

  const unsafe = { ...session, host: 'x y' };
  const [unsafeCmd] = view.sessionChildren(
    view.sessionChildren(view.sessionChildren(undefined, [unsafe], withCommands)[0], [unsafe], withCommands)[0],
    [unsafe],
    withCommands
  );
  eq(unsafeCmd.iconPath.id, 'warning', 'a command that cannot run on this host shows a warning icon');

  // --- manifest -------------------------------------------------------------
  const manifest = JSON.parse(readFileSync(join(ROOT, 'package.json'), 'utf8'));
  const ids = ['runQuickCommand', 'addQuickCommand', 'editQuickCommand', 'deleteQuickCommand'].map(
    (c) => `remoteVnc.${c}`
  );
  const palette = manifest.contributes.menus.commandPalette;
  for (const id of ids) {
    ok(
      manifest.contributes.commands.some((c) => c.command === id),
      `${id} is declared`
    );
    ok(
      palette.some((e) => e.command === id && e.when === 'false'),
      `${id} is hidden from the Command Palette — it needs a tree item`
    );
  }
  const inline = manifest.contributes.menus['view/item/context'];
  ok(
    inline.some((e) => e.command === 'remoteVnc.addQuickCommand' && e.when.includes(`viewItem == ${group.contextValue}`)),
    'the + button keys off the context value the group really has'
  );
  for (const id of ['remoteVnc.runQuickCommand', 'remoteVnc.editQuickCommand', 'remoteVnc.deleteQuickCommand']) {
    ok(
      inline.some((e) => e.command === id && e.when.includes(`viewItem == ${cmd.contextValue}`)),
      `${id} keys off the context value a command row really has`
    );
  }
  const setting = manifest.contributes.configuration.properties['remoteVnc.quickCommands'];
  ok(setting?.restricted === true, 'remoteVnc.quickCommands is restricted: an untrusted workspace cannot set it');
  ok(
    manifest.contributes.configuration.properties['remoteVnc.connections'].items.properties.quickCommands,
    'a saved connection declares quickCommands, so settings.json validates it'
  );
}
