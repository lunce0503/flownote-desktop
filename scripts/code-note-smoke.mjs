import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { sendKoreanComposition } from './note-web-smoke.mjs';

const web = 'https://flownote-react-staging.vercel.app';
const api = 'https://flownote-api-staging.up.railway.app';
const pause = milliseconds => new Promise(resolve => setTimeout(resolve, milliseconds));

async function apiRequest(route, token, method = 'GET') {
  const response = await fetch(api + route, { method, signal: AbortSignal.timeout(30000),
    headers: { Authorization: `Bearer ${token}` },
  });
  assert(response.ok, `Native code-note ${method} ${route}: ${response.status}`);
  const text = await response.text(); return text ? JSON.parse(text) : null;
}

async function waitForStored(id, token, check, label) {
  let last;
  for (let attempt = 0; attempt < 90; attempt++) {
    const note = await apiRequest(`/api/notes/${id}`, token);
    last = note;
    if (check(note)) return note;
    await pause(500);
  }
  throw new Error(`Native code-note storage timeout: ${label}; syntheticState=${JSON.stringify({
    title: last?.title, content: last?.content, revision: last?.revision,
  })}`);
}

const utf16le = text => {
  const bytes = Buffer.allocUnsafe(2 + text.length * 2);
  bytes[0] = 0xff; bytes[1] = 0xfe;
  for (let index = 0; index < text.length; index++) bytes.writeUInt16LE(text.charCodeAt(index), 2 + index * 2);
  return bytes;
};

async function browserDownload(page, { name, expected, trigger }) {
  const waiting = page.waitForEvent('download'); await trigger();
  const download = await waiting;
  assert.equal(download.suggestedFilename(), name);
  const stream = await download.createReadStream();
  const chunks = []; for await (const chunk of stream) chunks.push(chunk);
  const bytes = Buffer.concat(chunks); assert.deepEqual(bytes, expected);
  return { name, mime: null, bytes };
}

async function browserFileSelection(page, { name, mimeType, bytes, trigger }) {
  const waiting = page.waitForEvent('filechooser'); await trigger();
  const chooser = await waiting;
  await chooser.setFiles({ name, mimeType, buffer: bytes });
}

async function exportCurrent(page, captureDownload, name, mime, expected) {
  await page.getByLabel('노트 세부 설정').click();
  const button = page.getByRole('button', { name: '파일 내보내기', exact: true });
  await button.waitFor();
  const result = await captureDownload({ page, name, mime, expected, trigger: () => button.click() });
  assert.equal(result.name, name); if (result.mime) assert.equal(result.mime, mime);
  assert.deepEqual(Buffer.from(result.bytes), expected);
}

