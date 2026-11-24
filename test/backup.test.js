/* Backup and restore of TV-Store's own data (#146).
 *
 * backup.js by itself: a backup made and read back is the same; one without secrets has no
 * certificates and no app settings; junk, another format and a newer version are refused; whatever
 * a file holds that is not understood is left out; the package records only come back for packages
 * on the TV; the certificates of a backup are added to the ones a TV holds.
 *
 * Then against the real service, started twice with an empty data folder each (a TV before and
 * after a reset): the backup needs the page token or the code the TV shows, a wrong code five times
 * voids it, a code works once; a file sent in waits until the screen applies it with the token, and
 * afterwards the second service holds the certificates, the source, the apps' settings and the
 * switches of the first. */
'use strict';
var fs = require('fs'), os = require('os'), path = require('path'), http = require('http'), cp = require('child_process');
var backup = require('../tizen-app/service/backup.js');
var certs = require('../tizen-app/service/certs.js');

var child = null;
function fail(m) { try { child.kill(); } catch (e) {} console.error('FAIL: ' + m); process.exit(1); }
var F = path.join(__dirname, 'fixtures');
function pem(f) { return fs.readFileSync(path.join(F, f), 'utf8'); }
var A = { name: 'PC - Public', authorKeyPem: pem('author.key'), authorCertPem: pem('author.crt'), distributorKeyPem: pem('distributor.key'), distributorCertPem: pem('distributor.crt') };
var B = { name: 'Phone', authorKeyPem: pem('distributor.key'), authorCertPem: pem('distributor.crt'), distributorKeyPem: pem('distributor.key'), distributorCertPem: pem('distributor.crt') };
var idA = certs.fingerprint(A.authorCertPem), idB = certs.fingerprint(B.authorCertPem);
var FP = new Array(65).join('ab').slice(0, 64);
var SOURCE = { url: 'https://example.org/tizen/repository.json.signed', repositoryId: 'org.example.tizen', fingerprint: FP, name: 'Example', maintainer: 'Someone', enabled: false, addedAt: '2026-11-01T10:00:00.000Z', lastGeneratedAt: '2026-11-20T10:00:00.000Z' };
var PAGE = { settings: { showAdult: true, showNeedsHead: false, verboseLog: false, selfUpdate: true, hideSelfNotice: '0.3.40', junk: 1 },
             pins: [{ key: 'official:moonfin', file: 'Moonfin.wgt' }, { key: '', file: 'x' }, 'nope'], certChoice: { MoonPkg001: 'partner', OtherPkg01: 'root' },
             movedSeen: ['https://example.org/moved'], variants: { MoonPkg001: 'Moonfin.wgt', GonePkg001: 'Gone.wgt' }, webVersions: { JellyPkg01: { key: 'official:jellyfin', file: 'Jellyfin.wgt', web: '10.9.0' } } };

// ---- backup.js by itself --------------------------------------------------------------------------
var store = certs.merge(null, certs.normalize({ certificates: [A, B] }));
var parts = { page: PAGE, tvStore: '0.3.40', tv: 'QE55Q60', duid: 'ABCDEFGH1234', certificates: store, certByPackage: { MoonPkg001: idB, Odd: 'not a hash' },
              sources: [SOURCE], sourceOf: { MoonPkg001: 'org.example.tizen', GonePkg001: 'official' },
              renames: [{ originalPackageId: 'MoonPkg001', newPackageId: 'MoonPkg0a1', originalAppId: 'MoonPkg001.App', newAppId: 'MoonPkg0a1.App', key: 'official:moonfin', source: 'official', file: 'Moonfin.wgt', at: '2026-11-02T10:00:00.000Z' }],
              userSettings: { 'Jellyfin.wgt': { values: { server: 'http://192.168.1.5:8096', apiKey: 's3cr3t' }, at: '2026-11-03T10:00:00.000Z' } },
              relay: { enabled: true, port: 26202, allow: ['192.168.1.20'], chosen: true }, browser: { enabled: false } };
