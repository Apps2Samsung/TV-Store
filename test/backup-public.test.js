/* The backup without keys on :8077, without the screen (#149).
 *
 * backup.js by itself: a source whose address carries a key is cut back to its host and marked, and
 * only then is the backup version 2; such a source is no source to add when the file is read back;
 * the content hash is the same whatever the order of the keys, and does not move with madeAt or a
 * source's lastGeneratedAt.
 *
 * Against the real service: GET /relay says the route exists; before the screen handed its part
 * over the route answers NO_SCREEN_STATE; the hand-over needs the page token; the backup has no
 * certificate, no app setting and no key from an address; madeAt stays until the content changes,
 * also over a restart of the service; and on a restore the shortened source is named, not added.
 *
 * On the real page script: the screen hands its part over when it starts,
 * and the restore question names the sources that have to be sent again. */
'use strict';
var fs = require('fs'), os = require('os'), path = require('path'), http = require('http'), cp = require('child_process');
var backup = require('../tizen-app/service/backup.js');
var harness = require('./page-harness.js');

var child = null;
function fail(m) { try { child.kill(); } catch (e) {} console.error('FAIL: ' + m); process.exit(1); }
var F = path.join(__dirname, 'fixtures');
function pem(f) { return fs.readFileSync(path.join(F, f), 'utf8'); }
var CERT = { name: 'PC - Public', authorKeyPem: pem('author.key'), authorCertPem: pem('author.crt'), distributorKeyPem: pem('distributor.key'), distributorCertPem: pem('distributor.crt') };
var FP = new Array(65).join('ab').slice(0, 64), FP2 = new Array(65).join('cd').slice(0, 64);
var PLAIN = { url: 'https://example.org/tizen/repository.json.signed', repositoryId: 'org.example.tizen', fingerprint: FP, name: 'Example', enabled: true, lastGeneratedAt: '2026-11-20T10:00:00.000Z' };
var KEYED = { url: 'https://private.example.net/repo/repository.json.signed?token=t0k3nvalue', repositoryId: 'net.example.private', fingerprint: FP2, name: 'Private', enabled: true };
var PAGE = { settings: { showAdult: true, showNeedsHead: false, verboseLog: false, selfUpdate: false }, pins: [{ key: 'official:moonfin', file: 'Moonfin.wgt' }], certChoice: { MoonPkg001: 'partner' } };
var APP = { version: '0.3.42', device: 'QE55Q60' };

// ---- backup.js by itself --------------------------------------------------------------------------
var parts = { page: PAGE, tvStore: '0.3.42', tv: 'QE55Q60', duid: 'ABCDEFGH1234', sources: [PLAIN, KEYED], userSettings: { 'Jellyfin.wgt': { values: { apiKey: 's3cr3t' }, at: '2026-11-03T10:00:00.000Z' } }, browser: { enabled: true } };
var full = backup.make(parts, { secrets: false });
if (full.version !== 1 || full.service.sources[1].url !== KEYED.url || full.service.sources[1].urlShortened !== undefined) fail('a backup behind the code keeps the addresses and stays version 1: ' + JSON.stringify(full.service.sources));
var pub = backup.make(parts, { secrets: false, shortenUrls: true, madeAt: '2026-11-24T12:00:00.000Z' });
if (pub.version !== 2 || pub.madeAt !== '2026-11-24T12:00:00.000Z') fail('a backup with a shortened source is version 2, at the moment given: ' + pub.version + ' ' + pub.madeAt);
if (pub.service.sources[0].url !== PLAIN.url || pub.service.sources[0].urlShortened !== undefined) fail('an address without a key stays: ' + JSON.stringify(pub.service.sources[0]));
if (pub.service.sources[1].url !== 'https://private.example.net/' || pub.service.sources[1].urlShortened !== true || pub.service.sources[1].fingerprint !== FP2) fail('an address with a key is cut back to its host and marked: ' + JSON.stringify(pub.service.sources[1]));
if (/t0k3nvalue|s3cr3t/.test(JSON.stringify(pub))) fail('no key from an address and no app setting in it');
if (backup.make({ sources: [PLAIN] }, { secrets: false, shortenUrls: true }).version !== 1) fail('without a shortened source it stays version 1');

