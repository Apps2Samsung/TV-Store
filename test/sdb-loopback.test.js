/* Install works whether Developer Mode's Host PC IP is the TV's own IP or 127.0.0.1 (#52), against
 * the real service and a fake sdbd that gates like the real one: it accepts a connection only on the
 * address Host PC IP names and drops the rest before CNXN. A rooted TV is pinned at 127.0.0.1, where
 * the LAN attempt is dropped and loopback must carry the install; the address that worked is then
 * reused, so the second install does not retry the dead one. Host PC IP at a phone or PC (neither
 * the TV's IP nor loopback) is turned away with HOST_PC_IP, and a PC holding sdbd through the relay with
 * SDB_BUSY (#73). The service runs as a child with its data
 * folder in a temp dir and sdbd pointed at the fake through A2S_SDB_PORT. */
'use strict';
var fs = require('fs'), os = require('os'), path = require('path'), http = require('http'), net = require('net'), cp = require('child_process');
var zip = require('../tizen-app/service/zip.js');
var Buf = require('../tizen-app/service/compat.js');
var fake = require('./fake-sdbd.js');

function fail(m) { stop(); console.error('FAIL: ' + m); process.exit(1); }
var SDB = 26195, F = path.join(__dirname, 'fixtures');
function pem(f) { return fs.readFileSync(path.join(F, f), 'utf8'); }
var CERT = { name: 'PC - Public', authorKeyPem: pem('author.key'), authorCertPem: pem('author.crt'), distributorKeyPem: pem('distributor.key'), distributorCertPem: pem('distributor.crt') };
var dir = path.join(os.tmpdir(), 'a2s-loopback-' + process.pid + '-' + Date.now()); fs.mkdirSync(dir);
// The relay's start-up check (0.3.28) connects to sdbd once, a second after start; this test counts
// sdbd's connections, so it starts with the relay off by choice, which skips that check.
fs.writeFileSync(path.join(dir, '.a2s-relay.json'), JSON.stringify({ enabled: false }));
fs.writeFileSync(path.join(dir, '.a2s-duid'), 'TESTDUID12345');   // known already: the start-up read of it stays off sdbd
var wgt = zip.write([{ name: 'index.html', data: Buf.from('<html></html>') },
    { name: 'config.xml', data: Buf.from('<widget xmlns="http://www.w3.org/ns/widgets" xmlns:tizen="http://tizen.org/ns/widgets" version="1.0.0"><name>Probe</name><tizen:application id="A2SProbe01.Probe" package="A2SProbe01" required_version="2.3"/></widget>') }]);

var child = null, err = '', handle = null;
var WD = setTimeout(function () { fail('watchdog (40 s)' + (err ? '\n' + err : '')); }, 40000);
function stop() { clearTimeout(WD); if (child) child.kill(); if (handle && handle.server) try { handle.server.close(); } catch (e) {} }

// The fake gates on 127.0.0.1: a connection to the runner's LAN IP (what the service tries first) is
// dropped, loopback is accepted. Bound to every interface so the LAN attempt actually reaches it.
fake.start(SDB, { bind: '0.0.0.0', hostPcIp: '127.0.0.1', single: true, shell: function (cmd) {
    if (cmd.indexOf('vd_appinstall') >= 0) return 'install A2SProbe01.Probe package_path /x was_install_app return WAS_TRUE installing[100] app_id[A2SProbe01.Probe] install completed\n';
    return 'ok\n';
} }, function (h) {
    handle = h;
    child = cp.spawn(process.execPath, [path.join(__dirname, '..', 'tizen-app', 'service', 'index.js')], { env: { HOME: dir, TMPDIR: dir, TMP: dir, TEMP: dir, PATH: process.env.PATH, A2S_SDB_PORT: String(SDB) }, stdio: ['ignore', 'ignore', 'pipe'] });
    child.stderr.on('data', function (d) { err += d; });
    var tries = 0;
    (function waitUp() {
        call('GET', '/ping', null, function (e, code) {
            if (e || code !== 200) { if (++tries > 100 || child.exitCode !== null) fail('the service never answered /ping' + (err ? '\n' + err : '')); return setTimeout(waitUp, 100); }
            run();
        });
    })();
});

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
    call('PUT', '/upload?name=Probe.wgt', wgt, function (e, code, j) {
        if (e || code !== 200 || !j || !j.ok) fail('upload: ' + code + ' ' + JSON.stringify(j));
        call('POST', '/install', JSON.stringify({ upload: j.upload.id, token: token(), installed: true }), function (e, code, j) {
            if (e || code !== 200 || !j) fail('install call: ' + code + ' ' + JSON.stringify(j));
            cb(j);
        });
    });
}

