import { load } from './bundle.mjs';

export default async function ({ ok, eq }) {
  const { SessionTreeItem } = await load('sessionsView.ts');

  const connected = new SessionTreeItem({ id: 'a', label: 'Alpha', status: 'connected', recording: false });
  eq(connected.iconPath.id, 'circle-filled', 'connected → circle-filled icon');
  eq(connected.contextValue, 'remoteVnc.session', 'not recording → base contextValue');

  const reconnecting = new SessionTreeItem({ id: 'b', label: 'Beta', status: 'reconnecting', recording: false });
  eq(reconnecting.iconPath.id, 'sync~spin', 'reconnecting → animated sync~spin icon');
  eq(reconnecting.tooltip, 'Reconnecting…', 'reconnecting → tooltip');
  eq(reconnecting.contextValue, 'remoteVnc.session', 'reconnecting, not recording → base contextValue');

  const recording = new SessionTreeItem({ id: 'c', label: 'Gamma', status: 'connected', recording: true });
  eq(recording.contextValue, 'remoteVnc.session.recording', 'recording → recording contextValue');
  eq(recording.iconPath.id, 'record', 'recording → record icon');
  eq(recording.iconPath.color.id, 'charts.red', 'recording → red icon color');
  eq(recording.tooltip, 'Recording', 'recording → tooltip');

  const reconnectingWhileRecording = new SessionTreeItem({
    id: 'd',
    label: 'Delta',
    status: 'reconnecting',
    recording: true,
  });
  eq(
    reconnectingWhileRecording.iconPath.id,
    'sync~spin',
    'reconnecting wins over recording for the icon'
  );
  eq(
    reconnectingWhileRecording.contextValue,
    'remoteVnc.session.recording',
    'contextValue still reflects recording even while reconnecting'
  );
}