var made = backup.make(parts);
if (made.format !== 'a2s-tvstore-backup' || made.version !== 1 || made.secrets !== true || isNaN(new Date(made.madeAt).getTime())) fail('the head of a backup: ' + JSON.stringify([made.format, made.version, made.secrets, made.madeAt]));
var read = backup.parse(JSON.stringify(made));
if (read.error) fail('a backup must read back: ' + read.error);
var b = read.backup;
if (b.tv !== 'QE55Q60' || b.duid !== 'ABCDEFGH1234' || b.tvStore !== '0.3.40') fail('where a backup was made: ' + JSON.stringify([b.tv, b.duid, b.tvStore]));
if (JSON.stringify(b.page.settings) !== JSON.stringify({ showAdult: true, showNeedsHead: false, verboseLog: false, selfUpdate: true, hideSelfNotice: '0.3.40' })) fail('settings: ' + JSON.stringify(b.page.settings));
if (b.page.pins.length !== 1 || b.page.pins[0].file !== 'Moonfin.wgt') fail('pins: only the whole ones: ' + JSON.stringify(b.page.pins));
if (JSON.stringify(b.page.certChoice) !== '{"MoonPkg001":"partner"}') fail('certChoice: only public or partner: ' + JSON.stringify(b.page.certChoice));
if (b.page.webVersions.JellyPkg01.web !== '10.9.0' || b.page.variants.GonePkg001 !== 'Gone.wgt' || b.page.movedSeen.length !== 1) fail('the rest of the page part: ' + JSON.stringify(b.page));
if (!b.service.certificates || b.service.certificates.certificates.length !== 2 || b.service.certificates.primary !== idA || b.service.certificates.certificates[1].authorKeyPem !== B.authorKeyPem) fail('certificates must come back whole, keys included');
if (JSON.stringify(b.service.certByPackage) !== JSON.stringify({ MoonPkg001: idB })) fail('certByPackage: ' + JSON.stringify(b.service.certByPackage));
var s0 = b.service.sources[0];
if (b.service.sources.length !== 1 || s0.repositoryId !== 'org.example.tizen' || s0.fingerprint !== FP || s0.enabled !== false || s0.maintainer !== 'Someone' || s0.lastGeneratedAt !== SOURCE.lastGeneratedAt) fail('sources: ' + JSON.stringify(b.service.sources));
if (b.service.userSettings['Jellyfin.wgt'].values.apiKey !== 's3cr3t' || b.service.renames.length !== 1 || b.service.renames[0].newPackageId !== 'MoonPkg0a1') fail('app settings and renames: ' + JSON.stringify([b.service.userSettings, b.service.renames]));
if (JSON.stringify(b.service.relay) !== JSON.stringify({ enabled: true, port: 26202, allow: ['192.168.1.20'], chosen: true }) || b.service.browser.enabled !== false) fail('relay and browser: ' + JSON.stringify([b.service.relay, b.service.browser]));

var sum = backup.summary(b);
if (sum.pins !== 1 || sum.sources.length !== 1 || sum.sources[0].domain !== 'example.org' || sum.certificates.length !== 2 || sum.certificates[0].name !== 'PC - Public' || sum.userSettings !== 1 || !sum.settings) fail('summary: ' + JSON.stringify(sum));
if (/BEGIN|s3cr3t|192\.168\.1\.5/.test(JSON.stringify(sum))) fail('a summary must not carry a key or a value');

var lean = backup.parse(backup.make(parts, { secrets: false }));
if (lean.error || lean.backup.secrets !== false || lean.backup.service.certificates !== null || Object.keys(lean.backup.service.userSettings).length !== 0) fail('a backup without secrets has no certificates and no app settings');
if (/BEGIN|s3cr3t/.test(JSON.stringify(backup.make(parts, { secrets: false })))) fail('a backup without secrets must not carry a key or a value');
if (lean.backup.service.sources.length !== 1 || lean.backup.page.pins.length !== 1) fail('a backup without secrets keeps the rest');

[['not json', /not JSON/], ['{"format":"something-else","version":1}', /not a TV-Store backup/], ['[1,2]', /not a TV-Store backup/], [JSON.stringify({ format: backup.FORMAT, version: 2 }), /newer TV-Store/],
 [JSON.stringify({ format: backup.FORMAT }), /no version/], [new Array(backup.MAX_BYTES + 2).join('x'), /too big/]].forEach(function (c) {
    var r = backup.parse(c[0]);
    if (!r.error || !c[1].test(r.error)) fail('must be refused with ' + c[1] + ': ' + JSON.stringify(r).slice(0, 200));
});
var odd = backup.parse({ format: backup.FORMAT, version: 1, madeAt: 'yesterday', page: 'x', service: { certificates: { certificates: [{ name: 'half', authorKeyPem: 'x' }] }, sources: [{ url: 'http://plain.example/x', repositoryId: 'a.b', fingerprint: FP }, SOURCE, SOURCE],
    userSettings: { 'A.wgt': { values: { n: 5, ok: 'yes' } }, 'B.wgt': 'x' }, relay: { enabled: 'yes' }, browser: {}, sourceOf: [1] } });
