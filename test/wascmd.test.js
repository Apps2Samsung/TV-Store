/* Installing through the TV's own wascmd from the service (TV-Store#57), against the real service, a
 * fake wascmd (a shell script that records its arguments and answers per a mode file) and a fake sdbd
 * for the fallback. With wascmd there, an install goes to it with -i <id> -p <signed file> and never
 * touches sdbd; its "install failed[...]" is read like vd_appinstall's (CERT_MISMATCH); when it did not
 * get to install ("cannot working in released image", or nothing said) the install falls back to sdbd
 * and says so in the log. The same over process.binding('spawn_sync'), the path a Tizen 4+ Node without
 * child_process takes. A2S_INSTALLER=sdb keeps wascmd out. /ping reports the installer. */
'use strict';
var fs = require('fs'), os = require('os'), path = require('path'), http = require('http'), cp = require('child_process');
var zip = require('../tizen-app/service/zip.js');
var Buf = require('../tizen-app/service/compat.js');
var fake = require('./fake-sdbd.js');
var wascmdMod = require('../tizen-app/service/wascmd.js');

function fail(m) { stop(); console.error('FAIL: ' + m); process.exit(1); }

// interpret(): both success wordings the sets use, the installer's refusal, and everything else unusable.
(function () {
    var i = wascmdMod.interpret;
    if (i('install X package_path /x was_install_app return WAS_TRUE installing[100] app_id[X] install completed\n') !== 'ok') fail('interpret: "install completed" is ok');
    if (i('spend time for wascmd is [12]ms\nappInstall return : [0]\n') !== 'ok') fail('interpret: "appInstall return : [0]" is ok');
    if (i('install X was_install_app return WAS_TRUE app_id[X] install failed[118, -12], reason: x') !== 'refused') fail('interpret: "install failed[" is refused');
    if (i('install X install failed[118012]') !== 'refused') fail('interpret: a six-digit code is refused');
    if (i('appInstall return : [-1]') !== 'unusable' || i('wascmd cannot working in released image') !== 'unusable' || i('') !== 'unusable' || i(null) !== 'unusable') fail('interpret: anything else is unusable');
})();
var SDB = 26189, F = path.join(__dirname, 'fixtures');
function pem(f) { return fs.readFileSync(path.join(F, f), 'utf8'); }
var CERT = { name: 'PC - Public', authorKeyPem: pem('author.key'), authorCertPem: pem('author.crt'), distributorKeyPem: pem('distributor.key'), distributorCertPem: pem('distributor.crt') };
var dir = path.join(os.tmpdir(), 'a2s-wascmd-' + process.pid + '-' + Date.now()); fs.mkdirSync(dir);
var wgt = zip.write([{ name: 'index.html', data: Buf.from('<html></html>') },
    { name: 'config.xml', data: Buf.from('<widget xmlns="http://www.w3.org/ns/widgets" xmlns:tizen="http://tizen.org/ns/widgets" version="1.0.0"><name>Probe</name><tizen:application id="A2SProbe01.Probe" package="A2SProbe01" required_version="2.3"/></widget>') }]);

// The fake wascmd: records "args: ..." and whether the package file was there, answers per the mode file.
var FAKE = path.join(dir, 'wascmd'), FAKE_LOG = path.join(dir, 'wascmd.log'), MODE = path.join(dir, 'wascmd.mode');
fs.writeFileSync(FAKE, '#!/bin/sh\n'
    + 'echo "args: $*" >> "$A2S_FAKE_WASCMD_LOG"\n'
    + 'if [ -f "$4" ]; then echo "file: exists" >> "$A2S_FAKE_WASCMD_LOG"; else echo "file: missing" >> "$A2S_FAKE_WASCMD_LOG"; fi\n'
    + 'mode=$(cat "$A2S_FAKE_WASCMD_MODE" 2>/dev/null || echo ok)\n'
    + 'case "$mode" in\n'
    + '  ok) echo "install $2 package_path $4 was_install_app return WAS_TRUE installing[100] app_id[$2] install completed"; exit 0;;\n'
    + '  refused) echo "install $2 package_path $4 was_install_app return WAS_TRUE app_id[$2] install start installing[7] install failed[118, -12], reason: Check certificate error : :Package with the same id and different certificate has been already installed.:<-12>"; exit 0;;\n'
    + '  released) echo "wascmd cannot working in released image"; exit 1;;\n'
    + '  silent) exit 1;;\n'
    + 'esac\n');
fs.chmodSync(FAKE, 493 /* 0755 */);
function mode(m) { fs.writeFileSync(MODE, m); }
function fakeLog() { try { return fs.readFileSync(FAKE_LOG, 'utf8'); } catch (e) { return ''; } }

