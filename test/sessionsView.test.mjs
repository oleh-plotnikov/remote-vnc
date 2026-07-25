import { load } from './bundle.mjs';

export default async function ({ ok, eq }) {
  const { SessionTreeItem } = await load('sessionsView.ts');

  const connected = new SessionTreeItem({ id: 'a', label: 'Alpha', status: 'connected' });
  eq(connected.iconPath.id, 'circle-filled', 'connected → circle-filled icon');

  const reconnecting = new SessionTreeItem({ id: 'b', label: 'Beta', status: 'reconnecting' });
  eq(reconnecting.iconPath.id, 'sync~spin', 'reconnecting → animated sync~spin icon');
  eq(reconnecting.tooltip, 'Reconnecting…', 'reconnecting → tooltip');
}
