import { _electron as electron } from 'playwright';
import assert from 'node:assert/strict';
import { createHash, randomUUID } from 'node:crypto';
import { mkdtemp, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { verifyReader } from './reader-web-smoke.mjs';
import { verifySharedFolders } from './shared-folders-smoke.mjs';
import { verifyNoteEditing } from './note-web-smoke.mjs';
import { verifyNoteImages } from './note-image-smoke.mjs';
import { verifyCodeNotes } from './code-note-smoke.mjs';
import { verifyNoteTools } from './note-tools-smoke.mjs';
import { verifyCanvasSafety } from './canvas-safety-smoke.mjs';
import { parseWindowsGroups } from '../../scripts/verification-scope.mjs';

const selected = parseWindowsGroups(process.env.FLOWNOTE_WINDOWS_WEB_SCOPE);
const executables = process.argv.slice(2);
assert(executables.length, 'At least one Windows executable is required');

const web = 'https://flownote-react-staging.vercel.app';
const api = 'https://flownote-api-staging.up.railway.app';
const hash = value => createHash('sha256').update(value).digest('hex');
const html = await (await fetch(web)).text();
const entry = html.match(/<script\b[^>]*type="module"[^>]*src="([^"]+)"/);
assert(entry, 'Staging entry module missing');
const entryUrl = new URL(entry[1], web).href;
const expectedHash = hash(Buffer.from(await (await fetch(entryUrl)).arrayBuffer()));
const pause = ms => new Promise(resolve => setTimeout(resolve, ms));
for (const route of ['/api/users/me', ...(selected.includes('canvas') ? ['/api/canvas/documents'] : [])]) {
  for (let attempt = 0; attempt < 10; attempt++) {
    const response = await fetch(api + route, { signal: AbortSignal.timeout(30000) }).catch(() => null);
    if (response?.status === 401) break;
    assert(attempt < 9, 'Staging auth readiness'); await pause(2000);
  }
}
async function request(route, method, body, token) {
  const response = await fetch(api + route, { method, signal: AbortSignal.timeout(30000),
    headers: { 'Content-Type': 'application/json', ...(token ? { Authorization: `Bearer ${token}` } : {}) },
    ...(body ? { body: JSON.stringify(body) } : {}),
  });
  assert(response.ok, `Staging ${method} ${route}: ${response.status}`);
  const text = await response.text(); return text ? JSON.parse(text) : null;
}
const failures = [];
for (const executablePath of executables) {
  const kind = executablePath.includes('FlownotePortable') ? 'portable' : 'installer';
  const failed = (phase, error) => {
    failures.push({ kind, phase, error: String(error.stack ?? error.message).slice(0, 5000) });
    console.error(`FAIL ${kind} ${phase}: ${error.stack ?? error.message}`);
  };
  const email = `native-feedback-${randomUUID()}@example.com`, password = randomUUID();
  await request('/api/users', 'POST', { email, password, username: `nf-${randomUUID().slice(0, 8)}`, nickname: 'Synthetic native web release' });
  const { token } = await request('/api/users/login', 'POST', { email, password });
  let app, canvas;
  const launch = async () => {
    app = await electron.launch({ executablePath, args: ['--staging'], timeout: 60000 });
    const page = await app.firstWindow(); page.setDefaultTimeout(45000);
    await page.waitForURL(`${web}/**`);
    return page;
  };
  try {
    let page = await launch();
    await page.context().clearCookies();
    await page.goto(`${web}/login`);
    await page.getByLabel('이메일').fill(email); await page.getByLabel('비밀번호', { exact: true }).fill(password);
    await page.getByRole('button', { name: '계속하기', exact: true }).click();
    await page.getByRole('navigation', { name: '앱 기능' }).waitFor();
    await page.evaluate(() => localStorage.setItem('flownote-shared-web-release-probe', 'preserved'));
    await app.close(); app = undefined;
    page = await launch();
    await page.getByRole('navigation', { name: '앱 기능' }).waitFor();
    assert.equal(await page.evaluate(() => localStorage.getItem('flownote-shared-web-release-probe')), 'preserved');
    const response = page.waitForResponse(response => response.url() === entryUrl);
    await page.reload();
    assert([200, 304].includes((await response).status()), 'Entry module did not load or revalidate');
    // Electron exposes cache revalidation as 304; that response has no body.
    // Read the browser's cached bytes and also require the executing entry URL.
    const loaded = await page.evaluate(async url => {
      const script = document.querySelector('script[type="module"][src]');
      if (!script || new URL(script.getAttribute('src'), location.href).href !== url) throw new Error('Unexpected executing entry');
      const response = await fetch(url, { cache: 'force-cache' });
      if (!response.ok) throw new Error('Cached entry unavailable');
      const digest = await crypto.subtle.digest('SHA-256', await response.arrayBuffer());
      return Array.from(new Uint8Array(digest), byte => byte.toString(16).padStart(2, '0')).join('');
    }, entryUrl);
    assert.equal(loaded, expectedHash, 'Published binary cached an older web bundle');
    assert.equal(await page.locator('html').getAttribute('data-desktop-app'), 'true');
    assert.equal(await page.evaluate(() => typeof window.require), 'undefined');
    const preferences = await app.evaluate(({BrowserWindow}) => {
      const value = BrowserWindow.getAllWindows()[0].webContents.getLastWebPreferences();
      return {sandbox:value.sandbox,contextIsolation:value.contextIsolation,nodeIntegration:value.nodeIntegration};
    });
    assert.deepEqual(preferences,{sandbox:true,contextIsolation:true,nodeIntegration:false});
    if (selected.includes('canvas')) {
    canvas = await request('/api/canvas/documents', 'POST', { title: 'Synthetic native shared web' }, token);
    await page.goto(`${web}/canvas/${canvas.id}`);
    const surface = page.getByTestId('canvas-input-surface');
    await surface.waitFor();
    await page.waitForFunction(() => document.querySelector('[data-testid="canvas-input-surface"]')?.getAttribute('data-ready') === 'true');
    const toggle = page.getByTestId('canvas-tool-menu-toggle');
    if (await toggle.isVisible()) await toggle.click();
    await page.getByRole('button', { name: '펜', exact: true }).click();
    await page.keyboard.press('Escape');
    const box = await surface.boundingBox(); assert(box);
    // Settle the real toolbar mouse before introducing a separate pen stream.
    await page.mouse.move(box.x + 180, box.y + 240);
    await page.evaluate(() => new Promise(resolve => {
      requestAnimationFrame(() => requestAnimationFrame(resolve));
    }));
    // Presentation event only. This does not certify Windows pen hardware.
    await surface.dispatchEvent('pointermove', { pointerId: 90, pointerType: 'pen', clientX: box.x + 180, clientY: box.y + 240, buttons: 0 });
    const marker = page.getByTestId('canvas-tool-pointer');
    await marker.waitFor(); assert.equal(await marker.getAttribute('data-tool'), 'pen');
    assert.equal(await marker.evaluate(node => getComputedStyle(node).pointerEvents), 'none');
    assert.equal(await marker.textContent(), '');
    assert.equal(await marker.locator('svg').count(), 0);
    const tip = await page.getByTestId('canvas-tool-pointer-tip').boundingBox();
    assert(tip); assert.equal(tip.width, 4); assert.equal(tip.height, 4);
    await page.reload();
    await page.waitForFunction(() => document.querySelector('[data-testid="canvas-input-surface"]')?.getAttribute('data-ready') === 'true');
    await page.getByTestId('canvas-tool-pointer').waitFor({ state: 'attached' });
    assert.equal(await page.getByTestId('canvas-tool-pointer').count(), 1);
    const result = await verifyCanvasSafety(page, { restart: async () => {
      await app.close(); app = undefined;
      return launch();
    } });
    page = result.page;
    }
    if (selected.includes('notes')) {
      try { await verifyNoteEditing(page, token); } catch (error) { failed('note editing', error); }
      try { await verifyNoteImages(page,token); } catch(error) { failed('note images',error); }
      try {
        const captureDownload = async ({ name, trigger }) => {
          const directory = await mkdtemp(path.join(tmpdir(), 'flownote-code-download-'));
          const target = path.join(directory, name);
          try {
            await app.evaluate(({ session }, details) => {
              globalThis.__flownoteCodeDownload = null;
              session.defaultSession.once('will-download', (event, item, contents) => {
                if (!contents) { event.preventDefault(); globalThis.__flownoteCodeDownload = { state: 'blocked' }; return; }
                item.setSavePath(details.target);
                const filename = item.getFilename(), mime = item.getMimeType();
                item.once('done', (_event, state) => { globalThis.__flownoteCodeDownload = { state, filename, mime }; });
              });
            }, { target });
            await trigger();
            let result;
            for (let attempt = 0; attempt < 100; attempt++) {
              result = await app.evaluate(() => globalThis.__flownoteCodeDownload ?? null);
              if (result) break;
              await pause(100);
            }
            assert(result, 'Native code download did not complete');
            assert.equal(result.state, 'completed'); assert.equal(result.filename, name);
            return { name: result.filename, mime: result.mime, bytes: await readFile(target) };
          } finally { await rm(directory, { recursive: true, force: true }); }
        };
        const result = await verifyCodeNotes(page, token, { captureDownload, restart: async () => {
          await app.close(); app = undefined;
          return launch();
        } });
        page = result.page;
      } catch (error) { failed('code notes', error); }
      try {
        await verifyNoteTools(page, token, { readClipboard: () => app.evaluate(({ clipboard }) => clipboard.readText()) });
      } catch (error) { failed('note tools', error); }
    }
    if (selected.includes('library')) try { await verifyReader(page); } catch (error) { failed('existing reader', error); }
    if (selected.includes('workspace')) try { await verifySharedFolders(page,token); } catch(error) { failed('shared folders',error); }
    console.log(`PASS ${kind}: current staging entry SHA-256, session/restart/sandbox and selected scopes: ${selected.join(',')}`);
  } catch (error) {
    failed('shared app setup', error);
  } finally {
    if (app) await app.close();
    try {
      if (canvas) await request(`/api/canvas/documents/${canvas.id}`, 'DELETE', null, token);
      await request('/api/users/logout', 'POST', null, token);
    } catch (error) { failed('synthetic cleanup', error); }
  }
}
assert.equal(failures.length, 0, JSON.stringify(failures));
