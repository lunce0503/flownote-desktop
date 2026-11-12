'use strict';
const { app, BrowserWindow, Menu, shell, dialog, session, powerMonitor, Notification } = require('electron');
const path = require('node:path');
const { existsSync } = require('node:fs');
const { spawn } = require('node:child_process');
const { PROFILES, profileForArgs, trustedUrl, externalUrl, safeDownloadName } = require('./policy.cjs');
const { UpdateClient } = require('./updater.cjs');

const profile = profileForArgs(process.argv);
const origin = PROFILES[profile];
app.setName(profile === 'staging' ? 'Flownote Staging' : 'Flownote');
app.setPath('userData', path.join(app.getPath('appData'), profile === 'staging' ? 'Flownote-Staging' : 'Flownote'));
app.enableSandbox();
let window;
let updater;
let promptedVersion;
let updateStatusItem;
async function updateDetails() {
  if (!updater) return;
  const state = updater.state;
  const labels = { idle: '확인 전', checking: '업데이트 확인 중', downloading: `다운로드 ${state.progress || 0}%`, ready: `${state.version} 다운로드 완료`, current: '최신 버전', error: '실패 · 다시 확인으로 재시도' };
  const history = state.history.slice(-10).reverse().map(item => `${item.at.slice(0, 16).replace('T', ' ')} · ${item.status}${item.version ? ` ${item.version}` : ''}`).join('\n');
  const detail = `설치 버전: ${app.getVersion()}\n채널: ${profile}\n상태: ${labels[state.status]}\n${state.notes?.map(note => `• ${note}`).join('\n') || ''}\n\n설치 확인 전에는 실행 중인 앱을 교체하지 않습니다.\n포터블은 ZIP 압축을 직접 해제해야 합니다.\n\n최근 이력(UTC)\n${history}`;
  const ready = state.status === 'ready';
  const result = await dialog.showMessageBox(window, { type: 'info', title: 'Flownote 업데이트', message: labels[state.status], detail,
    buttons: ready ? [updater.kind === 'installer' ? '설치 진행' : 'ZIP 위치 열기', '나중에'] : ['다시 확인', '닫기'], defaultId: ready ? 1 : 0, cancelId: 1 });
  if (result.response !== 0) return;
  if (!ready) { void updater.check(); return; }
  try {
    const file = await updater.verifyReady();
    if (updater.kind === 'portable') { shell.showItemInFolder(file); return; }
    const confirmation = await dialog.showMessageBox(window, { type: 'question', title: 'Flownote 업데이트 설치',
      message: '저장을 완료한 뒤 앱을 종료하고 설치할까요?', detail: '기존 로그인·초안·자료는 유지됩니다. 설치 프로그램과 Windows 보안 확인이 표시될 수 있습니다.', buttons: ['종료하고 설치', '취소'], defaultId: 1, cancelId: 1 });
    if (confirmation.response !== 0) return;
    await updater.verifyReady();
    const child = spawn(file, [], { detached: true, stdio: 'ignore' });
    child.once('error', () => { void dialog.showMessageBox(window, { type: 'error', message: '설치 프로그램을 실행하지 못했습니다. 업데이트 메뉴에서 재시도해 주세요.' }); });
    child.once('spawn', () => { child.unref(); app.quit(); });
  } catch { void dialog.showMessageBox(window, { type: 'error', message: '설치 파일 검증에 실패했습니다.', detail: '업데이트 메뉴에서 다시 확인해 주세요.' }); }
}
function setupUpdates() {
  if (!app.isPackaged || process.platform !== 'win32') return;
  updater = new UpdateClient({ directory: path.join(app.getPath('userData'), 'updates'), channel: profile, version: app.getVersion(),
    kind: existsSync(path.join(process.resourcesPath, 'installed-by-nsis')) ? 'installer' : 'portable',
    // Node fetch exposes manual 302 responses. Electron net.fetch cancels them
    // before policy can inspect GitHub's release CDN redirect.
    onState(state) {
      const labels = { checking: '업데이트 확인 중…', downloading: `업데이트 다운로드 ${state.progress}%`, ready: '업데이트 준비됨 · 설치 확인', error: '업데이트 실패 · 재시도', current: '최신 버전 · 업데이트 이력' };
      if (updateStatusItem) updateStatusItem.label = labels[state.status] || '업데이트 상태 및 이력';
      if (window && !window.isDestroyed()) window.setProgressBar(state.status === 'downloading' ? state.progress / 100 : -1);
      if (state.status === 'ready' && promptedVersion !== state.version) {
        promptedVersion = state.version;
        if (Notification.isSupported()) { const notification = new Notification({ title: 'Flownote 업데이트 준비됨', body: `${state.version} 다운로드·검증 완료. 도움말 → 업데이트에서 설치하세요.` }); notification.on('click', () => { void updateDetails(); }); notification.show(); }
      }
    },
  });
  setTimeout(() => { void updater.check({ force: false }); }, 3000).unref();
  setInterval(() => { void updater.check({ force: false }); }, 60 * 60 * 1000).unref();
  powerMonitor.on('resume', () => { void updater.check({ force: false }); });
  app.on('browser-window-focus', () => { void updater.check({ force: false }); });
}

