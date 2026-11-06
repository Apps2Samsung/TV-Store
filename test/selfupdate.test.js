/* TV-Store updating itself (#41, experiment): selfupdate.js's helpers, then the real service with a
 * fake sdbd whose installer stops TV-Store the way the TV's does. TV-Store's own package (the
 * test's A2S_PACKAGE_ID) is refused without the Settings switch and as a replace, a refusal by the
 * TV leaves no marker, and an install that stops the service leaves one, which the next start
 * reports on /ping with the dead run's log lines until the page acknowledges it. */
'use strict';
var fs = require('fs'), os = require('os'), path = require('path'), http = require('http'), cp = require('child_process');
var zip = require('../tizen-app/service/zip.js');
var Buf = require('../tizen-app/service/compat.js');
var fake = require('./fake-sdbd.js');
var su = require('../tizen-app/service/selfupdate.js');
function fail(m) { stop(); console.error('FAIL: ' + m); process.exit(1); }

// ---- the helpers --------------------------------------------------------------------------------
if (!su.isOwn({ packageId: 'A2STVStore' }, 'A2STVStore') || !su.isOwn({ appId: 'A2STVStore.Store' }, 'A2STVStore')) fail('isOwn by package or app id');
if (su.isOwn({ packageId: 'AprZAARz4r' }, 'A2STVStore') || su.isOwn({}, 'A2STVStore') || su.isOwn({ packageId: 'A2STVStore' }, '')) fail('isOwn of another package');
if (su.refusal({}).code !== 'SELF_UPDATE_OFF' || su.refusal({ selfUpdate: 'yes' }).code !== 'SELF_UPDATE_OFF') fail('only selfUpdate: true opens it');
if (su.refusal({ selfUpdate: true, replace: true }).code !== 'SELF_REPLACE' || su.refusal({ selfUpdate: true }) !== null) fail('refusal of a replace');
var log = ['2026-11-06T10:00:00.000Z old', '2026-11-06T10:05:00.000Z install: pushing', 'not a log line', '2026-11-06T10:06:00.000Z self-update: sending'].join('\n');
if (su.linesSince(log, '2026-11-06T10:04:00.000Z').join('|') !== '2026-11-06T10:05:00.000Z install: pushing|2026-11-06T10:06:00.000Z self-update: sending') fail('linesSince');
if (su.linesSince(log, '2026-11-06T10:04:00.000Z', 1).length !== 1 || su.linesSince(log, 'junk').length !== 0) fail('linesSince limits');
var mk = su.marker({ fromVersion: '0.3.20', toVersion: '0.3.21', selfCert: 'PC - Public', file: 'TV-Store.wgt' }, 'T');
if (mk.from !== '0.3.20' || mk.to !== '0.3.21' || mk.at !== 'T' || mk.certificate !== 'PC - Public') fail('marker: ' + JSON.stringify(mk));
if (su.outcome(mk, '0.3.21') !== 'landed' || su.outcome(mk, '0.3.20') !== 'not-landed' || su.outcome(mk, '0.4.0') !== 'unknown' || su.outcome(null, '1') !== 'unknown') fail('outcome');

// ---- the service --------------------------------------------------------------------------------
var SDB = 26198, F = path.join(__dirname, 'fixtures'), OWN = 'A2SProbeS1';
function pem(f) { return fs.readFileSync(path.join(F, f), 'utf8'); }
var PUB = { name: 'PC - Public', authorKeyPem: pem('author.key'), authorCertPem: pem('author.crt'), distributorKeyPem: pem('public-distributor.key'), distributorCertPem: pem('public-distributor.crt') };
var dir = path.join(os.tmpdir(), 'a2s-selfupdate-' + process.pid + '-' + Date.now()); fs.mkdirSync(dir);
var SELF = zip.write([{ name: 'index.html', data: Buf.from('<html></html>') },
    { name: 'config.xml', data: Buf.from('<widget xmlns="http://www.w3.org/ns/widgets" xmlns:tizen="http://tizen.org/ns/widgets" version="0.3.21"><name>TV-Store</name><tizen:application id="' + OWN + '.Store" package="' + OWN + '" required_version="3.0"/></widget>') }]);
var REFUSED = 'install ' + OWN + '.Store package_path /x was_install_app return WAS_TRUE app_id[' + OWN + '.Store] install failed[118, -12], reason: Check certificate error : :Package with the same id and different certificate has been already installed.:<-12>\n';
var OK = 'install ' + OWN + '.Store installing[100] install completed\n';
var mode = 'refuse', shells = [], child = null, err = '', handle = null;
var WD = setTimeout(function () { fail('watchdog (60 s)' + (err ? '\n' + err : '')); }, 60000);
function stop() { clearTimeout(WD); if (child) child.kill(); if (handle) try { handle.server.close(); } catch (e) {} }
var MARK = path.join(dir, '.a2s-self-update.json');

function start(cb) {
    child = cp.spawn(process.execPath, [path.join(__dirname, '..', 'tizen-app', 'service', 'index.js')], { env: { HOME: dir, TMPDIR: dir, TMP: dir, TEMP: dir, PATH: process.env.PATH, A2S_SDB_PORT: String(SDB), A2S_PACKAGE_ID: OWN }, stdio: ['ignore', 'ignore', 'pipe'] });
    child.stderr.on('data', function (d) { err += d; });
    var tries = 0;
    (function waitUp() {
        call('GET', '/ping', null, function (e, code, j) {
            if (e || code !== 200) { if (++tries > 100) fail('the service never answered /ping' + (err ? '\n' + err : '')); return setTimeout(waitUp, 100); }
            cb(j);
        });
    })();
}
fake.start(SDB, {
    shell: function (cmd) {
        shells.push(cmd);
        if (cmd.indexOf('vd_appinstall') < 0) return 'ok\n';
        if (mode === 'refuse') return REFUSED;
        // The TV's installer stops every process of the package it replaces: here, the service.
        child.kill('SIGKILL');
        return OK;
    }
}, function (h) { handle = h; start(run); });

