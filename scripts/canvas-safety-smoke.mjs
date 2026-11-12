import assert from 'node:assert/strict';
import { randomUUID, createHash } from 'node:crypto';

const web = 'https://flownote-react-staging.vercel.app';
const api = 'https://flownote-api-staging.up.railway.app';
const pause = ms => new Promise(resolve => setTimeout(resolve, ms));
const cloudDb = owner => `flownote-canvas-cloud:${owner}`;

async function until(action, description, timeout = 45000) {
  const deadline = Date.now() + timeout;
  while (Date.now() < deadline) {
    if (await action()) return;
    await pause(100);
  }
  throw new Error(`Canvas safety timeout: ${description}`);
}
async function request(route, method, body, actor) {
  const response = await fetch(api + route, {
    method, signal: AbortSignal.timeout(30000),
    headers: { 'Content-Type': 'application/json', ...(actor ? { Authorization: `Bearer ${actor.token}` } : {}) },
    ...(body === undefined ? {} : { body: JSON.stringify(body) }),
  });
  assert(response.ok, `Synthetic canvas ${method} ${route.split('?')[0]}: HTTP ${response.status}`);
  const text = await response.text();
  return text ? JSON.parse(text) : null;
}
async function actor() {
  const email = `native-canvas-${randomUUID()}@example.com`, password = randomUUID();
  await request('/api/users', 'POST', { email, password, username: `nc-${randomUUID().slice(0, 8)}`, nickname: 'Synthetic canvas safety' });
  return { ...await request('/api/users/login', 'POST', { email, password }), email, password };
}
async function login(page, user) {
  const session = await page.context().newCDPSession(page);
  await session.send('Network.deleteCookies', { name: '__Host-flownote_session', url: web });
  await session.detach();
  await page.goto(web + '/login');
  await page.evaluate(() => { localStorage.removeItem('flownote_auth_user'); localStorage.removeItem('flownote_auth_token'); });
  await page.goto(web + '/login');
  await page.getByLabel('이메일').fill(user.email);
  await page.getByLabel('비밀번호', { exact: true }).fill(user.password);
  await page.getByRole('button', { name: '계속하기', exact: true }).click();
  await page.getByRole('navigation', { name: '앱 기능' }).waitFor();
  assert.equal(await page.evaluate(() => JSON.parse(localStorage.getItem('flownote_auth_user')).id), user.user.id);
}
async function storage(page, name, store, key, value, write = false) {
  return page.evaluate(({ name, store, key, value, write }) => new Promise((resolve, reject) => {
    const open = indexedDB.open(name, 1);
    open.onupgradeneeded = () => {
      for (const item of ['drafts', 'operations']) if (!open.result.objectStoreNames.contains(item)) open.result.createObjectStore(item);
    };
    open.onerror = () => reject(new Error('Synthetic IDB open failed'));
    open.onsuccess = () => {
      const db = open.result, tx = db.transaction(store, write ? 'readwrite' : 'readonly');
      const r = write ? tx.objectStore(store).put(value, key) : tx.objectStore(store).get(key);
      let result;
      r.onsuccess = () => { result = r.result ?? null; };
      tx.oncomplete = () => { db.close(); resolve(result); };
      tx.onabort = tx.onerror = () => { db.close(); reject(new Error('Synthetic IDB transaction failed')); };
    };
  }), { name, store, key, value, write });
}
const draft = (ownerId, textBoxes = [], lines = [], baseRevision = 0) => ({
  ownerId, lines, textBoxes, images: [], hasPendingChanges: true, baseRevision, updatedAt: Date.now(),
});
const line = () => ({ id: randomUUID(), points: [{ x: 250, y: 300 }, { x: 320, y: 340 }], color: '#000000', strokeWidth: 2, status: 'new' });
async function deviceWorkspace(page, owner) {
  return page.evaluate(owner => new Promise((resolve, reject) => {
    const open = indexedDB.open('flownote-device-workspaces', 1);
    open.onerror = () => reject(new Error('Existing OFF workspace unavailable'));
    open.onsuccess = () => {
      const db = open.result, tx = db.transaction('workspaces'), r = tx.objectStore('workspaces').get(owner);
      let value; r.onsuccess = () => { value = r.result; };
      tx.oncomplete = () => { db.close(); resolve(value); };
      tx.onabort = tx.onerror = () => { db.close(); reject(new Error('Existing OFF workspace read failed')); };
    };
  }), owner);
}
async function ready(page, id) {
  await page.goto(web + '/canvas/' + id);
  await page.waitForFunction(() => document.querySelector('[data-testid="canvas-input-surface"]')?.getAttribute('data-ready') === 'true');
}
const status = page => page.locator('[data-testid="canvas-save-status"]:visible');
async function saved(page) { await until(async () => await status(page).getAttribute('data-save-state') === 'saved', 'saved state'); }
async function fileAction(page, name) {
  const direct = page.getByRole('button', { name, exact: true });
  if (await direct.count() && await direct.first().isVisible()) await direct.first().click();
  else {
    await page.getByRole('button', { name: '파일 동작', exact: true }).click();
    await page.getByRole('menuitem', { name, exact: true }).click();
  }
}
async function draw(page) {
  const toggle = page.getByTestId('canvas-tool-menu-toggle');
  if (await toggle.isVisible()) await toggle.click();
  const pen = page.getByRole('button', { name: '펜', exact: true });
  if (await pen.isVisible()) await pen.click();
  await page.keyboard.press('Escape');
  const box = await page.getByTestId('canvas-input-surface').boundingBox();
  assert(box, 'Actual canvas input bounds');
  const x = box.x + box.width * 0.55, y = box.y + Math.min(box.height * 0.6, 400);
  await page.mouse.move(x, y); await page.mouse.down();
  await page.mouse.move(x + 35, y + 25, { steps: 6 }); await page.mouse.up();
}
async function entryHash(page) {
  const html = await (await fetch(web, { cache: 'no-store' })).text();
  const entry = html.match(/<script\b[^>]*type="module"[^>]*src="([^"]+)"/)?.[1];
  assert(entry, 'Staging entry');
  const response = await fetch(new URL(entry, web), { cache: 'no-store' }); assert(response.ok);
  const expected = createHash('sha256').update(Buffer.from(await response.arrayBuffer())).digest('hex');
  const actual = await page.evaluate(async entry => {
    const script = document.querySelector('script[type="module"][src]');
    if (new URL(script?.getAttribute('src'), location.href).href !== new URL(entry, location.href).href) throw new Error('Stale native canvas entry');
    const r = await fetch(entry, { cache: 'force-cache' }); if (!r.ok) throw new Error('Native entry unavailable');
    return [...new Uint8Array(await crypto.subtle.digest('SHA-256', await r.arrayBuffer()))].map(x => x.toString(16).padStart(2, '0')).join('');
  }, entry);
  assert.equal(actual, expected, 'Native executing entry must equal current staging');
  return expected;
}