function openExternal(url) {
  if (externalUrl(url)) void shell.openExternal(url).catch(() => {});
}
function goBack() {
  if (!window || window.isDestroyed()) return;
  void window.webContents.executeJavaScript("(()=>{const close=document.querySelector('[data-android-menu-close]');if(close){close.click();return true;}return false;})()")
    .then(handled => { if (!handled && window && !window.isDestroyed() && window.webContents.navigationHistory.canGoBack()) window.webContents.navigationHistory.goBack(); })
    .catch(() => {});
}
function showConnectionError() {
  if (!window || window.isDestroyed()) return;
  const html = `<!doctype html><html lang="ko"><meta charset="utf-8"><meta http-equiv="Content-Security-Policy" content="default-src 'none'; style-src 'unsafe-inline'"><title>Flownote</title><style>body{margin:0;display:grid;place-items:center;min-height:100vh;background:#f7f3e8;color:#171714;font-family:system-ui}main{max-width:440px;padding:32px}h1{font-size:28px}p{line-height:1.7;color:#706b60}a{display:inline-block;padding:14px 24px;border-radius:12px;background:#171714;color:#f7f3e8;text-decoration:none}</style><main><h1>연결을 확인해 주세요</h1><p>인터넷에 연결한 뒤 다시 시도해 주세요.<br>저장된 로그인과 로컬 초안은 유지됩니다.</p><a href="${origin}">다시 시도</a></main></html>`;
  void window.loadURL(`data:text/html;base64,${Buffer.from(html).toString('base64')}`).catch(() => {});
}
function loadHome() { if (window && !window.isDestroyed()) void window.loadURL(origin).catch(() => {}); }

function createWindow() {
  window = new BrowserWindow({
    width: 1280, height: 900, minWidth: 700, minHeight: 560,
    title: profile === 'staging' ? 'Flownote · Staging' : 'Flownote',
    backgroundColor: '#f7f3e8', show: false, icon: path.join(__dirname, 'build/icon.png'),
    webPreferences: { nodeIntegration: false, contextIsolation: true, sandbox: true, webviewTag: false, webSecurity: true, allowRunningInsecureContent: false, navigateOnDragDrop: false },
  });
  window.webContents.setUserAgent(`${window.webContents.getUserAgent()} FlownoteDesktop/${app.getVersion()}`);
  window.once('ready-to-show', () => window.show());
  window.webContents.on('will-navigate', (event, url) => {
    if (!trustedUrl(url, origin)) { event.preventDefault(); openExternal(url); }
  });
  window.webContents.on('will-redirect', (event, url) => {
    if (!trustedUrl(url, origin)) event.preventDefault();
  });
  window.webContents.setWindowOpenHandler(({ url }) => {
    if (trustedUrl(url, origin)) void window.loadURL(url).catch(() => {});
    else openExternal(url);
    return { action: 'deny' };
  });
  window.webContents.on('will-attach-webview', event => event.preventDefault());
  window.webContents.on('did-fail-load', (_event, code, _description, _url, mainFrame) => {
    if (mainFrame && code !== -3) showConnectionError();
  });
  window.webContents.on('render-process-gone', showConnectionError);
  window.on('closed', () => { window = null; });
  window.webContents.on('page-title-updated', (event, title) => {
    event.preventDefault();
    window.setTitle(`${title || 'Flownote'}${profile === 'staging' ? ' · Staging' : ''} — Flownote`);
  });
  loadHome();
}

if (!app.requestSingleInstanceLock()) app.quit();
else {
  app.on('second-instance', () => {
    if (!window) return;
    if (window.isMinimized()) window.restore();
    window.show(); window.focus();
  });
  app.whenReady().then(() => {
    app.setAppUserModelId('com.flownote.desktop');
    session.defaultSession.setPermissionRequestHandler((contents, permission, callback) => {
      callback(trustedUrl(contents.getURL(), origin) && permission === 'clipboard-sanitized-write');
    });
    session.defaultSession.setPermissionCheckHandler((_contents, permission, requestingOrigin) =>
      trustedUrl(requestingOrigin, origin) && permission === 'clipboard-sanitized-write');
    session.defaultSession.on('will-download', (event, item, contents) => {
      if (!contents || !trustedUrl(contents.getURL(), origin)) { event.preventDefault(); return; }
      item.setSaveDialogOptions({ title: 'Flownote 파일 저장', defaultPath: path.join(app.getPath('downloads'), safeDownloadName(item.getFilename())) });
      item.once('done', (_event, state) => {
        if (state === 'interrupted' && window && !window.isDestroyed()) void dialog.showMessageBox(window, { type: 'error', message: '다운로드를 완료하지 못했습니다.', detail: '연결을 확인한 뒤 다시 시도해 주세요.' });
      });
    });
    Menu.setApplicationMenu(Menu.buildFromTemplate([
      { label: 'Flownote', submenu: [{ label: '홈', accelerator: 'CmdOrCtrl+H', click: loadHome }, { type: 'separator' }, { role: 'quit', label: '종료' }] },
      { label: '편집', submenu: [{ role: 'undo' }, { role: 'redo' }, { type: 'separator' }, { role: 'cut' }, { role: 'copy' }, { role: 'paste' }, { role: 'selectAll' }] },
      { label: '이동', submenu: [{ label: '뒤로', accelerator: 'Alt+Left', click: goBack }, { label: '앞으로', accelerator: 'Alt+Right', click: () => { if (window?.webContents.navigationHistory.canGoForward()) window.webContents.navigationHistory.goForward(); } }] },
      { label: '보기', submenu: [{ role: 'reload', label: '새로고침' }, { role: 'forceReload', label: '캐시 없이 새로고침' }, { type: 'separator' }, { role: 'resetZoom' }, { role: 'zoomIn' }, { role: 'zoomOut' }, { role: 'togglefullscreen', label: '전체 화면' }] },
      { label: '도움말', submenu: [{ id: 'app-update-status', label: '업데이트 상태 및 이력', click: () => { void updateDetails(); } },
        { label: '릴리즈 및 설치 안내', click: () => openExternal(`${origin}/windows.html`) }] },
    ]));
    createWindow();
    updateStatusItem = Menu.getApplicationMenu().getMenuItemById('app-update-status');
    setupUpdates();
  });
  app.on('window-all-closed', () => app.quit());
}