var read = backup.parse(JSON.stringify(pub));
if (read.error) fail('it reads back: ' + read.error);
if (read.backup.service.sources.length !== 1 || read.backup.service.sources[0].repositoryId !== 'org.example.tizen') fail('a shortened source is no source to add: ' + JSON.stringify(read.backup.service.sources));
var re = read.backup.service.sourcesReenter;
if (re.length !== 1 || re[0].name !== 'Private' || re[0].repositoryId !== 'net.example.private' || re[0].domain !== 'private.example.net' || re[0].fingerprint !== FP2) fail('it is named instead: ' + JSON.stringify(re));
var sum = backup.summary(read.backup);
if (sum.sources.length !== 1 || sum.sourcesReenter.length !== 1 || sum.sourcesReenter[0].domain !== 'private.example.net') fail('the summary names it: ' + JSON.stringify(sum));
if (!/newer TV-Store/.test(backup.parse({ format: backup.FORMAT, version: 3 }).error || '')) fail('version 3 is refused');

var h = backup.contentHash(pub);
if (!/^[0-9a-f]{64}$/.test(h)) fail('the content hash: ' + h);
var later = JSON.parse(JSON.stringify(pub)); later.madeAt = '2026-12-01T00:00:00.000Z'; later.service.sources[0].lastGeneratedAt = '2026-11-30T10:00:00.000Z';
if (backup.contentHash(later) !== h) fail('madeAt and a source\'s lastGeneratedAt do not move the hash');
var turned = { service: pub.service, page: { certChoice: pub.page.certChoice, pins: pub.page.pins, settings: pub.page.settings }, secrets: false, duid: pub.duid, tv: pub.tv, tvStore: pub.tvStore, madeAt: pub.madeAt, version: 2, format: pub.format };
if (backup.contentHash(turned) !== h) fail('the order of the keys does not move the hash');
later.page.pins.push({ key: 'official:other', file: 'Other.wgt' });
if (backup.contentHash(later) === h) fail('another pin does');

// ---- against the service --------------------------------------------------------------------------
var dirs = [], err = '';
function start(dir, seed, then) {
    if (!dir) { dir = path.join(os.tmpdir(), 'a2s-backup-public-' + process.pid + '-' + Date.now() + '-' + dirs.length); fs.mkdirSync(dir); dirs.push(dir); }
    Object.keys(seed).forEach(function (f) { fs.writeFileSync(path.join(dir, f), JSON.stringify(seed[f])); });   // what an earlier run of the service left
    err = '';
    child = cp.spawn(process.execPath, [path.join(__dirname, '..', 'tizen-app', 'service', 'index.js')], { env: { HOME: dir, TMPDIR: dir, TMP: dir, TEMP: dir, PATH: process.env.PATH, A2S_RELAY_PORT: '26293', A2S_SDB_PORT: '26194' }, stdio: ['ignore', 'ignore', 'pipe'] });
    child.stderr.on('data', function (d) { err += d; });
    var tries = 0;
    (function waitUp() {
        call('GET', '/ping', null, function (e, code) {
            if (e || code !== 200) { if (++tries > 100) fail('the service never answered /ping' + (err ? '\n' + err : '')); return setTimeout(waitUp, 100); }
            then(dir, fs.readFileSync(path.join(dir, '.a2s-upload-token'), 'utf8').trim());
        });
    })();
}
function stop(then) { var c = child; c.on('exit', function () { setTimeout(then, 200); }); c.kill(); }
function call(method, p, data, cb, headers) {
    var hd = {}; if (data) { hd['Content-Length'] = Buffer.byteLength(data); hd['Content-Type'] = 'application/json'; }
    Object.keys(headers || {}).forEach(function (k) { hd[k] = headers[k]; });
    var req = http.request({ host: '127.0.0.1', port: 8077, path: p, method: method, headers: hd }, function (res) {
        var t = ''; res.on('data', function (d) { t += d; }); res.on('end', function () { var j = null; try { j = JSON.parse(t); } catch (e) {} cb(null, res.statusCode, j, t, res.headers); });
    });
    req.on('error', function (e) { cb(e); });
    if (data) req.write(data);
    req.end();
}
function get(p, cb, headers) { call('GET', p, null, function (e, code, j, t, hd) { if (e) fail(p + ': ' + e.message); cb(code, j || {}, t, hd); }, headers); }
function post(p, obj, cb) { call('POST', p, JSON.stringify(obj), function (e, code, j) { if (e) fail(p + ': ' + e.message); cb(code, j || {}); }); }
function cleanup() { dirs.forEach(function (d) { try { fs.readdirSync(d).forEach(function (f) { try { fs.unlinkSync(path.join(d, f)); } catch (e) {} }); fs.rmdirSync(d); } catch (e) {} }); }
var WD = setTimeout(function () { fail('watchdog (40 s)' + (err ? '\n' + err : '')); }, 40000);
// The steps one after the other; each calls next().
function run(steps) { (function next() { var s = steps.shift(); if (s) s(next); })(); }

