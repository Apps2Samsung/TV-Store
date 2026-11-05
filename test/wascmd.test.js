/* Installing through the TV's own wascmd from the service (TV-Store#57), against the real service, a
 * fake wascmd (a shell script that records its arguments and answers per a mode file) and a fake sdbd
 * for the fallback. With wascmd there, an install goes to it with -i <id> -p <signed file> and never
 * touches sdbd; its "install failed[...]" is read like vd_appinstall's (CERT_MISMATCH); when it did not
 * get to install ("cannot working in released image", or nothing said) the install falls back to sdbd
 * and says so in the log. The same over process.binding('spawn_sync'), the path a Tizen 4+ Node without
 * child_process takes. A2S_INSTALLER=sdb keeps wascmd out. /ping reports the installer. Since 0.3.20 (#57)
 * wascmd is off unless the switch in Settings turned it on; the first check proves that default.
 * After #67 and #68 (a Tizen 9 set's service died in the start-up probe): nothing is started before
 * the first install, the usage text is logged then; the switch in Settings (POST /settings
 * { installer: { mode } }) keeps wascmd out and survives a restart; a marker left by a run that died
 * inside wascmd, or a spawn that failed outright, keeps the service to sdbd until Settings says auto
 * again; a binary this service may not run is seen without a fork. */
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
    + 'if [ $# -eq 0 ]; then echo "usage: wascmd -i <appid> -p <path> | -u <appid>"; exit 1; fi\n'
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
var WD = setTimeout(function () { fail('watchdog (120 s)' + (err ? '\n' + err : '')); }, 120000);
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
function installProbe(cb, flags) {
    var before = shells.length, logBefore = fakeLog();
    call('PUT', '/upload?name=Probe.wgt', wgt, function (e, code, j) {
        if (e || code !== 200 || !j || !j.ok) fail('upload: ' + code + ' ' + JSON.stringify(j));
        var body = { upload: j.upload.id, token: token(), installed: true };
        Object.keys(flags || {}).forEach(function (k) { body[k] = flags[k]; });
        call('POST', '/install', JSON.stringify(body), function (e, code, j) {
            if (e || code !== 200 || !j) fail('install call: ' + code + ' ' + JSON.stringify(j));
            cb(j, shells.slice(before), fakeLog().slice(logBefore.length));
        });
    });
}
function sdbInstalls(calls) { return calls.filter(function (c) { return c.indexOf('vd_appinstall') >= 0; }).length; }
function logs(cb) { call('GET', '/logs', null, function (e, code, j) { cb((j && j.logs || []).join('\n')); }); }
var MARK = path.join(dir, '.a2s-wascmd-running');
function savedInstaller() { try { return JSON.parse(fs.readFileSync(path.join(dir, '.a2s-installer.json'), 'utf8')); } catch (e) { return null; } }
function settings(body, cb) { call('POST', '/settings', JSON.stringify(body), cb); }

