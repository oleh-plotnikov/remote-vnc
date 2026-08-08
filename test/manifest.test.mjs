// Manifest inspection. Everything asserted here is a fact that only
// package.json states and that nothing checks: TypeScript never reads the
// manifest, so a viewType typo, a priority left at its most obvious value or a
// `when` clause copied from the entry above it all compile, package and
// install cleanly — and then fail at runtime as a menu item that never appears
// or a command that opens nothing, with no error in any log. Read as text, the
// way test/thirdPartyNotices.test.mjs reads the notices.
import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');
const read = (p) => readFileSync(join(ROOT, p), 'utf8');

export default async function ({ ok, eq }) {
  // A manifest that does not parse is not a broken feature, it is an extension
  // that never loads, so this is the first assertion and it throws rather than
  // counting a failure.
  const manifest = JSON.parse(read('package.json'));

  const editors = manifest.contributes.customEditors;
  eq(editors.length, 1, 'exactly one custom editor is contributed');
  const crop = editors[0];

  // The one field here that is a correctness decision rather than a taste.
  ok(
    crop.priority === 'option',
    'the crop editor is contributed at priority "option": VS Code ranks editor candidates ' +
      'default=4, builtin=3, text=2, option=1, and the built-in image preview registers ' +
      '*.png at builtin=3 — at "default" this editor would outrank it and silently hijack ' +
      'every PNG in every workspace, while vscode.openWith bypasses ranking for our own flow'
  );

  // Nothing links these two literals at compile time, and vscode.openWith fails
  // at runtime on a mismatch — with a tab that simply never opens.
  const declared = /export const CROP_VIEW_TYPE = '([^']+)'/.exec(read('src/cropEditor.ts'));
  ok(declared, 'src/cropEditor.ts exports a CROP_VIEW_TYPE string literal');
  eq(
    crop.viewType,
    declared?.[1],
    'the manifest viewType equals CROP_VIEW_TYPE in src/cropEditor.ts'
  );

  // Widening this selector is how the extra Reopen Editor With… row starts
  // appearing on files the crop editor cannot read.
  eq(
    crop.selector,
    [{ filenamePattern: '*.png' }],
    'the crop editor is offered for *.png and nothing else'
  );

  const titles = manifest.contributes.menus['editor/title'];
  const entry = titles.find((item) => item.command === 'remoteVnc.cropImage');
  ok(entry, 'remoteVnc.cropImage has an editor/title entry');
  // The three entries beside this one all key off activeWebviewPanelId, which
  // is the trap: the image preview is a custom editor and never sets that key,
  // so copying the neighbouring idiom yields a button that silently never
  // shows.
  ok(
    entry?.when.includes('activeCustomEditorId'),
    'the crop button keys off activeCustomEditorId, the only key the image preview sets'
  );
  ok(
    !entry?.when.includes('activeWebviewPanelId'),
    'the crop button does not key off activeWebviewPanelId, which the image preview never sets'
  );

  const setting = manifest.contributes.configuration.properties['remoteVnc.screenshotCropEditor'];
  ok(setting, 'remoteVnc.screenshotCropEditor is declared, so it reaches the Settings UI');
  eq(setting?.type, 'boolean', 'remoteVnc.screenshotCropEditor is a boolean');
  eq(
    setting?.default,
    true,
    'remoteVnc.screenshotCropEditor defaults to true, so a capture lands in the crop editor'
  );
}