/** Published app renderer only; synthetic staging actors and canvas IDs. */
export async function verifyCanvasSafety(initialPage, { restart, confirmDeviceMode } = {}) {
  let page = initialPage, phase = 'create synthetic actors', a, b, blocked = false;
  const ids = [], phases = [], external = [];
  let watchOriginal = null, originalWrites = 0, deviceRequests = null;
  const observe = r => {
    const url = new URL(r.url());
    if (/wiktionary|generativelanguage|opendict/.test(url.hostname)) external.push(url.hostname);
    if (deviceRequests && (/\/web-api\//.test(url.pathname) || /\.railway\.app$/.test(url.hostname))) deviceRequests.push(r.method() + ' ' + url.pathname);
    const body = r.postData() ?? '';
    if (watchOriginal && r.method() === 'POST' && body.includes(watchOriginal)
      && (/\/api\/canvas\/save/.test(url.pathname) || /canvas:(?:save|line-start|line-points|line-end)/.test(body))) originalWrites++;
  };
  const bind = p => { p.setDefaultTimeout(45000); p.on('request', observe); };
  bind(page);
  const replacePage = async id => {
    assert(restart, 'Native process restart callback required');
    page.off('request', observe); page = await restart(); bind(page); await ready(page, id);
    assert.equal(await entryHash(page), executingEntrySha256, 'Restarted entry');
  };
  const rejectApi = route => route.abort('internetdisconnected');
  const block = async () => { await page.route('**/web-api/**', rejectApi); await page.route('https://*.up.railway.app/**', rejectApi); blocked = true; };
  const unblock = async () => { await page.unroute('**/web-api/**', rejectApi); await page.unroute('https://*.up.railway.app/**', rejectApi); blocked = false; };
  let executingEntrySha256;
  try {
    a = await actor(); b = await actor();
    const create = async title => { const item = await request('/api/canvas/documents', 'POST', { title }, a); ids.push(item.id); return item.id; };
    const id = await create('Synthetic native owner draft');
    const conflictId = await create('Synthetic native conflict');
    const legacyId = await create('Synthetic native authorized legacy');
    const load = id => request('/api/canvas/load?canvasId=' + id, 'GET', undefined, a);
    const metadata = id => request('/api/canvas/metadata?canvasId=' + id, 'GET', undefined, a);
    await login(page, a); executingEntrySha256 = await entryHash(page);

    phase = 'delayed owner A draft and denied account B';
    console.log('Canvas safety: ' + phase);
    await ready(page, id); await saved(page); await block();
    await draw(page);
    await until(async () => (await storage(page, cloudDb(a.user.id), 'drafts', id))?.hasPendingChanges, 'owner A durable pending draft');
    const owned = await storage(page, cloudDb(a.user.id), 'drafts', id);
    assert.equal(owned.ownerId, a.user.id); assert(owned.lines.length > 0);
    await storage(page, 'flownote-canvas', 'drafts', id, { ...owned, ownerId: undefined }, true);
    // Change the synthetic account while the original hook/timers still exist.
    const session = await page.context().newCDPSession(page);
    assert((await session.send('Network.setCookie', { name: '__Host-flownote_session', value: b.token, url: web, httpOnly: true, secure: true, sameSite: 'Strict' })).success);
    await session.detach();
    await page.evaluate(user => localStorage.setItem('flownote_auth_user', JSON.stringify(user)), b.user);
    await unblock(); await ready(page, id);
    await until(async () => await status(page).getAttribute('data-save-state') === 'failed', 'foreign canvas denied');
    assert.equal(await page.getByTestId('canvas-render-surface').getAttribute('data-visible-line-count'), '0');
    assert.equal(await storage(page, cloudDb(b.user.id), 'drafts', id), null);
    assert.equal(await storage(page, cloudDb(b.user.id), 'operations', 'legacyMigrated:' + id), null);
    assert((await storage(page, cloudDb(a.user.id), 'drafts', id)).lines.length > 0);
    assert.equal((await load(id)).lines.length, 0, 'A pending draft must not upload under B');
    phases.push('delayed-owner-draft/account-denied/no-legacy-leak');

    phase = 'authorized return and native process restart';
    console.log('Canvas safety: ' + phase);
    await login(page, a); await ready(page, id);
    await until(async () => (await load(id)).lines.length > 0, 'owner A recovered draft reaches server'); await saved(page);
    await replacePage(id); await saved(page);
    assert(Number(await page.getByTestId('canvas-render-surface').getAttribute('data-visible-line-count')) > 0);
    phases.push('owner-return/cloud-save/native-restart');

    phase = 'authorized legacy migration';
    console.log('Canvas safety: ' + phase);
    const legacy = draft(undefined, [], [line()], (await metadata(legacyId)).revision);
    await page.goto(web + '/canvas'); await storage(page, 'flownote-canvas', 'drafts', legacyId, legacy, true);
    await ready(page, legacyId); await until(async () => (await load(legacyId)).lines.length === 1, 'authorized legacy upload'); await saved(page);
    assert.equal(await storage(page, cloudDb(a.user.id), 'operations', 'legacyMigrated:' + legacyId), true);
    assert.deepEqual(await storage(page, 'flownote-canvas', 'drafts', legacyId), legacy, 'Legacy original preserved');
    phases.push('authorized-legacy-migration/original-preserved');

    phase = 'conflict blocks save/flush/stream and preserves base revision';
    console.log('Canvas safety: ' + phase);
    const box = { id: randomUUID(), x: 20, y: 180, width: 240, height: 80, text: 'Remote current content' };
    await request('/api/canvas/save', 'POST', { canvasId: conflictId, mutationId: randomUUID(), payload: { addedTextBoxes: [box] } }, a);
    const remote = await load(conflictId), remoteRevision = (await metadata(conflictId)).revision;
    assert(Number.isSafeInteger(remoteRevision) && remoteRevision > 0);
    await page.goto(web + '/canvas');
    const base = remoteRevision - 1;
    const local = draft(a.user.id, [{ ...box, text: 'Local pending content', status: 'modified' }], [], base);
    await storage(page, cloudDb(a.user.id), 'drafts', conflictId, local, true);
    const queued = { id: randomUUID(), mutationId: randomUUID(), canvasId: conflictId, payload: { modifiedTextBoxes: local.textBoxes }, createdAt: Date.now(), attempts: 0, nextAttemptAt: 0, priority: 40, baseRevision: base };
    await storage(page, cloudDb(a.user.id), 'operations', 'retryQueue', [queued], true);
    watchOriginal = conflictId;
    await ready(page, conflictId);
    await until(async () => await status(page).getAttribute('data-save-state') === 'conflict', 'known revision conflict');
    await fileAction(page, '캔버스 저장'); await draw(page);
    await page.evaluate(() => window.dispatchEvent(new Event('pagehide'))); await pause(1800);
    assert.equal(originalWrites, 0, 'Conflict must block native HTTP/polling save and line stream');
    assert.equal((await storage(page, cloudDb(a.user.id), 'drafts', conflictId)).baseRevision, base);
    assert.deepEqual(await load(conflictId), remote, 'Remote original and revision unchanged');
    assert.equal((await metadata(conflictId)).revision, remoteRevision);
    await page.reload(); await until(async () => await status(page).getAttribute('data-save-state') === 'conflict', 'conflict survives reload');
    await fileAction(page, '초안을 새 캔버스로 복구');
    await until(() => new URL(page.url()).pathname !== '/canvas/' + conflictId, 'separate recovery copy route');
    const copyId = new URL(page.url()).pathname.split('/').at(-1); assert(copyId && copyId !== conflictId); ids.push(copyId);
    await saved(page);
    let copy = await load(copyId);
    assert.equal(copy.textBoxes.find(item => item.id === box.id)?.text, 'Local pending content'); assert(copy.lines.length > 0);
    assert.deepEqual(await load(conflictId), remote); assert.equal((await metadata(conflictId)).revision, remoteRevision); assert.equal(originalWrites, 0);
    const before = copy.lines.length; await draw(page);
    await until(async () => (await load(copyId)).lines.length > before, 'recovered copy remains editable'); await saved(page);
    await page.reload(); await saved(page); copy = await load(copyId);
    assert.equal(copy.textBoxes.find(item => item.id === box.id)?.text, 'Local pending content');
    assert.equal(await storage(page, cloudDb(a.user.id), 'drafts', conflictId), null);
    assert(!(await storage(page, cloudDb(a.user.id), 'operations', 'retryQueue') ?? []).some(item => item.canvasId === conflictId));
    assert.deepEqual(await load(conflictId), remote); assert.equal((await metadata(conflictId)).revision, remoteRevision); watchOriginal = null;
    phases.push('conflict-zero-original-writes/base-preserved/separate-copy/reload-editable');

    phase = 'existing device database and native restart';
    console.log('Canvas safety: ' + phase);
    await page.goto(web + '/settings');
    if (confirmDeviceMode) await confirmDeviceMode(page);
    else {
      page.once('dialog', dialog => dialog.accept());
      await page.getByRole('switch', { name: '앱 동기화', exact: true }).click();
    }
    await until(async () => await page.getByRole('switch', { name: '앱 동기화', exact: true }).getAttribute('aria-checked') === 'false', 'OFF snapshot committed');
    deviceRequests = [];
    const snapshot = (await deviceWorkspace(page, a.user.id)).canvasContents.find(item => item.id === copyId);
    assert(snapshot && Number.isSafeInteger(snapshot.revision));
    // Existing OFF draft namespace must remain readable. Acknowledged drafts are
    // intentionally removed; the durable document lives in device-workspaces.
    const previousDeviceDraft = draft(a.user.id, snapshot.textBoxes.map(item => ({ ...item, status: 'unchanged' })),
      [...snapshot.lines.map(item => ({ ...item, status: 'unchanged' })), line()], snapshot.revision);
    await storage(page, `flownote-canvas-device:${a.user.id}`, 'drafts', copyId, previousDeviceDraft, true);
    await ready(page, copyId); await saved(page);
    await until(async () => (await deviceWorkspace(page, a.user.id)).canvasContents.find(item => item.id === copyId)?.lines.length > snapshot.lines.length, 'existing OFF draft restored into device document');
    const localBefore = Number(await page.getByTestId('canvas-render-surface').getAttribute('data-visible-line-count'));
    await draw(page); await saved(page);
    await until(async () => (await deviceWorkspace(page, a.user.id)).canvasContents.find(item => item.id === copyId)?.lines.length > localBefore, 'OFF document durable acknowledgement');
    await until(async () => await storage(page, `flownote-canvas-device:${a.user.id}`, 'drafts', copyId) === null, 'acknowledged OFF draft cleared');
    await replacePage(copyId); await saved(page);
    assert(Number(await page.getByTestId('canvas-render-surface').getAttribute('data-visible-line-count')) > localBefore);
    const durable = await storage(page, 'flownote-device-workspaces', 'workspaces', a.user.id);
    assert(durable.canvasContents.find(item => item.id === copyId).lines.length > localBefore);
    assert.equal(await storage(page, `flownote-canvas-device:${a.user.id}`, 'drafts', copyId), null);
    assert(!(await storage(page, `flownote-canvas-device:${a.user.id}`, 'operations', 'retryQueue') ?? []).some(item => item.canvasId === copyId));
    assert.equal(await page.evaluate(owner => localStorage.getItem('flownote.device-mode:' + owner), a.user.id), 'device');
    assert.deepEqual(deviceRequests, [], 'OFF and native restart must not contact application servers');
    assert.deepEqual(await load(conflictId), remote);
    assert.equal((await load(copyId)).lines.length, copy.lines.length, 'OFF edit stays device-only');
    phases.push('existing-device-db/offline-edit/native-restart/server-requests-zero');
    assert.deepEqual(external, []);
    console.log('PASS native canvas safety: ' + JSON.stringify({ executingEntrySha256, phases, originalConflictWrites: originalWrites, offlineServerRequests: deviceRequests.length, externalDictionaryRequests: external.length }));
    return { page, executingEntrySha256, phases, originalConflictWrites: originalWrites, offlineServerRequests: deviceRequests.length };
  } catch (error) {
    if (!page.isClosed() && phase === 'existing device database and native restart') {
      const alerts = await page.getByRole('alert').allTextContents();
      console.error('Native canvas OFF transition diagnostic: ' + JSON.stringify({ alerts }));
    }
    throw new Error(`Native canvas safety phase '${phase}': ${error.message}`);
  } finally {
    if (blocked && !page.isClosed()) await unblock();
    if (!page.isClosed()) {
      page.off('request', observe);
      if (a) await page.evaluate(owner => localStorage.setItem('flownote.device-mode:' + owner, 'cloud'), a.user.id);
      await page.goto(web + '/settings').catch(() => {});
    }
    for (const id of ids) await request('/api/canvas/documents/' + id, 'DELETE', undefined, a);
    for (const user of [a, b].filter(Boolean)) {
      await request('/api/users/logout-all', 'POST', undefined, user);
      const revoked = await fetch(api + '/api/users/me', { headers: { Authorization: `Bearer ${user.token}` }, signal: AbortSignal.timeout(30000) });
      assert.equal(revoked.status, 401, 'Synthetic native actor sessions revoked');
    }
  }
}
