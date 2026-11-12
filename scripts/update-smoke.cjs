const { strict: assert } = require('node:assert');
const { mkdtemp, writeFile, readFile } = require('node:fs/promises');
const path = require('node:path');
const os = require('node:os');
const { UpdateClient } = require('../updater.cjs');
(async () => {
  if (process.argv[2] && process.argv[3]) {
    const { _electron: electron } = require('playwright');
    for (const [kind, executablePath] of [['installer', process.argv[2]], ['portable', process.argv[3]]]) {
      const application = await electron.launch({ executablePath, args: ['--staging'], timeout: 60000 });
      try {
        const result = await application.evaluate(async ({ app }, kind) => {
          const load = process.getBuiltinModule('node:module').createRequire(app.getAppPath() + '/package.json');
          const path = load('node:path');
          const fs = load('node:fs/promises');
          const { UpdateClient } = load('./updater.cjs');
          const directory = await fs.mkdtemp(path.join(app.getPath('temp'), `flownote-native-${kind}-updates-`));
          let requests = 0;
          const fetcher = (url, options) => { if (!url.endsWith('.json')) requests++; return globalThis.fetch(url, options); };
          // Old-version fixture in the packaged main process, not a renderer/CLI override.
          const options = { directory, channel: 'staging', version: '1.0.0', kind, fetcher };
          const client = new UpdateClient(options);
          await Promise.all([client.check(), client.check()]);
          if (client.state.status !== 'ready') throw new Error(client.state.error || client.state.status);
          await client.verifyReady(); const firstRequests = requests;
          const again = new UpdateClient(options); await again.check();
          if (again.state.status !== 'ready' || requests !== firstRequests) throw new Error('Verified restart cache was not reused');
          const current = new UpdateClient({ ...options, version: client.state.version }); await current.check();
          if (current.state.status !== 'current' || requests !== firstRequests) throw new Error('Same version was downloaded');
          await fs.writeFile(path.join(directory, 'draft-preservation-probe.txt'), 'keep'); await client.check();
          if (await fs.readFile(path.join(directory, 'draft-preservation-probe.txt'), 'utf8') !== 'keep') throw new Error('Unrelated data changed');
          return { kind, version: client.state.version, status: client.state.status, firstRequests, requests };
        }, kind);
        console.log('PASS exact packaged Windows updater with its Node fetch transport:', JSON.stringify(result));
      } finally { await application.close(); }
    }
    return;
  }
  // Public staging only; signature + exact release URL remain enforced.
  for (const kind of ['installer', 'portable']) {
    const directory = await mkdtemp(path.join(os.tmpdir(), `flownote-${kind}-update-`));
    let requests = 0;
    const fetcher = (url, options) => { if (!url.endsWith('.json')) requests++; return fetch(url, options); };
    const options = { directory, channel: 'staging', version: '1.0.0', kind, fetcher };
    const client = new UpdateClient(options);
    await Promise.all([client.check(), client.check()]);
    assert.equal(client.state.status, 'ready', client.state.error);
    await client.verifyReady(); const firstRequests = requests;
    await new UpdateClient(options).check(); assert.equal(requests, firstRequests, 'A verified cached release must not be downloaded twice');
    const current = new UpdateClient({ ...options, version: client.state.version });
    await current.check(); assert.equal(current.state.status, 'current'); assert.equal(requests, firstRequests);
    await writeFile(path.join(directory, 'draft-preservation-probe.txt'), 'keep');
    await client.check(); assert.equal(await readFile(path.join(directory, 'draft-preservation-probe.txt'), 'utf8'), 'keep');
    console.log(`PASS Windows ${kind}: signed cloud feed, actual artifact download, SHA-256, cached restart, duplicate prevention, current-version skip and data preservation`);
  }
})().catch(error => { console.error(error); process.exitCode = 1; });
