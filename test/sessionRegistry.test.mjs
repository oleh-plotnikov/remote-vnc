import { load } from './bundle.mjs';

export default async function ({ ok, eq }) {
  const { SessionRegistry } = await load('sessionRegistry.ts');
  const r = new SessionRegistry();
  let changes = 0;
  r.onChange(() => { changes += 1; });

  eq(r.list(), [], 'starts empty');

  r.add('a', 'Alpha');
  eq(r.list(), [{ id: 'a', label: 'Alpha', status: 'connected' }], 'add registers id+label, status connected');
  eq(changes, 1, 'add fires change');

  r.setStatus('a', 'reconnecting');
  eq(r.list(), [{ id: 'a', label: 'Alpha', status: 'reconnecting' }], 'setStatus updates status');
  eq(changes, 2, 'setStatus fires change');

  r.setStatus('a', 'reconnecting');
  eq(changes, 2, 'setStatus to the same value does not fire');

  r.setStatus('missing', 'reconnecting');
  eq(changes, 2, 'setStatus on unknown id does not fire');

  r.remove('a');
  eq(r.list(), [], 'remove drops the entry');
  eq(changes, 3, 'remove fires change');

  r.remove('missing');
  eq(changes, 3, 'removing an unknown id does not fire');
}
