const { test } = require('node:test');
const assert = require('node:assert/strict');
const { PROFILES, profileForArgs, trustedUrl, externalUrl, safeDownloadName } = require('../policy.cjs');

test('only the explicit staging profile switches away from production', () => {
  assert.equal(profileForArgs([]), 'production');
  assert.equal(profileForArgs(['--url=http://localhost:3000']), 'production');
  assert.equal(profileForArgs(['--staging']), 'staging');
  assert.equal(profileForArgs(['--staging=false']), 'production');
  assert.notEqual(PROFILES.staging, PROFILES.production);
});
test('internal navigation requires the exact HTTPS origin without credentials', () => {
  const origin = PROFILES.production;
  assert(trustedUrl(`${origin}/canvas/123`, origin));
  for (const url of ['http://flownote-react.vercel.app', `${origin}.evil.example/`, `${origin}:444`, 'file:///C:/Windows/system.ini', 'javascript:alert(1)', 'https://user:secret@flownote-react.vercel.app', PROFILES.staging]) assert.equal(trustedUrl(url, origin), false, url);
});
test('external navigation never invokes file, command or custom protocol handlers', () => {
  for (const url of ['file:///C:/Windows/notepad.exe', 'javascript:alert(1)', 'cmd://example', 'ms-msdt:/example', 'http://example.com', 'https://user:secret@example.com']) assert.equal(externalUrl(url), false, url);
  assert(externalUrl('https://example.com/document'));
  assert(externalUrl('mailto:hello@example.com'));
});
test('download suggestions cannot escape the chosen directory or use Windows reserved names', () => {
  assert.equal(safeDownloadName('..\\..\\startup\\note.ics'), 'note.ics');
  assert.equal(safeDownloadName('/tmp/document.pdf'), 'document.pdf');
  assert.equal(safeDownloadName('CON.txt'), 'flownote-CON.txt');
  assert.equal(safeDownloadName('note. '), 'note');
  assert.equal(safeDownloadName(''), 'flownote-download');
});