var handlers = { shell: function (cmd) { shells.push(cmd); return cmd.indexOf('vd_appinstall') >= 0 ? 'install A2SProbe01.Probe package_path /x was_install_app return WAS_TRUE installing[100] app_id[A2SProbe01.Probe] install completed\n' : 'ok\n'; } };
fake.start(SDB, handlers, function (h) {
    handle = h;
    startService({}, function (ping) {
        // -1. Off by default (#57, 0.3.20): without a choice in the data folder the mode is sdb, the start-up
        //     log says so, an install goes to sdbd and the fake wascmd never runs, although it is there and
        //     runnable. The switch turns it on; that choice is saved (mode auto with optIn) and survives a
        //     restart. An older file saying mode auto without optIn (the default then) is not a choice.
        var i0 = ping.installer;
        if (!i0 || i0.mode !== 'sdb' || i0.env || !i0.wascmd || !i0.wascmd.available) fail('/ping must say sdb by default with wascmd available: ' + JSON.stringify(i0));
        call('POST', '/cert', JSON.stringify({ certificates: [CERT] }), function (e, code, j) {
        if (e || code !== 200 || !j.ok) fail('hand-over: ' + code + ' ' + JSON.stringify(j));
        logs(function (text) {
        if (!/installer: sdbd \(the TV's own installer, wascmd, is off, as it is by default; the switch in Settings turns it on\)/.test(text)) fail('the start-up log must say off by default:\n' + text);
        mode('ok');
        installProbe(function (j, calls, wl) {
            if (!j.ok || j.result.via !== 'sdb' || sdbInstalls(calls) !== 1 || wl) fail('by default the install must go to sdbd without running wascmd: ' + JSON.stringify(j) + ' ' + JSON.stringify(wl));
            fs.writeFileSync(path.join(dir, '.a2s-installer.json'), JSON.stringify({ mode: 'auto', off: null }));
            restart({}, function (ping) {
                if (ping.installer.mode !== 'sdb') fail('an old file with mode auto and no optIn must not turn wascmd on: ' + JSON.stringify(ping.installer));
                settings({ installer: { mode: 'auto' } }, function (e, code, j) {
                    if (e || code !== 200 || !j.ok || j.installer.mode !== 'auto') fail('switch on: ' + code + ' ' + JSON.stringify(j));
                    if (!savedInstaller() || savedInstaller().mode !== 'auto' || savedInstaller().optIn !== true) fail('the choice must be saved with optIn: ' + JSON.stringify(savedInstaller()));
                    restart({}, zero);
                });
            });
        });
        });
        });
    });
    function zero(ping) {
        // 0. /ping says wascmd is there, runnable, and will be tried first (the switch is on now).
        var inst = ping.installer;
        if (!inst || inst.mode !== 'auto' || inst.env || inst.off !== null || !inst.wascmd || !inst.wascmd.available || !inst.wascmd.executable || inst.wascmd.denied !== null || inst.wascmd.path !== FAKE || inst.wascmd.spawn !== 'child_process' || inst.last !== null) fail('/ping installer: ' + JSON.stringify(inst));
        (function (e, code, j) {
            // 0b. The start-up log says wascmd first, and that nothing was started for it (#67, #68): the
            //     usage text is not there yet, and no fake wascmd ran.
            logs(function (text) {
            if (!/installer: wascmd first \(.* via child_process\), sdbd as the fallback; nothing is started before the first install/.test(text)) fail('the start-up log must say wascmd first and nothing started:\n' + text);
            if (/wascmd without arguments says/.test(text)) fail('nothing may be started at start-up:\n' + text);
            if (fakeLog()) fail('the fake wascmd must not have run at start-up: ' + JSON.stringify(fakeLog()));
            // 1. wascmd installs: -i <app id> -p <the signed file, present at that moment>, sdbd untouched.
            //    The usage text is logged right before it, once; the marker is gone once wascmd answered.
            mode('ok');
            installProbe(function (j, calls, wl) {
                if (!j.ok || !j.result || j.result.via !== 'wascmd') fail('wascmd install must go through with via wascmd: ' + JSON.stringify(j));
                if (!/^args: -i A2SProbe01\.Probe -p \S+\.signed\.wgt$/m.test(wl) || wl.indexOf('file: exists') < 0) fail('wascmd must get -i <id> -p <signed file> that exists: ' + JSON.stringify(wl));
                if (sdbInstalls(calls)) fail('sdbd must not be used when wascmd installed: ' + JSON.stringify(calls));
                if (fs.existsSync(MARK)) fail('the marker must be taken down once wascmd answered');
                call('GET', '/ping', null, function (e, code, p) {
                    if (!p.installer || p.installer.last !== 'wascmd') fail('/ping must say the last install took wascmd: ' + JSON.stringify(p.installer));
                    logs(function (text) {
                    var m = text.match(/installer: wascmd without arguments says: usage: wascmd -i <appid> -p <path> \| -u <appid>/g);
                    if (!m || m.length !== 1) fail('the usage text must be logged once, before the first install:\n' + text);
                    if (text.indexOf('wascmd without arguments says') > text.indexOf('install: wascmd reply')) fail('the usage text must come before the first install:\n' + text);
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
        })(null, 200, { ok: true });
    }
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
            replaceWithoutSdb();
        });
    });
}

// 7. wascmd there, sdbd out of reach (Host PC IP at a phone): a plain install still goes through wascmd,
//    but a replace stops with REPLACE_NEEDS_SDB instead of hitting the same mismatch again.
function replaceWithoutSdb() {
    try { handle.server.close(); } catch (e) {}
    handle = null;
    restart({}, function (ping) {
        if (!ping.installer.wascmd.available) fail('wascmd must still be available: ' + JSON.stringify(ping.installer));
        mode('ok');
        installProbe(function (j) {
            if (!j.ok || j.result.via !== 'wascmd') fail('without sdbd a plain install still goes through wascmd: ' + JSON.stringify(j));
            installProbe(function (j, calls, wl) {
                if (j.ok || j.code !== 'REPLACE_NEEDS_SDB' || !/cannot remove the old copy/.test(j.error) || !/Apps menu/.test(j.error)) fail('a replace without sdbd must stop with REPLACE_NEEDS_SDB: ' + JSON.stringify(j));
                if (wl) fail('a refused replace must not run wascmd: ' + JSON.stringify(wl));
                settingsSwitch();
            }, { replace: true });
        });
    });
}

// 8. The switch in Settings (#67, #68): { installer: { mode: 'sdb' } } keeps wascmd out, is saved in the
//    data folder and survives a restart; 'auto' brings wascmd back (opt-in since 0.3.20, #57); bad blocks are refused with 400.
function settingsSwitch() {
    fake.start(SDB, handlers, function (h) {
        handle = h;
        var bad = [{ installer: 'sdb' }, { installer: { mode: 'x' } }, { installer: [] }, { installer: {} }];
        (function next(i) {
            if (i >= bad.length) return on();
            settings(bad[i], function (e, code, j) {
                if (e || code !== 400 || !j || j.ok) fail('settings ' + JSON.stringify(bad[i]) + ' must be refused with 400: ' + code + ' ' + JSON.stringify(j));
                next(i + 1);
            });
        })(0);
        function on() {
            settings({ installer: { mode: 'sdb' } }, function (e, code, j) {
                if (e || code !== 200 || !j || !j.ok || !j.installer || j.installer.mode !== 'sdb') fail('switch to sdb: ' + code + ' ' + JSON.stringify(j));
                if (!savedInstaller() || savedInstaller().mode !== 'sdb') fail('the switch must be saved: ' + JSON.stringify(savedInstaller()));
                mode('ok');
                installProbe(function (j, calls, wl) {
                    if (!j.ok || j.result.via !== 'sdb' || sdbInstalls(calls) !== 1 || wl) fail('with the switch on wascmd must not run: ' + JSON.stringify(j) + ' ' + JSON.stringify(wl));
                    restart({}, function (ping) {
                        if (ping.installer.mode !== 'sdb') fail('the switch must survive a restart: ' + JSON.stringify(ping.installer));
                        logs(function (text) {
                            if (!/installer: sdbd \(the TV's own installer, wascmd, is off, as it is by default; the switch in Settings turns it on\)/.test(text)) fail('the start-up log must say the switch is off:\n' + text);
                            if (savedInstaller().optIn) fail('off must drop optIn: ' + JSON.stringify(savedInstaller()));
                            settings({ installer: { mode: 'auto' } }, function (e, code, j) {
                                if (e || code !== 200 || !j.ok || j.installer.mode !== 'auto' || j.installer.off !== null) fail('back to auto: ' + JSON.stringify(j));
                                installProbe(function (j, calls, wl) {
                                    if (!j.ok || j.result.via !== 'wascmd' || !wl) fail('back at auto the install goes to wascmd again: ' + JSON.stringify(j) + ' ' + JSON.stringify(wl));
                                    marker();
                                });
                            });
                        });
                    });
                });
            });
        }
    });
}

// 9. The marker (#67, #68): a service that finds .a2s-wascmd-running at start knows the last run died
//    inside wascmd (the Tizen 9 start-up crash), says so, keeps to sdbd without a fork and remembers that
//    across restarts; Settings 'auto' forgets it.
function marker() {
    fs.writeFileSync(MARK, '2026-11-04T05:33:11.843Z');
    restart({}, function (ping) {
        var i = ping.installer;
        if (i.mode !== 'auto' || !i.off || !/ended while wascmd was running \(started 2026-11-04T05:33:11.843Z\)/.test(i.off.why) || !i.off.at) fail('/ping must say why wascmd is off: ' + JSON.stringify(i));
        if (fs.existsSync(MARK)) fail('the marker must be taken down once remembered');
        if (!savedInstaller() || !savedInstaller().off || savedInstaller().off.why !== i.off.why) fail('off must be saved: ' + JSON.stringify(savedInstaller()));
        logs(function (text) {
            if (!/installer: the last run of this service ended while wascmd was running \(started 2026-11-04T05:33:11.843Z\); sdbd only from now on/.test(text)) fail('the log must say the last run died in wascmd:\n' + text);
            if (!/installer: sdbd only \(the last run of this service ended while wascmd was running/.test(text)) fail('the installer line must say sdbd only:\n' + text);
            mode('ok');
            installProbe(function (j, calls, wl) {
                if (!j.ok || j.result.via !== 'sdb' || sdbInstalls(calls) !== 1 || wl) fail('after a death in wascmd the install must go to sdbd: ' + JSON.stringify(j) + ' ' + JSON.stringify(wl));
                restart({}, function (ping) {
                    if (!ping.installer.off) fail('off must survive a restart: ' + JSON.stringify(ping.installer));
                    settings({ installer: { mode: 'auto' } }, function (e, code, j) {
                        if (e || code !== 200 || !j.ok || j.installer.off !== null) fail('auto must forget it: ' + JSON.stringify(j));
                        installProbe(function (j, calls, wl) {
                            if (!j.ok || j.result.via !== 'wascmd' || !wl) fail('after auto the install goes to wascmd again: ' + JSON.stringify(j) + ' ' + JSON.stringify(wl));
                            if (fs.existsSync(MARK)) fail('the marker must be gone after wascmd answered');
                            spawnFailure();
                        });
                    });
                });
            });
        });
    });
}

// 10. A spawn that fails outright (the binary gone: ENOENT) falls back to sdbd and is remembered, so the
//     next install and the next start skip wascmd without a fork; Settings 'auto' lets it try again.
function spawnFailure() {
    var GONE = FAKE + '.gone';
    fs.renameSync(FAKE, GONE);
    mode('ok');
    installProbe(function (j, calls, wl) {
        fs.renameSync(GONE, FAKE);
        if (!j.ok || j.result.via !== 'sdb' || sdbInstalls(calls) !== 1 || wl) fail('a spawn failure must fall back to sdbd: ' + JSON.stringify(j) + ' ' + JSON.stringify(wl));
        logs(function (text) {
            if (!/wascmd did not install \(cannot run \S+: ENOENT\); falling back to sdbd/.test(text)) fail('the fallback must be in the log:\n' + text);
            if (!/installer: cannot run \S+: ENOENT; sdbd only from now on/.test(text)) fail('the spawn failure must be remembered in the log:\n' + text);
            call('GET', '/ping', null, function (e, code, p) {
                if (!p.installer.off || !/ENOENT/.test(p.installer.off.why)) fail('/ping must say off with ENOENT: ' + JSON.stringify(p.installer));
                installProbe(function (j, calls, wl) {
                    if (!j.ok || j.result.via !== 'sdb' || wl) fail('once remembered, wascmd is not tried again even though it is back: ' + JSON.stringify(j) + ' ' + JSON.stringify(wl));
                    restart({}, function (ping) {
                        if (!ping.installer.off || !/ENOENT/.test(ping.installer.off.why)) fail('the spawn failure must survive a restart: ' + JSON.stringify(ping.installer));
                        settings({ installer: { mode: 'auto' } }, function (e, code, j) {
                            if (e || code !== 200 || !j.ok || j.installer.off !== null) fail('auto must forget the spawn failure: ' + JSON.stringify(j));
                            notExecutable();
                        });
                    });
                });
            });
        });
    });
}

// 11. A binary this service may not run (mode 644, so access(2) says EACCES, as the Tizen 9 set's Smack
//     label does) is seen without a fork: /ping and the start-up log say so, installs go to sdbd, and the
//     fake is never started.
function notExecutable() {
    fs.chmodSync(FAKE, 420 /* 0644 */);
    restart({}, function (ping) {
        var w = ping.installer.wascmd;
        if (!w || w.available || w.executable || w.denied !== 'EACCES' || !w.present) fail('/ping must say the binary may not be run: ' + JSON.stringify(ping.installer));
        logs(function (text) {
            if (!/installer: sdbd \(\S+ is there, but this service may not run it: EACCES\)/.test(text)) fail('the start-up log must say EACCES without a fork:\n' + text);
            mode('ok');
            installProbe(function (j, calls, wl) {
                if (!j.ok || j.result.via !== 'sdb' || sdbInstalls(calls) !== 1 || wl) fail('EACCES must mean sdbd without trying: ' + JSON.stringify(j) + ' ' + JSON.stringify(wl));
                fs.chmodSync(FAKE, 493);
                stop();
                try { fs.readdirSync(dir).forEach(function (f) { fs.unlinkSync(path.join(dir, f)); }); fs.rmdirSync(dir); } catch (e) {}
                console.log('PASS: wascmd installs with -i <id> -p <signed file> and no sdbd, nothing is started before the first install and its usage is logged then, its refusal reads as CERT_MISMATCH, "released image" or silence falls back to sdbd, the same over spawn_sync, A2S_INSTALLER=sdb keeps it out, a replace without sdbd stops with REPLACE_NEEDS_SDB, the Settings switch keeps it out and survives a restart, a run that died inside wascmd or a spawn failure keeps the service to sdbd until Settings says auto, a binary it may not run is seen without a fork');
                process.exit(0);
            });
        });
    });
}
