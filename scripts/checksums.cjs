const { createHash } = require('node:crypto');
const { readdirSync, readFileSync, writeFileSync } = require('node:fs');
const path = require('node:path');
const directory = path.join(__dirname, '..', 'release');
const lines = readdirSync(directory).filter(name => /^Flownote-(Setup|Portable)-.*\.(exe|zip)$/.test(name)).sort()
  .map(name => `${createHash('sha256').update(readFileSync(path.join(directory, name))).digest('hex')}  ${name}`);
if (lines.length !== 2) throw new Error('Expected exactly one setup EXE and one portable ZIP.');
writeFileSync(path.join(directory, 'SHA256SUMS.txt'), `${lines.join('\n')}\n`);
console.log(lines.join('\n'));
