/* The relay on by default where Host PC IP is 127.0.0.1 (0.3.28), against the real service as a child
 * with sdbd pointed at a fake: with no relay settings saved and a fake sdbd that takes loopback, the
 * relay turns itself on at start (relay.auto says why, chosen is false) and nothing is saved as on; the
 * switch turned off is a choice that a restart keeps, with no probe turning it back on; with a fake
 * sdbd that takes only another address (Host PC IP is a phone or PC), the relay stays off; a relay
 * file from before 0.3.28 counts as a choice. */
'use strict';
var fs = require('fs'), os = require('os'), path = require('path'), http = require('http'), cp = require('child_process');
var fake = require('./fake-sdbd.js');

var SDB = 26187, RELAY = 26188;
var child = null, err = '', handle = null;
var WD = setTimeout(function () { fail('watchdog (40 s)' + (err ? '\n' + err : '')); }, 40000);
function fail(m) { stop(); console.error('FAIL: ' + m); process.exit(1); }
function stop() { clearTimeout(WD); if (child) child.kill(); if (handle && handle.server) try { handle.server.close(); } catch (e) {} }
function newDir(tag) { var d = path.join(os.tmpdir(), 'a2s-relaydef-' + tag + '-' + process.pid + '-' + Date.now()); fs.mkdirSync(d); return d; }

function call(method, p, data, cb) {
    var req = http.request({ host: '127.0.0.1', port: 8077, path: p, method: method, headers: data ? { 'Content-Length': Buffer.byteLength(data), 'Content-Type': 'application/json' } : {} }, function (res) {
        var b = ''; res.on('data', function (d) { b += d; }); res.on('end', function () { var j = null; try { j = JSON.parse(b); } catch (e) {} cb(null, res.statusCode, j); });
    });
    req.on('error', function (e) { cb(e); });
    if (data) req.write(data);
    req.end();
}
// Start the service on dir, wait for /ping, then for the start-up probe (1 s) to have had its go.
function startService(dir, cb) {
    err = '';
    child = cp.spawn(process.execPath, [path.join(__dirname, '..', 'tizen-app', 'service', 'index.js')], { env: { HOME: dir, TMPDIR: dir, TMP: dir, TEMP: dir, PATH: process.env.PATH, A2S_SDB_PORT: String(SDB), A2S_RELAY_PORT: String(RELAY) }, stdio: ['ignore', 'ignore', 'pipe'] });
    child.stderr.on('data', function (d) { err += d; });
    var tries = 0;
    (function waitUp() {
        call('GET', '/ping', null, function (e, code) {
            if (e || code !== 200) { if (++tries > 100 || child.exitCode !== null) fail('the service never answered /ping' + (err ? '\n' + err : '')); return setTimeout(waitUp, 100); }
            setTimeout(function () { call('GET', '/ping', null, function (e, code, j) { if (e || !j || !j.relay) fail('/ping: ' + code); cb(j.relay); }); }, 2500);
        });
    })();
}
function stopService(cb) { var c = child; child = null; c.once('exit', function () { setTimeout(cb, 200); }); c.kill(); }
function readCfg(dir) { try { return JSON.parse(fs.readFileSync(path.join(dir, '.a2s-relay.json'), 'utf8')); } catch (e) { return null; } }

// 1. Host PC IP 127.0.0.1 (the fake takes loopback): on by itself.
// The same connection reads the TV's DUID from sdbd (`0 getduid`), the id a certificate's device list
// carries: /ping gives it and it is kept for the next start.
fake.start(SDB, { shell: function (cmd) { return /getduid/.test(cmd) ? 'TESTDUID12345\n' : 'ok\n'; } }, function (h) {
    handle = h;
    var dir = newDir('auto');
    startService(dir, function (r) {
        if (!r.enabled || !r.listening || r.port !== RELAY || r.chosen !== false || !/127\.0\.0\.1/.test(r.auto || '')) fail('the relay must turn itself on when sdbd takes loopback: ' + JSON.stringify(r));
        var c = readCfg(dir);
        if (c && c.enabled) fail('turned on by itself must not be saved as on: ' + JSON.stringify(c));
        call('GET', '/relay', null, function (e, code, j) {
            if (e || !j || !j.relay || !j.relay.enabled || !j.relay.auto) fail('GET /relay must say it is on by default: ' + JSON.stringify(j));
            var kept = ''; try { kept = fs.readFileSync(path.join(dir, '.a2s-duid'), 'utf8'); } catch (x) {}
            if (kept !== 'TESTDUID12345') fail('the DUID must be kept on the TV: ' + JSON.stringify(kept));
            // 2. The switch turned off is a choice: saved, and a restart does not turn it back on.
            call('GET', '/ping', null, function (e, code, p) {
            if (e || !p || p.duid !== 'TESTDUID12345') fail('/ping must carry the DUID sdbd gave: ' + JSON.stringify(p && p.duid));
            call('POST', '/settings', JSON.stringify({ relay: { enabled: false } }), function (e, code, j) {
                if (e || code !== 200 || j.relay.enabled || j.relay.listening || j.relay.chosen !== true || j.relay.auto) fail('turning it off: ' + code + ' ' + JSON.stringify(j));
                var c = readCfg(dir);
                if (!c || c.enabled || c.chosen !== true) fail('the choice must be saved: ' + JSON.stringify(c));
                stopService(function () {
                    startService(dir, function (r) {
                        if (r.enabled || r.listening || r.chosen !== true) fail('a restart must keep the relay off once it was turned off: ' + JSON.stringify(r));
                        stopService(function () { legacy(); });
                    });
                });
            });
            });
        });
    });
});
// 3. A relay file from before 0.3.28 ({ enabled: false } without chosen) is a choice too.
function legacy() {
    var dir = newDir('legacy');
    fs.writeFileSync(path.join(dir, '.a2s-relay.json'), JSON.stringify({ enabled: false, port: RELAY, allow: [] }));
    startService(dir, function (r) {
        if (r.enabled || r.listening || r.chosen !== true) fail('an older relay file must count as a choice: ' + JSON.stringify(r));
        stopService(function () { handle.server.close(); otherHostPcIp(); });
    });
}
// 4. Host PC IP is a phone or PC (the fake drops loopback): the relay stays off, and says it can turn on.
function otherHostPcIp() {
    fake.start(SDB, { hostPcIp: '10.99.99.99', shell: function () { return 'ok\n'; } }, function (h) {
        handle = h;
        var dir = newDir('other');
        startService(dir, function (r) {
            if (r.enabled || r.listening || r.chosen !== false || r.auto) fail('the relay must stay off when sdbd turns loopback away: ' + JSON.stringify(r));
            if (readCfg(dir)) fail('nothing must be saved without a choice');
            stop();
            console.log('PASS');
            console.log('  Host PC IP 127.0.0.1: the relay turns itself on at start, not saved as on, GET /relay says so');
            console.log('  turned off in Settings: saved as a choice, a restart keeps it off');
            console.log('  a relay file from before 0.3.28 counts as a choice');
            console.log('  Host PC IP elsewhere: the relay stays off');
            process.exit(0);
        });
    });
}
