import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';

const web = 'https://flownote-react-staging.vercel.app';
const api = 'https://flownote-api-staging.up.railway.app';
const pause = milliseconds => new Promise(resolve => setTimeout(resolve, milliseconds));

async function request(route, token, method = 'GET', body) {
  const response = await fetch(api + route, {
    method, headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' },
    ...(body ? { body: JSON.stringify(body) } : {}), signal: AbortSignal.timeout(30000),
  });
  assert(response.ok, `Native note tools ${method} ${route}: ${response.status}`);
  const text = await response.text();
  return text ? JSON.parse(text) : null;
}

async function until(check, label) {
  for (let attempt = 0; attempt < 60; attempt++) {
    if (await check()) return;
    await pause(250);
  }
  throw new Error(`Native note tools timeout: ${label}`);
}

async function wordBounds(page, format) {
  return page.evaluate(format => {
    if (format === 'source') {
      const node = document.querySelector('textarea[aria-label="Markdown 본문"]');
      const style = getComputedStyle(node), box = node.getBoundingClientRect();
      const context = document.createElement('canvas').getContext('2d'); context.font = style.font;
      return { x: box.left + parseFloat(style.paddingLeft) + context.measureText('alpha ').width,
        y: box.top + parseFloat(style.paddingTop), width: context.measureText('bravo').width, height: parseFloat(style.lineHeight) };
    }
    const selector = format === 'code' ? '.cm-content' : format === 'live' ? '.note-live-content' : '.note-markdown';
    const walker = document.createTreeWalker(document.querySelector(selector), NodeFilter.SHOW_TEXT);
    while (walker.nextNode()) {
      const node = walker.currentNode, index = node.data.indexOf('bravo');
      if (index < 0) continue;
      const range = document.createRange(); range.setStart(node, index); range.setEnd(node, index + 5);
      const box = range.getBoundingClientRect();
      return { x: box.x, y: box.y, width: box.width, height: box.height };
    }
    throw new Error('Synthetic bravo glyph is missing');
  }, format);
}