if (odd.error) fail('an odd backup still reads: ' + odd.error);
var o = odd.backup;
if (o.madeAt !== '' || o.service.certificates !== null || o.service.sources.length !== 1 || JSON.stringify(o.service.userSettings['A.wgt'].values) !== '{"ok":"yes"}' || o.service.userSettings['B.wgt'] || o.service.relay !== null || o.service.browser !== null || Object.keys(o.page).length) fail('what is not understood is left out: ' + JSON.stringify(o));

var here = backup.forInstalled(b, ['MoonPkg001', 'MoonPkg0a1']);
if (JSON.stringify(here.sourceOf) !== '{"MoonPkg001":"org.example.tizen"}' || here.renames.length !== 1 || JSON.stringify(here.variants) !== '{"MoonPkg001":"Moonfin.wgt"}' || Object.keys(here.webVersions).length) fail('records only for packages on the TV: ' + JSON.stringify(here));
var none = backup.forInstalled(b, null);
if (Object.keys(none.sourceOf).length || none.renames.length || Object.keys(none.variants).length) fail('a wiped TV gets no package records');

var onlyB = certs.setDefault(certs.merge(null, certs.normalize({ certificates: [B] })), idB);
if (backup.mergeCertificates(null, b.service.certificates) !== b.service.certificates) fail('a TV without certificates takes the backup\'s store');
var both = backup.mergeCertificates(onlyB, b.service.certificates);
if (both.certificates.length !== 2 || both.certificates[0].id !== idB || both.primary !== idB || both.tvDefault !== idB) fail('an armed TV keeps its own first and its default: ' + JSON.stringify(certs.summary(both)));
if (backup.mergeCertificates(onlyB, null) !== onlyB) fail('a backup without certificates leaves the TV\'s');
if (backup.page('192.168.1.9').indexOf('Download the backup') < 0 || backup.page('<i>').indexOf('<i>') >= 0) fail('the backup page');

// ---- against the service --------------------------------------------------------------------------
var dirs = [], err = '';
function start(seed, then) {
    var dir = path.join(os.tmpdir(), 'a2s-backup-' + process.pid + '-' + Date.now() + '-' + dirs.length); fs.mkdirSync(dir); dirs.push(dir);
    Object.keys(seed).forEach(function (f) { fs.writeFileSync(path.join(dir, f), JSON.stringify(seed[f])); });   // what an earlier run of the service left
    err = '';
    child = cp.spawn(process.execPath, [path.join(__dirname, '..', 'tizen-app', 'service', 'index.js')], { env: { HOME: dir, TMPDIR: dir, TMP: dir, TEMP: dir, PATH: process.env.PATH, A2S_RELAY_PORT: '26291', A2S_SDB_PORT: '26192' }, stdio: ['ignore', 'ignore', 'pipe'] });
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
    var h = { }; if (data) { h['Content-Length'] = Buffer.byteLength(data); h['Content-Type'] = 'application/json'; }
    Object.keys(headers || {}).forEach(function (k) { h[k] = headers[k]; });
    var req = http.request({ host: '127.0.0.1', port: 8077, path: p, method: method, headers: h }, function (res) {
        var t = ''; res.on('data', function (d) { t += d; }); res.on('end', function () { var j = null; try { j = JSON.parse(t); } catch (e) {} cb(null, res.statusCode, j, t); });
    });
    req.on('error', function (e) { cb(e); });
    if (data) req.write(data);
    req.end();
}
function post(p, obj, cb, headers) { call('POST', p, typeof obj === 'string' ? obj : JSON.stringify(obj), function (e, code, j, t) { if (e) fail(p + ': ' + e.message); cb(code, j || {}, t); }, headers); }
function cleanup() { dirs.forEach(function (d) { try { fs.readdirSync(d).forEach(function (f) { try { fs.unlinkSync(path.join(d, f)); } catch (e) {} }); fs.rmdirSync(d); } catch (e) {} }); }
var WD = setTimeout(function () { fail('watchdog (40 s)' + (err ? '\n' + err : '')); }, 40000);

