import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { readFile } from 'node:fs/promises';
import { downloadWrappers, newer, version, wrapperPin } from '../scripts/main.mjs';
import { names, bool, escapeCommand } from '../scripts/common.mjs';

test('strict versions and upgrade ordering avoid latest downgrades', () => {
  for (const bad of ['latest', '../0.13.0', '0.13.0;id', '0.11.0', '$(id)']) assert.throws(() => version(bad));
  assert.equal(newer('0.13.0', '0.12.2'), true);
  assert.equal(newer('0.13.0', '0.14.0-dev-1'), false);
  assert.equal(newer('0.13.0', '0.13.0-dev-1'), true);
  assert.equal(newer('0.13.0', '0.13.0'), false);
});
test('both official wrappers agree, including Windows dynamic assignments', async () => {
  const posix = await readFile(new URL('./fixtures/jvm/kotlin', import.meta.url));
  const windows = await readFile(new URL('./fixtures/jvm/kotlin.bat', import.meta.url));
  assert.deepEqual(wrapperPin(posix), wrapperPin(windows));
  const fakeDownload = async url => {
    const bytes = url.includes('wrapper.bat') ? windows : posix;
    return url.endsWith('.sha256') ? Buffer.from(createHash('sha256').update(bytes).digest('hex')) : bytes;
  };
  assert.equal((await downloadWrappers('0.12.2', fakeDownload)).length, 2);
  await assert.rejects(downloadWrappers('0.13.0', fakeDownload), /wrong version/);
  await assert.rejects(downloadWrappers('0.12.2', async url => url.endsWith('.sha256') ? Buffer.from('0'.repeat(64)) : posix), /SHA-256/);
});
test('input lists cannot add CLI flags or shell commands', () => {
  assert.deepEqual(names('app,lib\nother', 'modules'), ['app','lib','other']);
  for (const bad of ['--version','app;id','$(id)','../app']) assert.throws(() => names(bad,'modules'));
  assert.throws(() => bool('yes','validate'));
  assert.equal(escapeCommand('x\n::error::x'), 'x%0A::error::x');
});
