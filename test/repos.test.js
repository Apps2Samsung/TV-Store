'use strict';
// Independent repositories (#82): every test vector of the spec (tizen-community-packages
// spec/fixtures, copied into test/fixtures/repositories with its index.json) is accepted or refused
// for the reason it names; then what the TV adds on top: a repository that calls itself something
// else than approved, a key that is not the approved one, the sources Apps2Samsung hands over.
// Runs on Node 4.4.3, the TV's Node, like the rest.
var fs = require('fs'), path = require('path'), crypto = require('crypto');
var Buf = require('../tizen-app/service/compat.js');
var repos = require('../tizen-app/service/repos.js');

function fail(m) { console.error('FAIL: ' + m); process.exit(1); }
var D = path.join(__dirname, 'fixtures', 'repositories');
function read(f) { return fs.readFileSync(path.join(D, f)); }
var index = JSON.parse(read('index.json').toString('utf8'));
var now = Date.parse(index.now);

// ---- the spec's test vectors ----------------------------------------------------------------------
var n = 0;
index.cases.forEach(function (c) {
    var pem = read(c.key).toString('utf8'), key = repos.keyInfo(pem);
    var o = { publicKeyPem: pem, fingerprint: c.fingerprint || key.fingerprint, notBefore: c.notBefore, now: now };
    var got;
    try { repos.verify(read(c.file), o); got = { expect: 'accept' }; }
    catch (e) { if (!e.reason) fail(c.file + ': threw without a reason: ' + e.stack); got = { expect: 'reject', reason: e.reason, message: e.message }; }
    if (got.expect !== c.expect || (c.reason && got.reason !== c.reason)) fail(c.file + ' (' + c.note + '): expected ' + c.expect + (c.reason ? ' ' + c.reason : '') + ', got ' + got.expect + (got.reason ? ' ' + got.reason + ': ' + got.message : ''));
    n++;
});

// ---- keys -----------------------------------------------------------------------------------------
var test = repos.keyInfo(read('keys/test.pub.pem').toString('utf8')), weak = repos.keyInfo(read('keys/weak.pub.pem').toString('utf8'));
if (!test.rsa || test.bits !== 3072 || !/^[0-9a-f]{64}$/.test(test.fingerprint)) fail('test key: ' + JSON.stringify({ rsa: test.rsa, bits: test.bits }));
if (!weak.rsa || weak.bits !== 2048) fail('weak key bits: ' + weak.bits);
// The fingerprint is the SHA-256 of the DER SubjectPublicKeyInfo, as openssl pkey -outform DER | sha256sum prints it.
var der = Buf.from(read('keys/test.pub.pem').toString('utf8').replace(/-----[^-]+-----|\s/g, ''), 'base64');
if (crypto.createHash('sha256').update(der).digest('hex') !== test.fingerprint) fail('fingerprint is not the SHA-256 of the DER');
if (repos.keyInfo('not a key') !== null || repos.keyInfo(read('keys/test.key.pem').toString('utf8')) !== null) fail('only a PUBLIC KEY PEM is a key');