function run() {
    // Hand over a certificate once.
    call('POST', '/cert', JSON.stringify({ certificates: [CERT] }), function (e, code, j) {
        if (e || code !== 200 || !j.ok) fail('hand-over: ' + code + ' ' + JSON.stringify(j));
        // 1. Host PC IP = 127.0.0.1: the LAN attempt is dropped, loopback carries the install.
        installProbe(function (j) {
            if (!j.ok) fail('install must go through over loopback when Host PC IP is 127.0.0.1: ' + JSON.stringify(j));
            var afterFirst = handle.drops;   // one drop (the LAN attempt) when the runner has a LAN IP, else none
            // 2. The address that worked is remembered: the second install goes straight to loopback, no new drop.
            installProbe(function (j) {
                if (!j.ok) fail('second install: ' + JSON.stringify(j));
                if (handle.drops !== afterFirst) fail('the remembered loopback address must be tried first (no new drop): ' + afterFirst + ' -> ' + handle.drops);
                busy();
            });
        });
    });
}

// 3. sdbd takes one client at a time (#73): while a PC holds a session through the relay, sdbd drops the
//    service's own connection the same silent way a wrong Host PC IP does. The service sees the relay's
//    open session and says SDB_BUSY, not HOST_PC_IP; once the PC is gone the install goes through again.
var RELAY = 26197;
function busy() {
    call('POST', '/settings', JSON.stringify({ relay: { enabled: true, port: RELAY } }), function (e, code, j) {
        if (e || code !== 200 || !j || !j.ok || !j.relay || !j.relay.listening) fail('relay on: ' + code + ' ' + JSON.stringify(j));
        var pc = net.connect(RELAY, '127.0.0.1');
        pc.on('error', function (e) { fail('the PC\'s relay session died: ' + e.message); });
        pc.on('connect', function () {
            // The relay dials sdbd as the PC connects; give it a moment to be the live client there.
            setTimeout(function () {
                if (handle.live !== 1) fail('the relayed session must be the live client at the fake: live=' + handle.live);
                installProbe(function (j) {
                    if (j.ok || j.code !== 'SDB_BUSY' || !/through the relay \(1 session\)/.test(j.error) || /Host PC IP/.test(j.error)) fail('an install while a PC holds the relay must be SDB_BUSY naming the session, not HOST_PC_IP: ' + JSON.stringify(j));
                    if (!handle.busyDrops) fail('the fake must have dropped the service as a second client');
                    pc.removeAllListeners('error'); pc.destroy();
                    setTimeout(function () {
                        installProbe(function (j) {
                            if (!j.ok) fail('with the PC gone the install must go through again: ' + JSON.stringify(j));
                            phoneOrPc();
                        });
                    }, 300);
                });
            }, 300);
        });
    });
}

function phoneOrPc() {
    // Stop the first service and wait for it to let go of port 8077 before the second binds it.
    if (handle && handle.server) try { handle.server.close(); } catch (e) {}
    var first = child;
    first.once('exit', startSecond);
    first.kill();
}
function startSecond() {
    child = null;
    // A fresh service whose fake accepts only a third address: both the TV's IP and loopback are
    // dropped, so the install is turned away with HOST_PC_IP.
    var SDB2 = 26196;
    fake.start(SDB2, { bind: '0.0.0.0', hostPcIp: '203.0.113.9', shell: function () { return 'ok\n'; } }, function (h) {
        handle = h;
        child = cp.spawn(process.execPath, [path.join(__dirname, '..', 'tizen-app', 'service', 'index.js')], { env: { HOME: dir, TMPDIR: dir, TMP: dir, TEMP: dir, PATH: process.env.PATH, A2S_SDB_PORT: String(SDB2) }, stdio: ['ignore', 'ignore', 'pipe'] });
        child.stderr.on('data', function (d) { err += d; });
        var tries = 0;
        (function waitUp() {
            call('GET', '/ping', null, function (e, code) {
                if (e || code !== 200) { if (++tries > 100 || child.exitCode !== null) fail('the second service never answered /ping' + (err ? '\n' + err : '')); return setTimeout(waitUp, 100); }
                installProbe(function (j) {
                    if (j.ok || j.code !== 'HOST_PC_IP' || j.error.indexOf('127.0.0.1') < 0) fail('Host PC IP at a phone or PC must give HOST_PC_IP naming 127.0.0.1: ' + JSON.stringify(j));
                    stop();
                    try { fs.readdirSync(dir).forEach(function (f) { fs.unlinkSync(path.join(dir, f)); }); fs.rmdirSync(dir); } catch (e) {}
                    console.log('PASS: install works over loopback when Host PC IP is 127.0.0.1, the working address is remembered, a PC holding the relay gives SDB_BUSY (#73), and a Host PC IP of a phone or PC gives HOST_PC_IP');
                    process.exit(0);
                });
            });
        })();
    });
}