var taken = null;
start({ '.a2s-user-settings.json': parts.userSettings }, function (dir, token) {
    post('/cert', { certificates: [A, B] }, function (code, j) {
        if (!j.ok || j.certCount !== 2) fail('the hand-over: ' + JSON.stringify(j));
        post('/settings', { browser: { enabled: false }, relay: { enabled: false, port: 26292, allow: ['192.168.1.20'] } }, function (code, j) {
            if (!j.ok) fail('the settings: ' + JSON.stringify(j));
            post('/backup/make', { token: 'wrong', page: PAGE }, function (code, j) {
                if (code !== 403 || j.code !== 'NO_TOKEN' || j.backup) fail('a backup without the token must be refused: ' + code + ' ' + JSON.stringify(j).slice(0, 200));
                post('/backup/make', { token: token, page: PAGE, app: { version: '0.3.40', device: 'QE55Q60' }, secrets: false }, function (code, j) {
                    if (!j.ok || j.backup.secrets !== false || j.backup.service.certificates || /BEGIN/.test(JSON.stringify(j.backup))) fail('A2SStore.backup({ secrets: false }) must leave the keys out');
                    call('GET', '/backup', null, function (e, code, j, t) {
                        if (e || code !== 200 || t.indexOf('Back up TV-Store') < 0) fail('GET /backup is not the backup page (' + code + ')');
                        post('/backup/download', { code: '000000' }, function (code, j) {
                            if (code !== 403 || !/no code on the TV/.test(j.error)) fail('no download before the TV shows a code: ' + code + ' ' + JSON.stringify(j));
                            post('/backup/offer', { page: PAGE }, function (code, j) {
                                if (code !== 403) fail('a code without the token must be refused: ' + code);
                                wrongCodes(token);
                            });
                        });
                    });
                });
            });
        });
    });
});
function offer(token, cb) { post('/backup/offer', { token: token, page: PAGE, app: { version: '0.3.40', device: 'QE55Q60' } }, function (code, j) { if (!j.ok || !/^\d{6}$/.test(j.code) || isNaN(new Date(j.until).getTime())) fail('the code: ' + JSON.stringify(j)); cb(j.code); }); }
function other(code) { return code === '111111' ? '222222' : '111111'; }
function wrongCodes(token) {
    offer(token, function (code) {
        var n = 0;
        (function again() {
            post('/backup/download', { code: other(code) }, function (st, j) {
                if (st !== 403 || j.format) fail('a wrong code must be refused: ' + st);
                if (++n < 5) return again();
                if (!/Too many wrong tries/.test(j.error)) fail('the fifth wrong code voids it: ' + JSON.stringify(j));
                post('/backup/download', { code: code }, function (st, j) {
                    if (st !== 403) fail('a voided code must not work: ' + st);
                    download(token);
                });
            });
        })();
    });
}
function download(token) {
    offer(token, function (code) {
        post('/backup/download', { code: code }, function (st, j) {
            if (st !== 403) fail('a download from another web site must be refused: ' + st);
            post('/backup/download', { code: code }, function (st, j) {
                if (st !== 200 || j.format !== backup.FORMAT) fail('the right code gets the backup: ' + st + ' ' + JSON.stringify(j).slice(0, 200));
                taken = j;
                var sv = j.service;
                if (j.tv !== 'QE55Q60' || j.page.pins.length !== 1 || sv.certificates.certificates.length !== 2 || sv.certificates.certificates[0].authorKeyPem !== A.authorKeyPem || sv.userSettings['Jellyfin.wgt'].values.apiKey !== 's3cr3t'
                    || sv.browser.enabled !== false || sv.relay.enabled !== false || sv.relay.port !== 26292 || sv.relay.allow[0] !== '192.168.1.20') fail('what the backup holds: ' + JSON.stringify(j).replace(/-----BEGIN[^"]*/g, 'PEM').slice(0, 1500));
                call('GET', '/uploads', null, function (e, st, u) {
                    if (e || !u.backup || u.backup.open || !u.backup.taken || !u.backup.taken.from) fail('/uploads must say the backup was taken: ' + JSON.stringify(u));
                    post('/backup/download', { code: code }, function (st) {
                        if (st !== 403) fail('a code works once: ' + st);
                        stop(afterReset);
                    });
                });
            });
        }, { Origin: 'http://evil.example' });
    });
}
// The TV after a reset: a new, empty data folder.
function afterReset() {
    start({}, function (dir, token) {
        call('GET', '/ping', null, function (e, code, ping) {
            if (e || ping.certReady || ping.sources.length || ping.browser.enabled !== true) fail('the second service must start empty: ' + JSON.stringify(ping).slice(0, 300));
            post('/backup/restore', 'this is not a backup', function (st, j) {
                if (st !== 400 || j.ok) fail('junk must be refused: ' + st + ' ' + JSON.stringify(j));
                taken.service.sources = [SOURCE];
                taken.service.sourceOf = { MoonPkg001: 'org.example.tizen', GonePkg001: 'official' };
                taken.service.certByPackage = { MoonPkg001: idB };
                post('/backup/restore', JSON.stringify(taken), function (st, j) {
                    if (st !== 403) fail('a backup from another web site must be refused: ' + st);
                    post('/backup/restore', JSON.stringify(taken), function (st, j) {
                        if (st !== 200 || !j.ok || !j.restore.id || j.restore.summary.certificates.length !== 2 || j.restore.summary.sources[0].name !== 'Example' || /BEGIN|s3cr3t/.test(JSON.stringify(j))) fail('a backup must be taken and summed up without its keys: ' + st + ' ' + JSON.stringify(j).slice(0, 600));
                        var id = j.restore.id;
                        call('GET', '/ping', null, function (e, code, ping) {
                            if (ping.certReady || ping.sources.length) fail('nothing is restored before the TV says yes');
                            call('GET', '/uploads', null, function (e, code, u) {
                                if (!u.restore || u.restore.id !== id) fail('/uploads must name the waiting backup: ' + JSON.stringify(u));
                                post('/backup/apply', { token: 'wrong', id: id }, function (st, j) {
                                    if (st !== 403 || j.code !== 'NO_TOKEN') fail('a restore without the token must be refused: ' + st);
                                    post('/backup/apply', { token: token, id: 'another' }, function (st, j) {
                                        if (j.ok || j.code !== 'NO_RESTORE') fail('a restore of another id must be refused: ' + JSON.stringify(j));
                                        post('/backup/apply', { token: token, id: id, installed: ['MoonPkg001'] }, function (st, j) { restored(dir, token, id, j); });
                                    });
                                });
                            });
                        });
                    });
                }, { Origin: 'http://evil.example' });
            });
        });
    });
}
function restored(dir, token, id, j) {
    if (!j.ok || j.applied.certificates !== 2 || j.applied.sources !== 1 || j.applied.userSettings !== 1) fail('the restore: ' + JSON.stringify(j).slice(0, 600));
    if (j.page.pins.length !== 1 || j.page.settings.showAdult !== true || JSON.stringify(j.page.variants) !== '{"MoonPkg001":"Moonfin.wgt"}' || /BEGIN|s3cr3t/.test(JSON.stringify(j))) fail('the screen\'s part of the restore: ' + JSON.stringify(j.page));
    call('GET', '/ping', null, function (e, code, ping) {
        if (!ping.certReady || ping.certCount !== 2 || ping.certificates[0].name !== 'PC - Public' || !ping.certificates[0].primary) fail('the certificates are back: ' + JSON.stringify(ping.certificates));
        if (ping.sources.length !== 1 || ping.sources[0].repositoryId !== 'org.example.tizen' || ping.sources[0].enabled !== false) fail('the source is back, turned off as it was: ' + JSON.stringify(ping.sources));
        if (JSON.stringify(ping.sourceOf) !== '{"MoonPkg001":"org.example.tizen"}') fail('where apps came from, only for apps on the TV: ' + JSON.stringify(ping.sourceOf));
        if (ping.browser.enabled !== false || ping.relay.enabled !== false || ping.relay.configuredPort !== 26292 || !ping.relay.chosen) fail('the switches are back: ' + JSON.stringify([ping.browser, ping.relay]));
        if (JSON.stringify(ping.userSettings) !== '{"Jellyfin.wgt":["server","apiKey"]}' || !ping.remembered.MoonPkg001) fail('the apps\' settings and their certificates are back: ' + JSON.stringify([ping.userSettings, ping.remembered]));
        var saved = JSON.parse(fs.readFileSync(path.join(dir, '.a2s-user-settings.json'), 'utf8'));
        if (saved['Jellyfin.wgt'].values.apiKey !== 's3cr3t') fail('the apps\' settings are on disk');
        call('GET', '/uploads', null, function (e, code, u) {
            if (u.restore) fail('a restored backup no longer waits');
            post('/backup/apply', { token: token, id: id }, function (st, j) {
                if (j.ok) fail('a backup is restored once');
                // A second file, declined on the TV.
                post('/backup/take', { token: token, backup: taken }, function (st, j) {
                    if (!j.ok || j.restore.from !== 'Apps2Samsung') fail('A2SStore.restore hands a backup over: ' + JSON.stringify(j).slice(0, 300));
                    post('/backup/discard', { token: token, id: j.restore.id }, function (st, j) {
                        call('GET', '/uploads', null, function (e, code, u) {
                            if (u.restore) fail('a declined backup no longer waits');
                            clearTimeout(WD);
                            stop(function () { cleanup(); console.log('PASS: a backup reads back whole, leaves the TV only with the token or the code, and comes back after a reset once the TV says yes'); process.exit(0); });
                        });
                    });
                });
            });
        });
    });
}
