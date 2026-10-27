'use strict';
// The signed catalog (#881): a signature from the right key verifies, anything else is refused, and
// every package file's hash is indexed by its download URL. Throwaway key, generated here.
var crypto = require('crypto');
var cat = require('../tizen-app/service/catalog.js');
var shipped = require('../tizen-app/service/catalog-key.js');

function fail(m) { console.error('FAIL: ' + m); process.exit(1); }
function throwsLike(fn, re, what) {
    try { fn(); } catch (e) { if (!re.test(e.message)) fail(what + ': wrong error "' + e.message + '"'); return; }
    fail(what + ': was accepted');
}

var pair = crypto.generateKeyPairSync('rsa', { modulusLength: 3072 });
var pub = pair.publicKey.export({ type: 'spki', format: 'pem' });
var other = crypto.generateKeyPairSync('rsa', { modulusLength: 2048 }).publicKey.export({ type: 'spki', format: 'pem' });

var hash = crypto.createHash('sha256').update('package bytes').digest('hex');
function catalog(generatedAt) {
    return JSON.stringify({ schemaVersion: 1, generatedAt: generatedAt, providers: [{ id: 'p', releases: [{ assets: [
        { name: 'A.wgt', browser_download_url: 'https://github.com/o/r/releases/download/1/A.wgt', digest: 'sha256:' + hash.toUpperCase() },
        { name: 'B.wgt', browser_download_url: 'https://github.com/o/r/releases/download/1/B.wgt' }
    ] }] }] }, null, 2) + '\n';
}
function signed(json, key) {
    var sig = crypto.sign('sha256', Buffer.from(json), key || pair.privateKey).toString('base64');
    return Buffer.from(sig + '\n' + json);
}

var now = Date.parse('2026-10-27T10:00:00Z');
var good = catalog('2026-10-27T09:30:00Z');

var r = cat.verify(signed(good), pub, now);
if (r.payload.toString() !== good) fail('payload is not the signed bytes');
if (r.index['https://github.com/o/r/releases/download/1/A.wgt'] !== hash) fail('hash not indexed (lower-case hex)');
if (r.index['https://github.com/o/r/releases/download/1/B.wgt'] !== null) fail('a file without a hash must index as null');

var tampered = signed(good); tampered[tampered.length - 5] ^= 1;
throwsLike(function () { cat.verify(tampered, pub, now); }, /signature does not match/, 'tampered catalog');
throwsLike(function () { cat.verify(signed(good), other, now); }, /signature does not match/, 'another key');
throwsLike(function () { cat.verify(Buffer.from(good.replace(/\n/g, ' ')), pub, now); }, /not signed/, 'unsigned catalog');
throwsLike(function () { cat.verify(signed(catalog('2026-10-10T00:00:00Z')), pub, now); }, /more than 7 days old/, 'stale catalog');
if (cat.sha256(Buffer.from('package bytes')) !== hash) fail('sha256 helper');
crypto.createPublicKey(shipped);   // the shipped key parses

console.log('PASS');
console.log('  signed catalog verifies; tampered, foreign-key, unsigned and stale ones are refused');
