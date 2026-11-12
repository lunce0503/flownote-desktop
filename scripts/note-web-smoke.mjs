import assert from 'node:assert/strict';

// Keep the same three real CDP inputs and their connection order. Android WebView
// can finish composition during host round trips even in a plain contenteditable.
// Pipeline its commands without sleeps, synthetic DOM events or weaker assertions.
export async function sendKoreanComposition(cdp, pipelined = false) {
  const inputs = [
    ['Input.imeSetComposition', { text: '한', selectionStart: 1, selectionEnd: 1 }],
    ['Input.imeSetComposition', { text: '한글', selectionStart: 2, selectionEnd: 2 }],
    ['Input.insertText', { text: '한글 ' }],
  ];
  if (pipelined) await Promise.all(inputs.map(([method, params]) => cdp.send(method, params)));
  else for (const [method, params] of inputs) await cdp.send(method, params);
}

/** Real published Electron/Android WebView input; synthetic cloud staging notes only. */
export async function verifyNoteEditing(page, token, { androidWebView = false } = {}) {
  const web = 'https://flownote-react-staging.vercel.app';
  const api = 'https://flownote-api-staging.up.railway.app';
  const ids = [];
  const inlineMath = async latex => {
    try { await page.waitForFunction(value => Array.from(document.querySelectorAll('[data-type="inline-math"]')).some(node => node.getAttribute('data-latex') === value), latex); }
    catch (error) {
      const state=await page.evaluate(()=>{const editor=document.querySelector('[role="textbox"][aria-label="노트 편집"]'),pm=editor&&Reflect.get(editor,'editor'),dialog=document.querySelector('dialog[aria-label="수식 편집"]');return {inline:Array.from(document.querySelectorAll('[data-type="inline-math"]')).map(n=>n.getAttribute('data-latex')),block:Array.from(document.querySelectorAll('[data-type="block-math"]')).map(n=>n.getAttribute('data-latex')),doc:pm?.getJSON(),selection:pm?[pm.state.selection.from,pm.state.selection.to]:null,active:document.activeElement?.getAttribute('aria-label'),dialogOpen:dialog?.open,draft:dialog?.querySelector('textarea')?.value,saveStatus:document.querySelector('[data-testid="note-save-status"]')?.textContent};});
      throw new Error(`Native inline math missing; expected=${JSON.stringify(latex)}; syntheticState=${JSON.stringify(state)}\n${error.stack}`);
    }
  };
  const diagnostics = editor => editor.evaluate(node => ({
    text: node.textContent, active: document.activeElement?.getAttribute('aria-label'),
    domSelection: [getSelection()?.anchorOffset, getSelection()?.focusOffset],
    pmSelection: Reflect.get(node, 'editor') ? [Reflect.get(node, 'editor').state.selection.from, Reflect.get(node, 'editor').state.selection.to] : null,
    composing: Reflect.get(node, 'editor')?.view.composing,
    ime: Reflect.get(node, '__flownoteImeCounts'),
    keys: Reflect.get(node, '__flownoteNativeKeys'),
    saveStatus: document.querySelector('[data-testid="note-save-status"]')?.textContent,
  }));
  const saved = async () => {
    try { await page.waitForFunction(() => document.querySelector('[data-testid="note-save-status"]')?.textContent?.trim() === '서버에 저장됨'); }
    catch (error) { throw new Error(`Native note save failed: ${JSON.stringify(await diagnostics(page.getByRole('textbox', { name: '노트 편집', exact: true })))}\n${error.stack}`); }
  };
  const text = async (editor, expected) => {
    try { await page.waitForFunction(value => document.querySelector('[role="textbox"][aria-label="노트 편집"]')?.textContent === value, expected); }
    catch (error) { throw new Error(`Native note text mismatch; expected=${JSON.stringify(expected)}; actual=${JSON.stringify(await diagnostics(editor))}\n${error.stack}`); }
    assert.equal(await editor.textContent(), expected);
  };
  const create = async () => {
    const previous = page.url();
    await page.getByRole('button', { name: '새 노트', exact: true }).first().click();
    await page.waitForURL(url => /\/blog\/[a-z0-9-]+$/.test(url.pathname) && url.href !== previous);
    ids.push(page.url().split('/').at(-1));
    const editor = page.getByRole('textbox', { name: '노트 편집', exact: true });
    await editor.waitFor();
    await editor.evaluate(node => {
      const keys = []; Object.assign(node, { __flownoteNativeKeys: keys });
      for (const type of ['keydown', 'keyup']) node.addEventListener(type, event => {
        if (!['Home', 'End', 'Delete', 'ArrowRight'].includes(event.key)) return;
        const editor = Reflect.get(node, 'editor');
        keys.push({ type, key: event.key, dom: [getSelection()?.anchorOffset, getSelection()?.focusOffset], pm: editor ? [editor.state.selection.anchor, editor.state.selection.head] : null, active: document.activeElement?.getAttribute('aria-label') });
        if (keys.length > 40) keys.shift();
      }, true);
    });
    return editor;
  };
  try {
    await page.goto(web + '/blog');
    const editor = await create();
    assert.equal(await page.getByLabel('노트 제목').inputValue(), '제목 없음');
    await page.getByLabel('노트 제목').fill('Synthetic native note input');
    await editor.pressSequentially('alpha beta gamma');
    await editor.press('Home'); for (let i = 0; i < 6; i++) await editor.press('ArrowRight');
    await editor.pressSequentially('new '); await text(editor, 'alpha new beta gamma');
    await editor.press('ControlOrMeta+z'); await text(editor, 'alpha beta gamma');
    await editor.press('ControlOrMeta+Shift+z'); await text(editor, 'alpha new beta gamma');
    await editor.press('Home'); for (let i = 0; i < 6; i++) await editor.press('ArrowRight');
    for (let i = 0; i < 4; i++) await editor.press('Shift+ArrowRight');
    await editor.evaluate(node => {
      const counts = { ends: 0, events: [] }; Object.assign(node, { __flownoteImeCounts: counts });
      for (const type of ['compositionstart', 'compositionupdate', 'compositionend', 'focusout']) node.addEventListener(type, event => {
        if (type === 'compositionend') counts.ends++;
        counts.events.push({ type, data: event.data, text: node.textContent, active: document.activeElement?.getAttribute('aria-label') });
      });
    });
    const cdp = await page.context().newCDPSession(page);
    await sendKoreanComposition(cdp, androidWebView);
    try { await page.waitForFunction(() => Reflect.get(document.querySelector('[role="textbox"][aria-label="노트 편집"]'), '__flownoteImeCounts')?.ends === 1); }
    catch (error) { throw new Error(`Native IME commit failed: ${JSON.stringify(await diagnostics(editor))}\n${error.stack}`); }
    const imeEvents = await editor.evaluate(node => Reflect.get(node, '__flownoteImeCounts').events);
    assert.equal(imeEvents.filter(event => event.type === 'compositionstart').length, 1);
    assert.deepEqual(imeEvents.filter(event => event.type === 'compositionupdate').slice(0, 2).map(event => event.data), ['한', '한글']);
    await text(editor, 'alpha 한글 beta gamma');
    assert.equal(await editor.evaluate(node => Reflect.get(node, '__flownoteImeCounts').ends), 1, 'Multi-step IME must finish once, with no duplicate commit');
    await cdp.detach();
    await text(editor, 'alpha 한글 beta gamma');
    assert.equal(await editor.evaluate(node => Reflect.get(node, '__flownoteImeCounts').ends), 1);
    console.log('PASS native note IME: exact middle replacement, 한→한글 provisional updates, one composition start/end');
    assert.equal(await editor.locator('p').count(), 1);
    await editor.press('End'); await editor.press('Backspace'); await editor.pressSequentially('!');
    await text(editor, 'alpha 한글 beta gamm!');
    await editor.press('Home'); await editor.press('Delete'); await text(editor, 'lpha 한글 beta gamm!');
    await editor.press('End'); await editor.press('Enter'); await editor.pressSequentially('second line');
    assert.equal(await editor.locator('p').count(), 2); await saved();
    await page.reload(); await editor.waitFor();
    assert((await editor.textContent()).includes('lpha 한글 beta gamm!')); assert((await editor.textContent()).includes('second line'));
    assert.equal(await page.getByRole('toolbar', { name: 'Markdown 서식' }).count(), 0);
    await editor.press('ControlOrMeta+End'); await editor.press('Enter'); await editor.pressSequentially('Inline $ x^2 $ end');
    await editor.locator('[data-type="inline-math"][data-latex="x^2"]').waitFor();
    await editor.press('End'); await editor.press('Enter'); await editor.pressSequentially('$$'); await editor.press('Enter');
    await editor.pressSequentially('x = 1'); await editor.press('Enter'); await editor.pressSequentially('y = 2'); await editor.press('Enter'); await editor.pressSequentially('$$');
    await editor.locator('[data-type="block-math"]').waitFor();
    assert.equal(await editor.locator('[data-type="block-math"]').getAttribute('data-latex'), 'x = 1\ny = 2');
    await editor.pressSequentially('Pair: $ \\fr'); await page.getByRole('group', { name: 'LaTeX 명령어 추천', exact: true }).waitFor();
    await editor.press('Tab'); await editor.pressSequentially('a'); await editor.press('ArrowRight'); await editor.press('ArrowRight');
    await editor.pressSequentially('b'); await editor.press('ArrowRight'); await editor.pressSequentially(' $');
    await inlineMath('\\frac{a}{b}');
    await page.getByRole('button', { name: '편집 도구', exact: true }).click();
    await page.getByRole('button', { name: '수식 추가', exact: true }).click();
    const dialog = page.getByRole('dialog', { name: '수식 편집', exact: true });
    await dialog.getByLabel('LaTeX 수식', { exact: true }).fill('\\sq');
    await dialog.getByRole('button', { name: /\\sqrt/ }).click();
    assert.equal(await dialog.getByLabel('LaTeX 수식', { exact: true }).inputValue(), '\\sqrt{}');
    await dialog.getByLabel('LaTeX 수식', { exact: true }).fill('\\sqrt{4}');
    await dialog.getByRole('button', { name: '수식 적용', exact: true }).click();
    await inlineMath('\\sqrt{4}'); await editor.press('End'); await editor.pressSequentially(' tail'); await saved();
    await page.reload(); await editor.locator('[data-type="block-math"]').waitFor();
    assert.equal(await editor.locator('[data-type="block-math"]').getAttribute('data-latex'), 'x = 1\ny = 2');
    assert.deepEqual(await editor.locator('[data-type="inline-math"]').evaluateAll(nodes => nodes.map(node => node.getAttribute('data-latex'))), ['x^2', '\\frac{a}{b}', '\\sqrt{4}']);
    await page.getByRole('button', { name: '편집 도구', exact: true }).click();
    await page.getByRole('button', { name: '원문', exact: true }).click();
    const source = page.getByLabel('Markdown 본문', { exact: true });
    assert.match(await source.inputValue(), /\$\$\nx = 1\ny = 2\n\$\$/);
    assert((await source.inputValue()).includes('Pair: $\\frac{a}{b}$ $\\sqrt{4}$ tail'));
    await page.getByRole('button', { name: '미리보기', exact: true }).click();
    await page.getByTestId('markdown-preview').locator('.katex-display').waitFor();
    assert.equal(await page.getByTestId('markdown-preview').locator('.katex').count(), 4);
    assert.equal(await page.getByTestId('markdown-preview').locator('.katex-error').count(), 0);
    await page.getByRole('button', { name: '편집', exact: true }).click();
    await create(); assert.notEqual(ids[0], ids[1]);
    assert(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth + 1));
    console.log('PASS native notes: both prompt-free creation actions, middle editing/selection replacement, Home/End/Delete/Backspace/Enter, undo/redo, CDP Korean composition, compact tools, $/multiline $$, suggestions/Tab caret, accessible math dialog, save/source/preview/reload');
  } finally {
    for (const id of ids) {
      const response = await fetch(`${api}/api/notes/${id}`, { method: 'DELETE', headers: { Authorization: `Bearer ${token}` }, signal: AbortSignal.timeout(30000) });
      assert(response.ok, `Synthetic native note cleanup: ${response.status}`);
    }
  }
}