// ---- on top of the spec ---------------------------------------------------------------------------
var pem = read('keys/test.pub.pem').toString('utf8'), valid = read('valid.signed');
function reason(buf, o) { try { repos.verify(buf, o); return 'accept'; } catch (e) { return e.reason; } }
var base = { publicKeyPem: pem, fingerprint: test.fingerprint, now: now };
function withO(extra) { var o = {}; for (var k in base) o[k] = base[k]; for (var x in extra) o[x] = extra[x]; return o; }
if (reason(valid, withO({ repositoryId: 'org.example.tizen' })) !== 'accept') fail('the approved repository id');
if (reason(valid, withO({ repositoryId: 'org.example.other' })) !== 'repository-id') fail('another repository id must be refused');
// The approved fingerprint is the other key's: a manifest signed by the right key, checked with a
// key that someone swapped in, is refused before the signature is even looked at.
var other = read('keys/other.pub.pem').toString('utf8');
if (reason(valid, withO({ publicKeyPem: other })) !== 'fingerprint') fail('a key that is not the approved one');
if (reason(valid, withO({ publicKeyPem: other, fingerprint: repos.keyInfo(other).fingerprint })) !== 'signature') fail('the other key, approved, does not verify the manifest');
if (reason(valid, withO({ fingerprint: undefined })) !== 'fingerprint') fail('no approved fingerprint: nothing is trusted');
if (reason(valid, withO({ notBefore: '2026-11-07T00:00:00Z' })) !== 'accept') fail('the same manifest again is no rollback');
if (reason(valid, withO({ now: now + 8 * 24 * 3600 * 1000 })) !== 'expired') fail('a week later it has expired');
var big = Buf.alloc(repos.MAX_BYTES + 1);
if (reason(big, base) !== 'size') fail('more than 8 MiB');
var r = repos.verify(valid, base);
if (r.repository.id !== 'org.example.tizen' || Object.keys(r.index).length < 2) fail('index of the valid repository: ' + JSON.stringify(r.index));
Object.keys(r.index).forEach(function (u) { if (!/^[0-9a-f]{64}$/.test(r.index[u])) fail('every file of a repository has its hash: ' + u); });

// URLs a repository may not use.
[['https://example.org/x', null], ['https://192.168.1.10/a.wgt', 'IP'], ['https://[::1]/a', 'IP'], ['https://localhost/a', 'localhost'], ['https://tv.localhost/a', 'localhost'],
 ['https://nas.local/a', '.local'], ['https://user:pw@example.org/a', 'password'], ['https://example.org:8443/a', null], ['https://2130706433/a', 'IP']].forEach(function (t) {
    var p = repos.urlProblem(t[0]);
    if (t[1] === null ? p !== null : !(p && p.indexOf(t[1]) >= 0)) fail('urlProblem(' + t[0] + ') = ' + p);
});

// What Apps2Samsung hands over (Send sources to TV).
var ok = repos.normalizeSource({ url: 'https://owner.github.io/tizen/repository.json.signed', repositoryId: 'io.github.owner.tizen', fingerprint: test.fingerprint.toUpperCase(), name: 'Owner\'s apps|x' });
if (!ok.source || ok.source.fingerprint !== test.fingerprint || ok.source.name !== 'Owner\'s apps x' || ok.source.publicKeyPem) fail('normalizeSource: ' + JSON.stringify(ok));
var withKey = repos.normalizeSource({ url: 'https://owner.github.io/tizen/repository.json.signed', repositoryId: 'io.github.owner.tizen', fingerprint: test.fingerprint, publicKeyPem: pem });
if (!withKey.source || withKey.source.publicKeyPem !== pem) fail('normalizeSource with the key');
[{ url: 'http://owner.github.io/r.signed', repositoryId: 'io.github.owner.tizen', fingerprint: test.fingerprint },
 { url: 'https://10.0.0.2/r.signed', repositoryId: 'io.github.owner.tizen', fingerprint: test.fingerprint },
 { url: 'https://owner.github.io/r.signed', repositoryId: 'Owner Tizen', fingerprint: test.fingerprint },
 { url: 'https://owner.github.io/r.signed', repositoryId: 'io.github.owner.tizen', fingerprint: 'abc' },
 { url: 'https://owner.github.io/r.signed', repositoryId: 'io.github.owner.tizen', fingerprint: test.fingerprint, publicKeyPem: other },
 null].forEach(function (s) { if (!repos.normalizeSource(s).error) fail('normalizeSource must refuse ' + JSON.stringify(s)); });

console.log('PASS');
console.log('  ' + n + ' spec test vectors accepted or refused for their reason; repository id, swapped key, size, URL rules, sources from Apps2Samsung');
