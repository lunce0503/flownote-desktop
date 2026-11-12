import { _electron as electron } from 'playwright';
import { strict as assert } from 'node:assert';
import { randomUUID, createHash } from 'node:crypto';
import { readFile, writeFile, mkdir } from 'node:fs/promises';
import path from 'node:path';
import { textbookPdf } from './library-fixture.mjs';

const executablePath = process.argv[2];
if (!executablePath) throw new Error('Usage: npm run smoke -- <installed-or-portable-Flownote.exe>');
const api = 'https://flownote-api-staging.up.railway.app';
const email = `windows-${randomUUID()}@example.com`, password = randomUUID();
// Cloud staging is serverless. Warm read-only auth routes before creating test data.
for (const route of ['/api/users/me', '/api/canvas/documents']) {
  for (let attempt = 0; attempt < 8; attempt++) {
    const response = await fetch(`${api}${route}`, { signal: AbortSignal.timeout(30000) }).catch(() => null);
    if (response?.status === 401) break;
    assert(attempt < 7, `Staging auth service did not become ready: ${route} (${response?.status})`);
    await new Promise(resolve => setTimeout(resolve, 3000));
  }
}
async function request(route, method, body, token) {
  const response = await fetch(`${api}${route}`, { method,
    headers: { 'Content-Type': 'application/json', ...(token ? { Authorization: `Bearer ${token}` } : {}) },
    ...(body ? { body: JSON.stringify(body) } : {}), signal: AbortSignal.timeout(30000) });
  assert(response.ok, `${method} ${route}: ${response.status}`);
  const text = await response.text();
  return text ? JSON.parse(text) : null;
}
await request('/api/users', 'POST', { email, password, username: `windows-${randomUUID().slice(0, 8)}`, nickname: 'Windows verification' });
let application = await electron.launch({ executablePath, args: ['--staging'], timeout: 60000 });
let canvasId, token;
try {
  let page = await application.firstWindow();
  page.setDefaultTimeout(30000);
  await page.waitForURL('https://flownote-react-staging.vercel.app/**');
  await page.context().clearCookies();
  // A full navigation after clearing only test cookies avoids racing the app's
  // session-expiry redirect while evaluating in a destroyed page context.
  await page.goto('https://flownote-react-staging.vercel.app/login');
  await page.waitForURL('**/login');
  await page.getByLabel('이메일').fill(email);
  await page.getByLabel('비밀번호', { exact: true }).fill(password);
  await page.getByRole('button', { name: '계속하기', exact: true }).click();
  await page.getByRole('heading', { name: '작업을 선택하세요' }).waitFor();
  await page.evaluate(() => localStorage.setItem('flownote-native-update-draft-probe', 'preserved'));
  await application.close();
  application = await electron.launch({ executablePath, args: ['--staging'], timeout: 60000 });
  page = await application.firstWindow();
  page.setDefaultTimeout(30000);
  await page.getByRole('heading', { name: '작업을 선택하세요' }).waitFor();
  assert.equal(await page.evaluate(() => localStorage.getItem('flownote-native-update-draft-probe')), 'preserved');
  assert(await application.evaluate(({ Menu }) => Boolean(Menu.getApplicationMenu().getMenuItemById('app-update-status'))));
  assert.equal(await page.locator('header').count(), 0);
  assert.equal(await page.locator('html').getAttribute('data-desktop-app'), 'true');
  assert.equal(await page.locator('html').getAttribute('data-theme'), 'light');
  assert.equal(await page.evaluate(() => typeof window.require), 'undefined');
  assert.equal(await page.evaluate(() => typeof window.process), 'undefined');
  const preferences = await application.evaluate(({ BrowserWindow }) => {
    const preferences = BrowserWindow.getAllWindows()[0].webContents.getLastWebPreferences();
    return { sandbox: preferences.sandbox, contextIsolation: preferences.contextIsolation, nodeIntegration: preferences.nodeIntegration };
  });
  assert.deepEqual(preferences, { sandbox: true, contextIsolation: true, nodeIntegration: false });
  const nav = page.getByRole('navigation', { name: '앱 기능' });
  const box = await nav.boundingBox();
  assert(box.width <= 100 && box.height > 600, 'Desktop navigation must be a vertical rail.');
  await page.reload();
  await page.getByRole('heading', { name: '작업을 선택하세요' }).waitFor();
  await page.getByRole('button', { name: '전체 기능', exact: true }).click();
  const menu = page.getByRole('dialog', { name: '전체 기능' });
  for (const href of ['/library', '/canvas', '/planner', '/social', '/agent', '/settings']) assert.equal(await menu.locator(`a[href="${href}"]`).count(), 1);
  await page.keyboard.press('Escape');
  await menu.waitFor({ state: 'hidden' });
  assert.equal(await page.evaluate(() => localStorage.getItem('flownote_auth_token')), null);
  // Native test setup uses its own session, never a browser credential.
  token = (await request('/api/users/login', 'POST', { email, password })).token;
  const canvas = await request('/api/canvas/documents', 'POST', { title: 'Windows installed app verification' }, token);
  canvasId = canvas.id;
  await page.goto(`https://flownote-react-staging.vercel.app/canvas/${canvasId}`);
  await page.waitForFunction(() => document.querySelector('[data-testid="canvas-input-surface"]')?.getAttribute('data-ready') === 'true');
  const surface = page.getByTestId('canvas-input-surface');
  const rect = await surface.boundingBox();
  await page.mouse.move(rect.x + 250, rect.y + 220);
  await page.mouse.down();
  await page.mouse.move(rect.x + 400, rect.y + 280, { steps: 12 });
  await page.mouse.up();
  for (let attempt = 0; attempt < 30; attempt++) {
    const loaded = await request(`/api/canvas/load?canvasId=${canvasId}`, 'GET', null, token);
    if (loaded.lines?.length > 0) break;
    assert(attempt < 29, 'Drawing did not reach cloud staging.');
    await new Promise(resolve => setTimeout(resolve, 500));
  }
  await page.reload();
  await page.waitForFunction(() => Number(document.querySelector('[data-testid="canvas-render-surface"]')?.getAttribute('data-visible-line-count')) > 0);

  const directory = path.resolve('test-output');
  await mkdir(directory, { recursive: true });
  const original = textbookPdf(100 * 1024 * 1024);
  const inputPath = path.join(directory, 'native-textbook.pdf');
  await writeFile(inputPath, original);
  await page.goto('https://flownote-react-staging.vercel.app/library');
  await page.getByRole('button', { name: '책 추가', exact: true }).click();
  await page.getByLabel('PDF 파일').setInputFiles(inputPath);
  await page.getByLabel('책 제목', { exact: true }).fill('Native 100MiB textbook');
  await page.getByRole('button', { name: '책장에 추가', exact: true }).click();
  await page.getByRole('dialog', { name: '책 펼쳐 보기' }).getByRole('img').waitFor();
  assert.equal(await page.getByTestId('library-pdf-page').count(), 0);
  await page.getByRole('button', { name: '책 읽기', exact: true }).click();
  await page.getByTestId('library-pdf-page').waitFor();
  await application.close();
  application = await electron.launch({ executablePath, args: ['--staging'], timeout: 60000 });
  page = await application.firstWindow(); page.setDefaultTimeout(60000);
  await page.goto('https://flownote-react-staging.vercel.app/library');
  await page.getByRole('button', { name: 'Native 100MiB textbook 표지 보기' }).click();
  const pdfPath = path.join(directory, 'native-textbook-export.pdf');
  await application.evaluate(({ session }, savePath) => session.defaultSession.once('will-download', (_event, item) => item.setSavePath(savePath)), pdfPath);
  await page.getByRole('button', { name: '원본 PDF 내보내기' }).click();
  for (let attempt = 0; attempt < 90; attempt++) {
    const bytes = await readFile(pdfPath).catch(() => Buffer.alloc(0));
    if (bytes.length === original.length) { assert.equal(createHash('sha256').update(bytes).digest('hex'), createHash('sha256').update(original).digest('hex')); break; }
    assert(attempt < 89, '100MiB native export missing'); await new Promise(resolve => setTimeout(resolve, 500));
  }
  console.log('PASS native library: import 100MiB, cover, reader, process restart and exact original PDF export');
  const downloadPath = path.join(directory, 'windows-smoke.ics');
  await application.evaluate(({ session }, savePath) => {
    session.defaultSession.once('will-download', (_event, item) => item.setSavePath(savePath));
  }, downloadPath);
  await page.evaluate(() => {
    const anchor = document.createElement('a');
    anchor.href = URL.createObjectURL(new Blob(['BEGIN:VCALENDAR\r\nEND:VCALENDAR\r\n'], { type: 'text/calendar' }));
    anchor.download = 'windows-smoke.ics'; document.body.append(anchor); anchor.click(); anchor.remove();
  });
  for (let attempt = 0; attempt < 30; attempt++) {
    const file = await readFile(downloadPath, 'utf8').catch(() => '');
    if (file.includes('BEGIN:VCALENDAR')) break;
    assert(attempt < 29, 'Native download did not save the calendar file.');
    await new Promise(resolve => setTimeout(resolve, 500));
  }
  await page.goto('https://flownote-react-staging.vercel.app/');
  await page.getByRole('heading', { name: '작업을 선택하세요' }).waitFor();
  await page.screenshot({ path: path.join(directory, 'windows-home.png') });
  console.log('PASS Windows packaged app: sandbox, login and draft preservation across process restart, native update menu, navigation, canvas cloud save/reload and native download.');
} finally {
  if (canvasId && token) await request(`/api/canvas/documents/${canvasId}`, 'DELETE', null, token);
  await application.close();
}
