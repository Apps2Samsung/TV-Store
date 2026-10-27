'use strict';
// The signed catalog (#881): a signature from the right key verifies, anything else is refused, and
// every package file's hash is indexed by its download URL. Signed with the throwaway fixture keys,
// with the APIs Node 4.4.3 has (the TV's Node), so this runs there too.
var crypto = require('crypto'), fs = require('fs'), path = require('path');
var Buf = require('../tizen-app/service/compat.js');
var cat = require('../tizen-app/service/catalog.js');
var shipped = require('../tizen-app/service/catalog-key.js');

function fail(m) { console.error('FAIL: ' + m); process.exit(1); }
function throwsLike(fn, re, what) {
    try { fn(); } catch (e) { if (!re.test(e.message)) fail(what + ': wrong error "' + e.message + '"'); return; }
    fail(what + ': was accepted');
}

var F = path.join(__dirname, 'fixtures');
var key = fs.readFileSync(path.join(F, 'author.key'), 'utf8');
var pub = fs.readFileSync(path.join(F, 'author.crt'), 'utf8');          // createVerify takes a certificate PEM as the public key
var other = fs.readFileSync(path.join(F, 'distributor.crt'), 'utf8');

var hash = crypto.createHash('sha256').update('package bytes').digest('hex');
function catalog(generatedAt) {
    return JSON.stringify({ schemaVersion: 1, generatedAt: generatedAt, providers: [{ id: 'p', releases: [{ assets: [
        { name: 'A.wgt', browser_download_url: 'https://github.com/o/r/releases/download/1/A.wgt', digest: 'sha256:' + hash.toUpperCase() },
        { name: 'B.wgt', browser_download_url: 'https://github.com/o/r/releases/download/1/B.wgt' }
    ] }] }] }, null, 2) + '\n';
}
function signed(json) {
    var sig = crypto.createSign('RSA-SHA256').update(Buf.from(json, 'utf8')).sign(key, 'base64');
    return Buf.from(sig + '\n' + json, 'utf8');
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
throwsLike(function () { cat.verify(Buf.from(good.replace(/\n/g, ' '), 'utf8'), pub, now); }, /not signed/, 'unsigned catalog');
throwsLike(function () { cat.verify(signed(catalog('2026-10-10T00:00:00Z')), pub, now); }, /more than 7 days old/, 'stale catalog');
if (cat.sha256(Buf.from('package bytes', 'utf8')) !== hash) fail('sha256 helper');
// The shipped key parses: verifying anything with it answers false instead of throwing.
if (crypto.createVerify('RSA-SHA256').update('x').verify(shipped, 'AAAA', 'base64') !== false) fail('shipped key');

console.log('PASS');
console.log('  signed catalog verifies; tampered, foreign-key, unsigned and stale ones are refused');
