import { load } from './bundle.mjs';

export default async function ({ ok, eq }) {
  const {
    registerPanel,
    unregisterPanel,
    listPanels,
    getPanel,
    setFocusedPanel,
    getFocusedPanel,
  } = await load('panelRegistry.ts');

  const stub = (id, name, kind, mirrored) => ({
    id, name, kind, mirrored,
    screenshot: async () => `/tmp/${id}.png`,
    record: async () => {},
    recordStop: async () => `/tmp/${id}.webm`,
    reload: async () => {},
    isRecording: () => false,
  });

  eq(listPanels(), [], 'starts empty');

  registerPanel(stub('p1', 'design', 'page', true));
  registerPanel(stub('s1', 'kiosk', 'session', false));

  eq(listPanels().map((p) => p.id).sort(), ['p1', 's1'], 'both listed');
  eq(listPanels()[0].screenshot, undefined, 'summaries carry no callables');
  eq(getPanel('p1').name, 'design', 'lookup by id');
  eq(getPanel('nope'), undefined, 'unknown id → undefined');

  // re-registering the same id replaces rather than duplicates
  registerPanel(stub('p1', 'renamed', 'page', true));
  eq(listPanels().filter((p) => p.id === 'p1').length, 1, 'no duplicate on re-register');
  eq(getPanel('p1').name, 'renamed', 're-register replaces');

  unregisterPanel('p1');
  eq(listPanels().map((p) => p.id), ['s1'], 'unregister removes');
  unregisterPanel('gone');
  ok(true, 'unregistering an unknown id does not throw');

  // focus tracking
  eq(getFocusedPanel(), undefined, 'nothing focused initially');
  registerPanel(stub('p2', 'other', 'page', false));
  setFocusedPanel('s1');
  eq(getFocusedPanel().id, 's1', 'focused panel is returned');
  setFocusedPanel('p2');
  eq(getFocusedPanel().id, 'p2', 'switching focus moves to the new panel');
  setFocusedPanel(undefined);
  eq(getFocusedPanel(), undefined, 'clearing focus returns undefined');

  // a disposed panel must not stay "focused"
  setFocusedPanel('s1');
  unregisterPanel('s1');
  eq(getFocusedPanel(), undefined, 'unregistering the focused panel clears focus');

  // and a later re-register under the same id does not silently resume focus
  registerPanel(stub('s1', 'kiosk again', 'session', false));
  eq(getFocusedPanel(), undefined, 're-registering the old id does not restore stale focus');
}