var shells = [];
var child = null, err = '', handle = null;
var WD = setTimeout(function () { fail('watchdog (60 s)' + (err ? '\n' + err : '')); }, 60000);
function stop() { clearTimeout(WD); if (child) child.kill(); if (handle && handle.server) try { handle.server.close(); } catch (e) {} }

function startService(extraEnv, cb) {
    var env = { HOME: dir, TMPDIR: dir, TMP: dir, TEMP: dir, PATH: process.env.PATH, A2S_SDB_PORT: String(SDB), A2S_WASCMD: FAKE, A2S_FAKE_WASCMD_LOG: FAKE_LOG, A2S_FAKE_WASCMD_MODE: MODE };
    Object.keys(extraEnv || {}).forEach(function (k) { env[k] = extraEnv[k]; });
    child = cp.spawn(process.execPath, [path.join(__dirname, '..', 'tizen-app', 'service', 'index.js')], { env: env, stdio: ['ignore', 'ignore', 'pipe'] });
    child.stderr.on('data', function (d) { err += d; });
    var tries = 0;
    (function waitUp() {
        call('GET', '/ping', null, function (e, code, j) {
            if (e || code !== 200) { if (++tries > 100 || child.exitCode !== null) fail('the service never answered /ping' + (err ? '\n' + err : '')); return setTimeout(waitUp, 100); }
            cb(j);
        });
    })();
}
function restart(extraEnv, cb) {
    var old = child; child = null;
    old.once('exit', function () { startService(extraEnv, cb); });
    old.kill();
}

function call(method, p, data, cb) {
    var req = http.request({ host: '127.0.0.1', port: 8077, path: p, method: method, headers: data ? { 'Content-Length': data.length, 'Content-Type': typeof data === 'string' ? 'application/json' : 'application/octet-stream' } : {} }, function (res) {
        var b = ''; res.on('data', function (d) { b += d; }); res.on('end', function () { var j = null; try { j = JSON.parse(b); } catch (e) {} cb(null, res.statusCode, j, b); });
    });
    req.on('error', function (e) { cb(e); });
    if (data) req.write(data);
    req.end();
}
function token() { return fs.readFileSync(path.join(dir, '.a2s-upload-token'), 'utf8').trim(); }
function installProbe(cb) {
    var before = shells.length, logBefore = fakeLog();
    call('PUT', '/upload?name=Probe.wgt', wgt, function (e, code, j) {
        if (e || code !== 200 || !j || !j.ok) fail('upload: ' + code + ' ' + JSON.stringify(j));
        call('POST', '/install', JSON.stringify({ upload: j.upload.id, token: token(), installed: true }), function (e, code, j) {
            if (e || code !== 200 || !j) fail('install call: ' + code + ' ' + JSON.stringify(j));
            cb(j, shells.slice(before), fakeLog().slice(logBefore.length));
        });
    });
}
function sdbInstalls(calls) { return calls.filter(function (c) { return c.indexOf('vd_appinstall') >= 0; }).length; }
function logs(cb) { call('GET', '/logs', null, function (e, code, j) { cb((j && j.logs || []).join('\n')); }); }

