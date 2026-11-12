'use strict';
const { createHash, verify } = require('node:crypto');
const { readFile, mkdir, open, rename, unlink, stat, writeFile, readdir } = require('node:fs/promises');
const { createReadStream, readFileSync } = require('node:fs');
const path = require('node:path');
const { PROFILES } = require('./policy.cjs');
const PUBLIC_KEY = readFileSync(path.join(__dirname, 'update-public.pem'));
const MAX_ARTIFACT = 600 * 1024 * 1024;
function parts(version) {
  if (typeof version !== 'string' || !/^(0|[1-9]\d{0,5})\.(0|[1-9]\d{0,5})\.(0|[1-9]\d{0,5})$/.test(version)) throw new Error('Invalid release version');
  return version.split('.').map(Number);
}
function compareVersions(a, b) {
  const left = parts(a), right = parts(b);
  for (let index = 0; index < 3; index++) if (left[index] !== right[index]) return left[index] - right[index];
  return 0;
}
function validateManifest(value, channel) {
  if (!PROFILES[channel] || value.schema !== 1 || value.platform !== 'windows' || value.channel !== channel) throw new Error('Wrong update channel or platform');
  parts(value.version);
  if (!Array.isArray(value.notes) || value.notes.length > 30 || value.notes.some(note => typeof note !== 'string' || note.length > 1000)) throw new Error('Invalid release history');
  for (const [kind, label, extension] of [['installer', 'Setup', 'exe'], ['portable', 'Portable', 'zip']]) {
    const item = value.artifacts?.[kind];
    const expected = ['flownote', 'flownote-service'].map(repository =>
      `https://github.com/lunce0503/${repository}/releases/download/windows-v${value.version}/Flownote-${label}-${value.version}-x64.${extension}`);
    if (!item || !expected.includes(item.url) || !/^[a-f0-9]{64}$/.test(item.sha256) || !Number.isSafeInteger(item.size) || item.size < 1 || item.size > MAX_ARTIFACT) throw new Error('Invalid update artifact');
  }
  return value;
}
function verifyEnvelope(text, channel, publicKey = PUBLIC_KEY) {
  if (Buffer.byteLength(text) > 128 * 1024) throw new Error('Update feed too large');
  const envelope = JSON.parse(text);
  if (typeof envelope.payload !== 'string' || typeof envelope.signature !== 'string') throw new Error('Missing update signature');
  const payload = Buffer.from(envelope.payload, 'base64');
  if (!verify('sha256', payload, publicKey, Buffer.from(envelope.signature, 'base64'))) throw new Error('Invalid update signature');
  return validateManifest(JSON.parse(payload.toString('utf8')), channel);
}
function allowedRedirect(value) {
  const url = new URL(value);
  return url.protocol === 'https:' && !url.username && !url.password && !url.port &&
    ['github.com', 'release-assets.githubusercontent.com', 'objects.githubusercontent.com'].includes(url.hostname);
}
async function verifiedFile(file, artifact) {
  try {
    if ((await stat(file)).size !== artifact.size) return false;
    const hash = createHash('sha256');
    for await (const chunk of createReadStream(file)) hash.update(chunk);
    return hash.digest('hex') === artifact.sha256;
  } catch { return false; }
}
class UpdateClient {
  constructor({ directory, channel, version, kind, fetcher = globalThis.fetch, publicKey = PUBLIC_KEY, onState = () => {} }) {
    parts(version);
    if (!PROFILES[channel] || !['installer', 'portable'].includes(kind)) throw new Error('Invalid updater configuration');
    Object.assign(this, { directory, channel, version, kind, fetcher, publicKey, onState });
    this.state = { status: 'idle', history: [] };
    this.lastCheck = 0;
  }
  async setState(fields) {
    this.state = { ...this.state, ...fields };
    if (fields.status && fields.status !== 'downloading') {
      this.state.history = [...this.state.history, { at: new Date().toISOString(), status: fields.status, version: this.manifest?.version }].slice(-30);
      await writeFile(path.join(this.directory, 'history.json'), JSON.stringify(this.state.history)).catch(() => {});
    }
    try { this.onState(this.state); } catch { /* UI must not break verification. */ }
  }
  check({ force = true } = {}) {
    if (this.pending) return this.pending;
    if (!force && Date.now() - this.lastCheck < 15 * 60 * 1000) return Promise.resolve();
    this.lastCheck = Date.now();
    this.pending = this.performCheck().finally(() => { this.pending = null; });
    return this.pending;
  }
  async request(url, signal, redirects = 0) {
    const response = await this.fetcher(url, { redirect: 'manual', credentials: 'omit', cache: 'no-store', signal });
    if ([301, 302, 303, 307, 308].includes(response.status)) {
      const next = new URL(response.headers.get('location'), url).href;
      await response.body?.cancel();
      if (redirects >= 4 || !allowedRedirect(next)) throw new Error('Unsafe update redirect');
      return this.request(next, signal, redirects + 1);
    }
    if (response.status !== 200) { await response.body?.cancel(); throw new Error(`Update request failed (${response.status})`); }
    return response;
  }
  async performCheck() {
    let partial;
    try {
      await mkdir(this.directory, { recursive: true });
      if (!this.state.history.length) {
        try { const history = JSON.parse(await readFile(path.join(this.directory, 'history.json'), 'utf8')); if (Array.isArray(history)) this.state.history = history.slice(-30); } catch { }
      }
      await this.setState({ status: 'checking', file: null, progress: 0, error: null });
      const feed = await this.request(`${PROFILES[this.channel]}/updates/${this.channel}/windows.json`, AbortSignal.timeout(30000));
      const reader = feed.body.getReader(); let size = 0; const chunks = [];
      try { for (;;) { const { done, value } = await reader.read(); if (done) break; size += value.length; if (size > 128 * 1024) throw new Error('Update feed too large'); chunks.push(Buffer.from(value)); } }
      finally { await reader.cancel().catch(() => {}); }
      const manifest = verifyEnvelope(Buffer.concat(chunks).toString('utf8'), this.channel, this.publicKey);
      if (compareVersions(manifest.version, this.version) <= 0) { this.manifest = null; await this.setState({ status: 'current' }); return; }
      let highest = this.version;
      try { highest = JSON.parse(await readFile(path.join(this.directory, 'highest.json'), 'utf8')).version; parts(highest); } catch { highest = this.version; }
      if (compareVersions(manifest.version, highest) < 0) throw new Error('Update rollback blocked');
      await writeFile(path.join(this.directory, 'highest.json'), JSON.stringify({ version: manifest.version }));
      this.manifest = manifest;
      const artifact = manifest.artifacts[this.kind];
      const file = path.join(this.directory, path.posix.basename(new URL(artifact.url).pathname));
      if (!await verifiedFile(file, artifact)) {
        partial = `${file}.part`;
        await this.setState({ status: 'downloading', progress: 0 });
        const response = await this.request(artifact.url, AbortSignal.timeout(20 * 60 * 1000));
        const handle = await open(partial, 'w', 0o600); const hash = createHash('sha256'); let received = 0, lastProgress = -1;
        try {
          for await (const chunk of response.body) {
            received += chunk.length;
            if (received > artifact.size) throw new Error('Update exceeds signed size');
            hash.update(chunk); await handle.writeFile(chunk);
            const progress = Math.floor(received * 100 / artifact.size);
            if (progress !== lastProgress) { lastProgress = progress; await this.setState({ status: 'downloading', progress }); }
          }
          if (received !== artifact.size || hash.digest('hex') !== artifact.sha256) throw new Error('Update checksum mismatch');
        } finally { await handle.close(); }
        await unlink(file).catch(() => {});
        await rename(partial, file); partial = null;
      }
      for (const name of await readdir(this.directory)) {
        if (/^Flownote-(Setup|Portable)-\d+\.\d+\.\d+-x64\.(exe|zip)(\.part)?$/.test(name) && name !== path.basename(file)) await unlink(path.join(this.directory, name)).catch(() => {});
      }
      await this.setState({ status: 'ready', file, progress: 100, notes: manifest.notes, version: manifest.version });
    } catch (error) { await this.setState({ status: 'error', file: null, error: error.message }); }
    finally { if (partial) await unlink(partial).catch(() => {}); }
  }
  async verifyReady() {
    if (this.state.status !== 'ready' || !this.manifest || !await verifiedFile(this.state.file, this.manifest.artifacts[this.kind])) throw new Error('Update file is not verified');
    return this.state.file;
  }
}
module.exports = { compareVersions, validateManifest, verifyEnvelope, verifiedFile, UpdateClient };
