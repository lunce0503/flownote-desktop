'use strict';
const path = require('node:path');

const PROFILES = Object.freeze({
  staging: 'https://flownote-react-staging.vercel.app',
  production: 'https://flownote-react.vercel.app',
});
const profileForArgs = args => args.includes('--staging') ? 'staging' : 'production';
function trustedUrl(value, origin) {
  try {
    const url = new URL(value);
    return url.protocol === 'https:' && url.origin === origin && !url.username && !url.password;
  } catch { return false; }
}
function externalUrl(value) {
  try {
    const url = new URL(value);
    if (url.username || url.password) return false;
    return ['https:', 'mailto:', 'tel:'].includes(url.protocol);
  } catch { return false; }
}
function safeDownloadName(value) {
  let name = path.win32.basename(value || 'flownote-download').replace(/[<>:"/\\|?*\x00-\x1f]/g, '_').replace(/[. ]+$/, '').slice(0, 180);
  if (/^(con|prn|aux|nul|com[1-9]|lpt[1-9])(\.|$)/i.test(name)) name = `flownote-${name}`;
  return name || 'flownote-download';
}
module.exports = { PROFILES, profileForArgs, trustedUrl, externalUrl, safeDownloadName };