/** Actual packaged-app WebView/Electron code note contract. Synthetic staging notes only. */
export async function verifyCodeNotes(initialPage, token, {
  androidWebView = false,
  captureDownload = details => browserDownload(initialPage, details),
  selectImport = details => browserFileSelection(initialPage, details),
  restart,
} = {}) {
  let page = initialPage;
  const ids = [];
  const pythonName = `native-${randomUUID().slice(0, 8)}-${'module-'.repeat(8)}끝.py`;
  const rustName = `native-${randomUUID().slice(0, 8)}-원본.rs`;
  const pythonBeforeIme = '# alpha ';
  const pythonExpected = `${pythonBeforeIme}한글 \n`;
  const rustOriginal = 'fn main() {\r\n    let value = "원본";\r\n}\r\n';
  try {
    await page.goto(`${web}/blog`);
    await page.getByRole('button', { name: '새 코드 파일', exact: true }).click();
    const dialog = page.getByRole('dialog', { name: '새 코드 파일', exact: true }); await dialog.waitFor();
    await dialog.getByLabel('파일 언어').selectOption('python');
    await dialog.getByLabel('파일 이름').fill(pythonName);
    const previous = page.url(); await dialog.getByRole('button', { name: '만들기', exact: true }).click();
    await page.waitForURL(url => /\/blog\/[a-z0-9-]+$/.test(url.pathname) && url.href !== previous);
    const pythonId = page.url().split('/').at(-1); ids.push(pythonId);
    await page.getByTestId('note-code-editor').waitFor();
    assert.equal(await page.getByTestId('note-code-editor').getAttribute('data-language'), 'python');
    assert.equal(await page.getByLabel('노트 제목').inputValue(), pythonName);
    const pythonEditor = page.getByRole('textbox', { name: '코드 편집기', exact: true });
    await pythonEditor.click(); await pythonEditor.press('ControlOrMeta+a');
    await page.keyboard.insertText(pythonBeforeIme);
    await pythonEditor.evaluate(node => {
      const state = { starts: 0, ends: 0, updates: [] }; Reflect.set(node, '__flownoteCodeIme', state);
      node.addEventListener('compositionstart', () => state.starts++);
      node.addEventListener('compositionupdate', event => state.updates.push(event.data));
      node.addEventListener('compositionend', () => state.ends++);
    });
    const cdp = await page.context().newCDPSession(page);
    await sendKoreanComposition(cdp, androidWebView); await cdp.detach();
    await pythonEditor.press('Enter');
    const storedPython = await waitForStored(pythonId, token,
      note => note.title === pythonName && note.content?.format === 'code' && note.content.text === pythonExpected
        && note.content.language === 'python' && (note.content.encoding ?? 'utf-8') === 'utf-8', 'Python IME save');
    assert.equal(storedPython.content.text, pythonExpected);
    const ime = await pythonEditor.evaluate(node => Reflect.get(node, '__flownoteCodeIme'));
    assert.equal(ime.starts, 1); assert.equal(ime.ends, 1); assert.deepEqual(ime.updates.slice(0, 2), ['한', '한글']);
    await exportCurrent(page, captureDownload, pythonName, 'text/plain', Buffer.from(pythonExpected, 'utf8'));

    await page.goto(`${web}/blog`); const importPrevious = page.url();
    const rustBytes = utf16le(rustOriginal);
    await selectImport({ page, name: rustName, mimeType: 'text/plain', bytes: rustBytes,
      trigger: () => page.getByRole('button', { name: '코드 파일 가져오기', exact: true }).click(),
    });
    await page.waitForURL(url => /\/blog\/[a-z0-9-]+$/.test(url.pathname) && url.href !== importPrevious);
    const rustId = page.url().split('/').at(-1); ids.push(rustId);
    const section = page.getByTestId('note-code-editor'); await section.waitFor();
    assert.equal(await section.getAttribute('data-language'), 'rust');
    assert.equal(await page.getByLabel('노트 제목').inputValue(), rustName);
    await waitForStored(rustId, token, note => note.content?.text === rustOriginal
      && note.content.language === 'rust' && note.content.encoding === 'utf-16le', 'UTF-16 Rust import');
    await page.getByLabel('코드 언어').selectOption('typescript');
    await waitForStored(rustId, token, note => note.content?.text === rustOriginal
      && note.content.language === 'typescript' && note.content.encoding === 'utf-16le', 'language highlight change');
    assert.equal(await page.getByLabel('노트 제목').inputValue(), rustName, 'Language highlighting must not rename the file');
    const rustEditor = page.getByRole('textbox', { name: '코드 편집기', exact: true });
    await rustEditor.press('ControlOrMeta+End'); await rustEditor.pressSequentially('// 끝'); await rustEditor.press('Enter');
    const rustExpected = `${rustOriginal}// 끝\r\n`;
    await waitForStored(rustId, token, note => note.content?.text === rustExpected
      && note.content.language === 'typescript' && note.content.encoding === 'utf-16le', 'Rust edit');
    await exportCurrent(page, captureDownload, rustName, 'text/plain', utf16le(rustExpected));
    if (androidWebView) {
      const metrics = await page.evaluate(() => ({ width: innerWidth, scrollWidth: document.documentElement.scrollWidth,
        toolbar: document.querySelector('[aria-label="코드 편집 도구"]')?.getBoundingClientRect().toJSON(),
      }));
      assert(metrics.scrollWidth <= metrics.width + 1, 'Code editor must not overflow the Android viewport');
      assert(metrics.toolbar?.height >= 44, 'Mobile code tools must retain a touch-sized row');
    }

    if (restart) page = await restart(); else await page.reload();
    await page.goto(`${web}/blog/${rustId}`); await page.getByTestId('note-code-editor').waitFor();
    assert.equal(await page.getByLabel('노트 제목').inputValue(), rustName);
    const afterRestart = await apiRequest(`/api/notes/${rustId}`, token);
    assert.equal(afterRestart.content.text, rustExpected); assert.equal(afterRestart.content.encoding, 'utf-16le');
    assert.equal(afterRestart.content.language, 'typescript');
    const visibleLines = await page.getByRole('textbox', { name: '코드 편집기', exact: true }).locator('.cm-line').allTextContents();
    assert.equal(visibleLines.join('\n'), rustExpected.replaceAll('\r\n', '\n'));
    console.log(`PASS native code notes: long .py filename, exact Korean IME, UTF-16 .rs import/export, language-only highlight change, cloud save and process restart${androidWebView ? ', mobile viewport' : ''}`);
    return { page, ids: [...ids] };
  } finally {
    for (const id of ids) await apiRequest(`/api/notes/${id}`, token, 'DELETE');
  }
}