var dir = null, token = null, first = null, kept = null;
run([
    function (next) { start(null, { '.a2s-sources.json': { sources: [PLAIN, KEYED] }, '.a2s-user-settings.json': parts.userSettings }, function (d, t) { dir = d; token = t; next(); }); },
    function (next) { post('/cert', { certificates: [CERT] }, function (code, j) { if (!j.ok) fail('the hand-over of a certificate: ' + JSON.stringify(j)); next(); }); },
    function (next) { get('/relay', function (code, j) { if (code !== 200 || j.backupPublic !== true || !j.relay) fail('GET /relay says the route exists: ' + JSON.stringify(j)); next(); }); },
    function (next) {
        get('/backup/public', function (code, j) {
            if (code !== 409 || j.ok !== false || j.code !== 'NO_SCREEN_STATE' || j.format) fail('before the screen handed its part over: ' + code + ' ' + JSON.stringify(j));
            next();
        });
    },
    function (next) { post('/backup/page', { token: 'wrong', page: PAGE, app: APP }, function (code, j) { if (code !== 403 || j.code !== 'NO_TOKEN') fail('the hand-over needs the token: ' + code + ' ' + JSON.stringify(j)); next(); }); },
    function (next) { get('/backup/public', function (code, j) { if (code !== 409) fail('a refused hand-over leaves nothing: ' + code); next(); }); },
    function (next) { post('/backup/page', { token: token, page: PAGE, app: APP }, function (code, j) { if (!j.ok || j.changed !== true) fail('the hand-over: ' + JSON.stringify(j)); next(); }); },
    function (next) { post('/backup/page', { token: token, page: PAGE, app: APP }, function (code, j) { if (!j.ok || j.changed !== false) fail('the same part again is no change: ' + JSON.stringify(j)); next(); }); },
    function (next) {
        get('/backup/public', function (code, j, text, headers) {
            if (code !== 200 || j.format !== 'a2s-tvstore-backup' || j.version !== 2 || j.secrets !== false || j.ok !== undefined) fail('the backup itself: ' + code + ' ' + text.slice(0, 200));
            if (j.service.certificates || j.service.userSettings || /BEGIN|s3cr3t|t0k3nvalue/.test(text)) fail('no certificate, no app setting, no key from an address');
            if (j.tvStore !== '0.3.42' || j.tv !== 'QE55Q60' || j.page.pins.length !== 1 || j.page.settings.showAdult !== true || j.page.certChoice.MoonPkg001 !== 'partner') fail('the screen\'s part: ' + JSON.stringify(j.page));
            var s = j.service.sources;
            if (s.length !== 2 || s[0].url !== PLAIN.url || s[0].urlShortened !== undefined || s[1].url !== 'https://private.example.net/' || s[1].urlShortened !== true) fail('the sources: ' + JSON.stringify(s));
            if (!j.service.browser || typeof j.service.browser.enabled !== 'boolean') fail('Install from a browser is in it');
            if (headers['access-control-allow-origin']) fail('no CORS for other sites');
            if (!/no-store/.test(headers['cache-control'] || '')) fail('not to be cached');
            if (isNaN(new Date(j.madeAt).getTime())) fail('madeAt: ' + j.madeAt);
            first = j;
            next();
        });
    },
    function (next) { get('/backup/public', function (code) { if (code !== 403) fail('only by the TV\'s address: ' + code); next(); }, { Host: 'tv.example.com:8077' }); },
    function (next) { setTimeout(next, 30); },
    function (next) { get('/backup/public', function (code, j, text) { if (j.madeAt !== first.madeAt) fail('madeAt stays while nothing changed: ' + first.madeAt + ' -> ' + j.madeAt); kept = text; next(); }); },
    // A change in the service: Install from a browser.
    function (next) { post('/settings', { browser: { enabled: !first.service.browser.enabled } }, function (code, j) { if (!j.ok) fail('the setting: ' + JSON.stringify(j)); next(); }); },
    function (next) {
        get('/backup/public', function (code, j) {
            if (j.madeAt === first.madeAt || j.service.browser.enabled === first.service.browser.enabled) fail('a change in the service moves madeAt: ' + j.madeAt);
            first = j; next();
        });
    },
    function (next) { setTimeout(next, 30); },
    // A change on the screen: another pin.
    function (next) { post('/backup/page', { token: token, page: { settings: PAGE.settings, pins: PAGE.pins.concat([{ key: 'official:other', file: 'Other.wgt' }]), certChoice: PAGE.certChoice }, app: APP }, function (code, j) { if (!j.changed) fail('another pin is a change'); next(); }); },
    function (next) {
        get('/backup/public', function (code, j) {
            if (j.madeAt === first.madeAt || j.page.pins.length !== 2) fail('a change on the screen moves madeAt: ' + j.madeAt + ' ' + JSON.stringify(j.page.pins));
            first = j; next();
        });
    },
    // The service starts again: the screen's part and madeAt are on disk.
    function (next) { stop(next); },
    function (next) { start(dir, {}, function () { next(); }); },
    function (next) {
        get('/backup/public', function (code, j, text) {
            if (code !== 200 || j.madeAt !== first.madeAt || j.page.pins.length !== 2) fail('after a restart of the service: ' + code + ' ' + j.madeAt + ' (was ' + first.madeAt + ')');
            kept = text; next();
        });
    },
    // A TV after a reset takes it back: the shortened source is named, not added.
    function (next) { stop(next); },
    function (next) { start(null, {}, function (d, t) { token = t; next(); }); },
    function (next) {
        post('/backup/take', { token: token, backup: kept }, function (code, j) {
            var s = j.restore && j.restore.summary;
            if (!j.ok || s.sources.length !== 1 || s.sourcesReenter.length !== 1 || s.sourcesReenter[0].name !== 'Private' || s.sourcesReenter[0].domain !== 'private.example.net') fail('what the TV shows before the restore: ' + JSON.stringify(j));
            post('/backup/apply', { token: token, id: j.restore.id, installed: [] }, function (code, r) {
                if (!r.ok || r.applied.sources !== 1 || JSON.stringify(r.applied.sourcesReenter) !== '[{"name":"Private","domain":"private.example.net"}]') fail('what the restore says: ' + JSON.stringify(r));
                if (!r.page.pins || r.page.pins.length !== 2) fail('the pins come back: ' + JSON.stringify(r.page));
                next();
            });
        });
    },
    function (next) {
        get('/ping', function (code, j) {
            if (j.sources.length !== 1 || j.sources[0].repositoryId !== 'org.example.tizen' || j.sources[0].url !== PLAIN.url) fail('only the source with a whole address is on the TV: ' + JSON.stringify(j.sources));
            next();
        });
    },
    function (next) { stop(next); },
    function () { cleanup(); onThePage(); }
]);