/** Packaged-app note tools. Clipboard reads use the real OS clipboard via the caller. */
export async function verifyNoteTools(page, token, { readClipboard, touch = false, prepareGesture = async () => {} }) {
  assert.equal(typeof readClipboard, 'function');
  const cdp = touch ? await page.context().newCDPSession(page) : null;
  const send = async (type, points) => {
    assert(cdp);
    await cdp.send('Input.dispatchTouchEvent', { type, touchPoints: points });
    await page.evaluate(() => new Promise(resolve => requestAnimationFrame(resolve)));
  };
  try {
    for (const format of ['code', 'live', 'source', 'preview']) {
      const id = randomUUID();
      const original = format === 'code'
        ? 'alpha bravo charlie\r\n\r\nsecond line\r\n' + 'wide column '.repeat(100) + '\r\n'
        : 'alpha bravo charlie\n\nsecond line\n';
      const content = format === 'code'
        ? { format: 'code', version: 1, language: 'plaintext', encoding: 'utf-16le', text: original }
        : { format: 'markdown', version: 1, markdown: original };
      await request('/api/notes', token, 'POST', { id, title: `Native note tools ${format}`, content, revision: 1, client_id: randomUUID() });
      const read = () => request(`/api/notes/${id}`, token);
      try {
        await page.goto(`${web}/blog/${id}`);
        if (format === 'source') {
          await page.getByRole('button', { name: '편집 도구', exact: true }).click();
          await page.getByRole('button', { name: '원문', exact: true }).click();
        } else if (format === 'preview') await page.getByRole('button', { name: '미리보기', exact: true }).click();
        const surface = page.getByTestId('note-viewport'); await surface.waitFor();
        const editorSelector = format === 'code' ? '.cm-content' : format === 'source'
          ? 'textarea[aria-label="Markdown 본문"]' : format === 'live' ? '.note-live-content' : '.note-markdown';
        await page.locator(editorSelector).waitFor();
        await prepareGesture();
        if (touch) {
          const box = await surface.boundingBox(); assert(box);
          const origin = { x: box.x + box.width / 2, y: box.y + Math.min(150, box.height / 2), id: 1 };
          await send('touchStart', [origin]);
          const menu = page.getByTestId('note-quick-menu'); await menu.waitFor();
          const item = await menu.locator('[data-action="zoom-in"]').boundingBox(); assert(item);
          await send('touchMove', [{ x: item.x + item.width / 2, y: item.y + item.height / 2, id: 1 }]);
          assert.equal(await menu.locator('[data-action="zoom-in"]').getAttribute('data-selected'), 'true');
          await send('touchEnd', []);
          await until(async () => Number(await surface.getAttribute('data-zoom')) > 1, `${format} radial zoom`);
          const zoom = await surface.getAttribute('data-zoom');
          await send('touchStart', [origin]); await menu.waitFor(); await send('touchCancel', []);
          await menu.waitFor({ state: 'detached' }); assert.equal(await surface.getAttribute('data-zoom'), zoom);
          await page.getByRole('button', { name: '노트 확대율 초기화', exact: true }).click();
          const first = { x: origin.x - 30, y: origin.y, id: 1 }, second = { x: origin.x + 30, y: origin.y, id: 2 };
          await send('touchStart', [first]); await send('touchStart', [first, second]);
          await send('touchMove', [{ ...first, x: first.x - 25 }, { ...second, x: second.x + 25 }]);
          await send('touchEnd', []);
          assert(Number(await surface.getAttribute('data-zoom')) > 1, `${format} pinch zoom`);
        } else {
          await page.getByRole('button', { name: '노트 확대', exact: true }).click();
          assert(Number(await surface.getAttribute('data-zoom')) > 1);
        }
        await page.getByRole('button', { name: '노트 이동', exact: true }).click();
        const box = await surface.boundingBox(); assert(box);
        const beforePan = await surface.evaluate(node => node.scrollLeft);
        const start = { x: box.x + box.width * 0.7, y: box.y + Math.min(150, box.height / 2), id: 1 };
        if (touch) {
          await send('touchStart', [start]); await send('touchMove', [{ ...start, x: start.x - 55 }]); await send('touchEnd', []);
        } else {
          await page.mouse.move(start.x, start.y); await page.mouse.down();
          await page.mouse.move(start.x - 55, start.y, { steps: 5 }); await page.mouse.up();
        }
        const pan = await surface.evaluate(node => {
          const inner = node.querySelector('.cm-scroller,textarea');
          return { outer: node.scrollLeft, inner: inner?.scrollLeft ?? 0,
            innerWidth: inner?.clientWidth, innerScrollWidth: inner?.scrollWidth };
        });
        assert(pan.outer > beforePan || pan.inner > 0, `${format} horizontal pan moves the viewport: ${JSON.stringify(pan)}`);
        await page.getByRole('button', { name: '노트 확대율 초기화', exact: true }).click();
        await surface.evaluate(node => { node.scrollTop = 0; node.scrollLeft = 0; });
        await page.getByRole('button', { name: '노트 올가미', exact: true }).click();
        const word = await wordBounds(page, format);
        const points = [
          { x: word.x + 0.1, y: word.y - 2 }, { x: word.x + word.width - 0.1, y: word.y - 2 },
          { x: word.x + word.width - 0.1, y: word.y + word.height + 2 }, { x: word.x + 0.1, y: word.y + word.height + 2 },
          { x: word.x + 0.1, y: word.y - 2 },
        ].map(point => ({ ...point, id: 1 }));
        if (touch) {
          await send('touchStart', [points[0]]);
          for (const point of points.slice(1)) await send('touchMove', [point]);
          await send('touchEnd', []);
        } else {
          await page.mouse.move(points[0].x, points[0].y); await page.mouse.down();
          for (const point of points.slice(1)) await page.mouse.move(point.x, point.y);
          await page.mouse.up();
        }
        await until(async () => (await page.getByTestId('note-selection-status').textContent()).includes('5자 선택'), `${format} exact lasso range`);
        await page.getByRole('button', { name: '노트 선택 복사', exact: true }).click();
        await until(async () => (await page.getByTestId('note-selection-status').textContent()).includes('복사했습니다'), `${format} clipboard write`);
        assert.equal(await readClipboard(page), 'bravo');
        assert.deepEqual((await read()).content, content); assert.equal((await read()).revision, 1);
        if (format !== 'preview') {
          await page.getByRole('button', { name: '노트 편집', exact: true }).click();
          await page.keyboard.insertText('BETA');
          await until(async () => {
            const saved = (await read()).content; return (saved.text ?? saved.markdown).includes('alpha BETA charlie');
          }, `${format} selection replacement`);
          if (format === 'code') assert.deepEqual((await read()).content, { ...content, text: original.replace('bravo', 'BETA') });
        }
        const saved = (await read()).content;
        await page.reload(); await page.getByTestId('note-interaction').waitFor();
        assert.deepEqual((await read()).content, saved);
        assert(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth + 1));
        console.log(`PASS native note tools ${format}: exact lasso/OS copy, replacement/reload, viewport pan/zoom${touch ? '/pinch/radial hold/cancel' : ''} and source preservation`);
      } finally { await request(`/api/notes/${id}`, token, 'DELETE'); }
    }
  } finally { await cdp?.detach(); }
}