fake.start(SDB, { shell: function (cmd) { shells.push(cmd); return cmd.indexOf('vd_appinstall') >= 0 ? 'install A2SProbe01.Probe package_path /x was_install_app return WAS_TRUE installing[100] app_id[A2SProbe01.Probe] install completed\n' : 'ok\n'; } }, function (h) {
    handle = h;
    startService({}, function (ping) {
        // 0. /ping says wascmd is there and will be tried first.
        var inst = ping.installer;
        if (!inst || inst.mode !== 'auto' || !inst.wascmd || !inst.wascmd.available || inst.wascmd.path !== FAKE || inst.wascmd.spawn !== 'child_process' || inst.last !== null) fail('/ping installer: ' + JSON.stringify(inst));
        call('POST', '/cert', JSON.stringify({ certificates: [CERT] }), function (e, code, j) {
            if (e || code !== 200 || !j.ok) fail('hand-over: ' + code + ' ' + JSON.stringify(j));
            // 1. wascmd installs: -i <app id> -p <the signed file, present at that moment>, sdbd untouched.
            mode('ok');
            installProbe(function (j, calls, wl) {
                if (!j.ok || !j.result || j.result.via !== 'wascmd') fail('wascmd install must go through with via wascmd: ' + JSON.stringify(j));
                if (!/^args: -i A2SProbe01\.Probe -p \S+\.signed\.wgt$/m.test(wl) || wl.indexOf('file: exists') < 0) fail('wascmd must get -i <id> -p <signed file> that exists: ' + JSON.stringify(wl));
                if (sdbInstalls(calls)) fail('sdbd must not be used when wascmd installed: ' + JSON.stringify(calls));
                call('GET', '/ping', null, function (e, code, p) {
                    if (!p.installer || p.installer.last !== 'wascmd') fail('/ping must say the last install took wascmd: ' + JSON.stringify(p.installer));
                    // 2. wascmd's own refusal is read like vd_appinstall's: the certificate mismatch, no sdbd.
                    mode('refused');
                    installProbe(function (j, calls) {
                        if (j.ok || j.code !== 'CERT_MISMATCH' || j.error.indexOf('None of the 1 certificate') < 0) fail('a refusal from wascmd must read as CERT_MISMATCH: ' + JSON.stringify(j));
                        if (sdbInstalls(calls)) fail('a refusal from wascmd needs no sdbd: ' + JSON.stringify(calls));
                        // 3. wascmd never got to install: fall back to sdbd, and say so.
                        mode('released');
                        installProbe(function (j, calls) {
                            if (!j.ok || j.result.via !== 'sdb' || sdbInstalls(calls) !== 1) fail('"cannot working in released image" must fall back to sdbd: ' + JSON.stringify(j) + ' ' + JSON.stringify(calls));
                            logs(function (text) {
                                if (!/wascmd did not install \(exit 1, said: wascmd cannot working in released image\); falling back to sdbd/.test(text)) fail('the fallback must be in the log:\n' + text);
                                // 4. Nothing said at all: the same fallback.
                                mode('silent');
                                installProbe(function (j, calls) {
                                    if (!j.ok || j.result.via !== 'sdb' || sdbInstalls(calls) !== 1) fail('a silent wascmd must fall back to sdbd: ' + JSON.stringify(j));
                                    logs(function (text) {
                                        if (!/wascmd did not install \(exit 1, said nothing\); falling back to sdbd/.test(text)) fail('the silent fallback must be in the log:\n' + text);
                                        spawnSync();
                                    });
                                });
                            });
                        });
                    });
                });
            });
        });
    });
});

// 5. The binding path (a Tizen 4+ Node without child_process): the same install goes through wascmd.
function spawnSync() {
    restart({ A2S_SPAWN: 'spawn_sync' }, function (ping) {
        if (!ping.installer.wascmd.available || ping.installer.wascmd.spawn !== 'spawn_sync') fail('/ping must say spawn_sync: ' + JSON.stringify(ping.installer));
        mode('ok');
        installProbe(function (j, calls, wl) {
            if (!j.ok || j.result.via !== 'wascmd' || sdbInstalls(calls)) fail('spawn_sync install: ' + JSON.stringify(j) + ' ' + JSON.stringify(calls));
            if (!/^args: -i A2SProbe01\.Probe -p \S+\.signed\.wgt$/m.test(wl) || wl.indexOf('file: exists') < 0) fail('spawn_sync must pass the same arguments: ' + JSON.stringify(wl));
            // 5b. A refusal over the binding, and the fallback over the binding.
            mode('released');
            installProbe(function (j, calls) {
                if (!j.ok || j.result.via !== 'sdb' || sdbInstalls(calls) !== 1) fail('spawn_sync fallback: ' + JSON.stringify(j));
                sdbOnly();
            });
        });
    });
}

// 6. A2S_INSTALLER=sdb: wascmd is left alone even though it is there.
function sdbOnly() {
    restart({ A2S_INSTALLER: 'sdb' }, function (ping) {
        if (ping.installer.mode !== 'sdb') fail('/ping must say mode sdb: ' + JSON.stringify(ping.installer));
        mode('ok');
        installProbe(function (j, calls, wl) {
            if (!j.ok || j.result.via !== 'sdb' || sdbInstalls(calls) !== 1 || wl) fail('A2S_INSTALLER=sdb must not run wascmd: ' + JSON.stringify(j) + ' ' + JSON.stringify(wl));
            stop();
            try { fs.readdirSync(dir).forEach(function (f) { fs.unlinkSync(path.join(dir, f)); }); fs.rmdirSync(dir); } catch (e) {}
            console.log('PASS: wascmd installs with -i <id> -p <signed file> and no sdbd, its refusal reads as CERT_MISMATCH, "released image" or silence falls back to sdbd, the same over spawn_sync, A2S_INSTALLER=sdb keeps it out');
            process.exit(0);
        });
    });
}