// ---- on the real page script ----------------------------------------------------------------------
function onThePage() {
    var handed = [];
    var summary = { madeAt: '2026-11-20T09:30:00.000Z', tvStore: '0.3.42', tv: 'QE55Q60', duid: 'ABCDEFGH1234', secrets: false, pins: 2, settings: 6, certificates: [], userSettings: 0,
                    sources: [{ name: 'Example', repositoryId: 'org.example.tizen', domain: 'example.org', fingerprint: FP }], sourcesReenter: [{ name: 'Private', repositoryId: 'net.example.private', domain: 'private.example.net', fingerprint: FP2 }] };
    var uploads = { ok: true, pending: null };
    var catalog = { schemaVersion: 1, generatedAt: '2026-11-24T10:00:00Z', providers: [{ id: 'moonfin', ok: true, url: 'https://api.github.com/repos/x/moonfin/releases',
        releases: [{ assets: [{ name: 'Moonfin.wgt', browser_download_url: 'https://dl.test/Moonfin.wgt', digest: 'sha256:' + new Array(65).join('a'), package_id: 'MoonPkg001', app_id: 'MoonPkg001.App', package_version: '1.1.0' }] }] }] };
    var p = harness.page({ catalog: catalog, installed: { MoonPkg001: '1.1.0' }, storage: { 'a2s.tvstore.pins': [{ key: 'official:moonfin', file: 'Moonfin.wgt' }] },
        answer: function (method, pth, body) {
            if (pth === '/backup/page') { handed.push(body); return { ok: true, changed: true }; }
            if (pth === '/uploads') return uploads;
            if (pth === '/backup/apply') { uploads = { ok: true, pending: null }; return { ok: true, applied: { certificates: 0, sources: 1, userSettings: 0, sourcesReenter: [{ name: 'Private', domain: 'private.example.net' }] }, page: {} }; }
        } });
    setTimeout(function () {
        if (!handed.length) fail('the screen hands its part over when it starts');
        var last = handed[handed.length - 1];
        if (last.token !== 'token' || last.page.pins.length !== 1 || last.page.pins[0].key !== 'official:moonfin' || !last.page.settings || last.app.version === undefined) fail('what it hands over: ' + JSON.stringify(last).slice(0, 300));
        var n = handed.length;
        p.window.A2SStore.status().then(function () {
            uploads = { ok: true, pending: null, restore: { id: 'r1', from: 'Apps2Samsung', at: '2026-11-24T10:00:00.000Z', summary: summary, otherTv: false } };
            p.tick(function () {
                var html = p.html('sheet');
                if (html.indexOf('Restore this backup?') < 0) fail('the restore question: ' + html.slice(0, 300));
                if (html.indexOf('Private (private.example.net)') < 0 || html.indexOf('Send sources to TV') < 0) fail('the question names the source to send again: ' + html.slice(0, 2500));
                p.press('', { 'data-act': 'restoreyes' });
                p.settle(function () {
                    var done = p.html('sheet');
                    if (done.indexOf('Restored') < 0 || done.indexOf('Not added: Private (private.example.net)') < 0) fail('the result names it too: ' + done.slice(0, 1500));
                    if (handed.length !== n) fail('nothing was saved, so nothing is handed over again: ' + (handed.length - n));
                    clearTimeout(WD);
                    console.log('PASS: the backup without keys: only after the screen\'s hand-over, a shortened source marked and not restored, madeAt moves with the content only');
                    process.exit(0);
                });
            });
        });
    }, 1300);
}
