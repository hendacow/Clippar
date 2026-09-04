import assert from 'node:assert/strict';
import { readFileSync, existsSync } from 'node:fs';
import { join } from 'node:path';
import test from 'node:test';

const root = join(import.meta.dirname, '..');
const bt = readFileSync(join(root, 'app/profile/bluetooth.tsx'), 'utf8');
const sheet = readFileSync(join(root, 'components/record/RecordingSettingsSheet.tsx'), 'utf8');
const rec = readFileSync(join(root, 'app/(tabs)/record.tsx'), 'utf8');
const help = readFileSync(join(root, 'lib/clickerHelp.ts'), 'utf8');
const preview = readFileSync(join(root, 'components/editor/PreviewPlayer.tsx'), 'utf8');

// Henry, 4 Sep: "get rid of scan for devices — three steps to connect the clicker".
test('the Bluetooth page leads with three connect steps and hides the scan', () => {
  assert.match(bt, /Connect your clicker/);
  assert.match(bt, /CONNECT_STEPS\.map/);
  assert.doesNotMatch(bt, /title=\{ble\.connectionState === 'scanning' \? 'Scanning\.\.\.' : 'Scan for Devices'\}/, 'the old primary scan button is gone');
  assert.match(bt, /Advanced: my clicker does not show up in iPhone Settings/, 'the scan survives behind a fold');
  assert.equal((help.match(/title: '/g) ?? []).length >= 3, true);
});

test('Troubleshoot & how-to is reachable from Options and the clicker badge', () => {
  assert.ok(existsSync(join(root, 'components/record/TroubleshootSheet.tsx')));
  assert.match(sheet, /Troubleshoot & how-to/);
  assert.match(sheet, /onTroubleshoot: \(\) => void;/);
  assert.match(rec, /<TroubleshootSheet visible=\{showTroubleshoot\}/);
  assert.match(rec, /setShowTroubleshoot\(true\)/);
  for (const key of ['connect', 'record', 'next-hole', 'penalty', 'delete', 'not-working', 'cut-short', 'end']) {
    assert.match(help, new RegExp(`key: '${key}'`), `help covers ${key}`);
  }
});

// "Open full editor" left the reel's sound playing underneath.
test('the reel pauses when its screen loses focus', () => {
  assert.match(preview, /useFocusEffect\(/);
  assert.match(preview, /try \{ player\.pause\(\); \} catch \{\}/);
});