/** Focused mobile regression for one logical code line wrapping across many display rows. */
export async function verifyWrappedCodeNote(page, token, { readClipboard }) {
  const id = randomUUID();
  const text = Array.from({ length: 54 }, (_, index) => `word${index}`).join(' ');
  const content = { format: 'code', version: 1, language: 'plaintext', encoding: 'utf-16le', text };
  await request('/api/notes', token, 'POST', { id, title: 'Native wrapped code.txt', content, revision: 1, client_id: randomUUID() });
  const cdp = await page.context().newCDPSession(page);
  const send = async (type, points) => {
    await cdp.send('Input.dispatchTouchEvent', { type, touchPoints: points });
    await page.evaluate(() => new Promise(resolve => requestAnimationFrame(resolve)));
  };
  try {
    await page.goto(`${web}/blog/${id}`); await page.locator('.cm-line').first().waitFor();
    const options = page.getByLabel('코드 편집 도구 더보기', { exact: true });
    const compactOptions = await options.isVisible();
    if (compactOptions) await options.click();
    await page.getByRole('button', { name: '자동 줄바꿈', exact: true }).click();
    if (compactOptions) await options.click();
    const line = page.locator('.cm-line').first();
    await until(async () => (await line.boundingBox()).height > 150, '54 words wrap into many display rows');
    const box = await line.boundingBox();
    await page.getByRole('button', { name: '노트 올가미', exact: true }).click();
    const outline = [
      { x: box.x + 0.1, y: box.y - 1 }, { x: box.x + box.width - 0.1, y: box.y - 1 },
      { x: box.x + box.width - 0.1, y: box.y + box.height + 1 }, { x: box.x + 0.1, y: box.y + box.height + 1 },
      { x: box.x + 0.1, y: box.y - 1 },
    ].map(point => ({ ...point, id: 1 }));
    await send('touchStart', [outline[0]]);
    for (const point of outline.slice(1)) await send('touchMove', [point]);
    await send('touchEnd', []);
    await until(async () => (await page.getByTestId('note-selection-status').textContent()).includes(`${text.length}자 선택`), 'entire54-word range selected');
    await page.getByRole('button', { name: '노트 선택 복사', exact: true }).click();
    await until(async () => (await page.getByTestId('note-selection-status').textContent()).includes('복사했습니다'), 'wrapped code clipboard');
    assert.equal(await readClipboard(page), text);
    const surface = page.getByTestId('note-viewport');
    await page.getByRole('button', { name: '노트 확대', exact: true }).click();
    await page.getByRole('button', { name: '노트 이동', exact: true }).click();
    const before = await surface.evaluate(node => node.scrollLeft);
    assert(before > 0, 'Zoom creates a horizontal viewport offset');
    const bounds = await surface.boundingBox(), point = { x: bounds.x + bounds.width / 2, y: bounds.y + 80, id: 1 };
    await send('touchStart', [point]); await send('touchMove', [{ ...point, x: point.x + 35 }]); await send('touchEnd', []);
    assert(await surface.evaluate(node => node.scrollLeft) < before, 'Wrapped code touch pan moves viewport');
    const saved = await request(`/api/notes/${id}`, token);
    assert.deepEqual(saved.content, content); assert.equal(saved.revision, 1);
    console.log('PASS native wrapped code:54 words fully lasso-selected/OS-copied across visual rows, zoom/pan and API source/revision unchanged');
  } finally { await cdp.detach(); await request(`/api/notes/${id}`, token, 'DELETE'); }
}