function call(method, p, data, cb) {
    var req = http.request({ host: '127.0.0.1', port: 8077, path: p, method: method, headers: data ? { 'Content-Length': data.length, 'Content-Type': typeof data === 'string' ? 'application/json' : 'application/octet-stream' } : {} }, function (res) {
        var b = ''; res.on('data', function (d) { b += d; }); res.on('end', function () { var j = null; try { j = JSON.parse(b); } catch (e) {} cb(null, res.statusCode, j, b); });
    });
    req.on('error', function (e) { cb(e); });
    if (data) req.write(data);
    req.end();
}
function token() { return fs.readFileSync(path.join(dir, '.a2s-upload-token'), 'utf8').trim(); }
// Upload TV-Store's own package and install it with the given flags; cb(error, answer, installShellCalls).
function installSelf(flags, cb) {
    var before = shells.length;
    call('PUT', '/upload?name=TV-Store.wgt', SELF, function (e, code, j) {
        if (e || code !== 200 || !j || !j.ok) fail('upload: ' + code + ' ' + JSON.stringify(j));
        var b = { upload: j.upload.id, token: token(), installed: true };
        Object.keys(flags).forEach(function (k) { b[k] = flags[k]; });
        call('POST', '/install', JSON.stringify(b), function (e, code, j) {
            cb(e, j, shells.slice(before).filter(function (c) { return c.indexOf('vd_appinstall') >= 0; }).length);
        });
    });
}
function logs(cb) { call('GET', '/logs', null, function (e, code, j) { cb((j && j.logs || []).join('\n')); }); }

function run(ping) {
    if (ping.selfUpdate !== null) fail('no marker on a fresh service: ' + JSON.stringify(ping.selfUpdate));
    call('POST', '/cert', JSON.stringify({ certificates: [PUB] }), function () {
        // 1. Without the switch: refused, nothing sent to sdbd.
        installSelf({}, function (e, j, n) {
            if (e || j.ok || j.code !== 'SELF_UPDATE_OFF' || n !== 0) fail('without the switch: ' + JSON.stringify(j) + ' ' + n);
            // 2. As a replace: refused, nothing removed or sent.
            installSelf({ selfUpdate: true, replace: true }, function (e, j, n) {
                if (e || j.ok || j.code !== 'SELF_REPLACE' || n !== 0 || shells.some(function (c) { return c.indexOf('vd_appuninstall') >= 0; })) fail('as a replace: ' + JSON.stringify(j));
                // 3. The TV refuses it: the service is still there, says so, and leaves no marker.
                installSelf({ selfUpdate: true, fromVersion: '0.3.20' }, function (e, j, n) {
                    if (e || j.ok || j.code !== 'CERT_MISMATCH' || n !== 1) fail('refused by the TV: ' + JSON.stringify(j) + ' ' + n);
                    if (fs.existsSync(MARK)) fail('a refused self-update leaves no marker');
                    // 4. The installer stops the service mid-install.
                    mode = 'kill';
                    installSelf({ selfUpdate: true, fromVersion: '0.3.20' }, function () {
                        var waited = 0;
                        (function dead() { if (child.exitCode === null && child.signalCode === null) { if (++waited > 50) fail('the service was not stopped'); return setTimeout(dead, 100); } afterKill(); })();
                    });
                });
            });
        });
    });
}
function afterKill() {
    var mark = JSON.parse(fs.readFileSync(MARK, 'utf8'));
    if (mark.from !== '0.3.20' || mark.to !== '0.3.21' || mark.certificate !== 'PC - Public' || !mark.at) fail('the marker: ' + JSON.stringify(mark));
    // The next start (the user opens TV-Store again): /ping reports it with the dead run's lines.
    start(function (ping) {
        var s = ping.selfUpdate;
        if (!s || s.to !== '0.3.21' || !Array.isArray(s.lines) || !s.lines.some(function (l) { return l.indexOf('self-update: sending vd_appinstall') >= 0; })) fail('/ping after the restart: ' + JSON.stringify(s));
        if (!JSON.parse(fs.readFileSync(MARK, 'utf8')).lines) fail('the lines are kept in the marker for a second restart');
        call('POST', '/selfupdate/ack', JSON.stringify({ version: '0.3.21' }), function (e, code, j) {
            if (e || !j || !j.ok || fs.existsSync(MARK)) fail('ack: ' + JSON.stringify(j));
            call('GET', '/ping', null, function (e, code, j) {
                if (j.selfUpdate !== null) fail('acknowledged, the marker is gone from /ping');
                logs(function (text) {
                    if (text.indexOf('self-update: the last run sent an update of TV-Store to v0.3.21') < 0 || text.indexOf('self-update: the update to v0.3.21 sent at ' + mark.at + ' landed') < 0) fail('the log:\n' + text);
                    stop();
                    try { fs.readdirSync(dir).forEach(function (f) { try { fs.unlinkSync(path.join(dir, f)); } catch (x) {} }); fs.rmdirSync(dir); } catch (x) {}
                    console.log('PASS: self-update: refused without the switch and as a replace, no marker after a TV refusal, a marker after the installer stops the service, reported on /ping with the dead run\'s lines until acknowledged');
                    process.exit(0);
                });
            });
        });
    });
}
