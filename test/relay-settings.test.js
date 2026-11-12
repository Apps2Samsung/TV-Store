/* The relay's Settings over POST /settings (TV-Store#52), against the real service as a child with
 * sdbd pointed at a fake: a bad relay block is refused with 400 before anything is applied (not an
 * object, a port that is not a number, below 1024, TV-Store's own or sdbd's own); enabling answers
 * only once the listener is up, so the reply says listening:true with the port; the settings survive
 * in the data folder; saving the same settings or only the allow list does not restart the listener
 * (a session through the relay stays up); changing the port does; disabling tears it down. GET /relay
 * (TV-Store#58) answers the LAN with the state and the failure counters, without the allow list. */
'use strict';
var fs = require('fs'), os = require('os'), path = require('path'), http = require('http'), net = require('net'), cp = require('child_process');
var fake = require('./fake-sdbd.js');

function fail(m) { stop(); console.error('FAIL: ' + m); process.exit(1); }
var SDB = 26197, RELAY = 26198, RELAY2 = 26199;
var dir = path.join(os.tmpdir(), 'a2s-relay-' + process.pid + '-' + Date.now()); fs.mkdirSync(dir);
// Off by choice, as a relay file from before 0.3.28 says: else the relay turns itself on at start,
// since the fake sdbd takes loopback (test/relay-default.test.js has that).
fs.writeFileSync(path.join(dir, '.a2s-relay.json'), JSON.stringify({ enabled: false }));
fs.writeFileSync(path.join(dir, '.a2s-duid'), 'TESTDUID12345');   // known already: the start-up read of it stays off sdbd
var child = null, err = '', handle = null;
var WD = setTimeout(function () { fail('watchdog (30 s)' + (err ? '\n' + err : '')); }, 30000);
function stop() { clearTimeout(WD); if (child) child.kill(); if (handle && handle.server) try { handle.server.close(); } catch (e) {} }

fake.start(SDB, { shell: function () { return 'ok\n'; } }, function (h) {
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
    var req = http.request({ host: '127.0.0.1', port: 8077, path: p, method: method, headers: data ? { 'Content-Length': Buffer.byteLength(data), 'Content-Type': 'application/json' } : {} }, function (res) {
        var b = ''; res.on('data', function (d) { b += d; }); res.on('end', function () { var j = null; try { j = JSON.parse(b); } catch (e) {} cb(null, res.statusCode, j, b); });
    });
    req.on('error', function (e) { cb(e); });
    if (data) req.write(data);
    req.end();
}
function settings(relay, cb) { call('POST', '/settings', JSON.stringify({ relay: relay }), cb); }
function saved() { return JSON.parse(fs.readFileSync(path.join(dir, '.a2s-relay.json'), 'utf8')); }

function run() {
    // 1. Bad relay blocks are refused with 400 and nothing is applied.
    var bad = [true, 'on', [], { enabled: 'yes' }, { port: 'x' }, { port: 80 }, { port: 8077 }, { port: SDB }, { port: 70000 }, { allow: 5 }];
    (function next(i) {
        if (i >= bad.length) return enable();
        settings(bad[i], function (e, code, j) {
            if (e || code !== 400 || !j || j.ok) fail('relay ' + JSON.stringify(bad[i]) + ' must be refused with 400: ' + code + ' ' + JSON.stringify(j));
            next(i + 1);
        });
    })(0);
}

function enable() {
    call('GET', '/ping', null, function (e, code, j) {
        if (e || !j || !j.relay || j.relay.enabled || j.relay.listening) fail('the relay must be off after refused settings: ' + JSON.stringify(j && j.relay));
        // 2. Enabling answers once the listener is up: listening:true with the port, and it is saved.
        settings({ enabled: true, port: String(RELAY) }, function (e, code, j) {
            if (e || code !== 200 || !j || !j.ok) fail('enable: ' + code + ' ' + JSON.stringify(j));
            if (!j.relay.enabled || !j.relay.listening || j.relay.port !== RELAY || j.relay.error) fail('enable must answer with the listener up: ' + JSON.stringify(j.relay));
            var s = saved();
            if (!s.enabled || s.port !== RELAY) fail('settings not saved: ' + JSON.stringify(s));
            // 2b. GET /relay (open to the LAN, #58) says the same without the allow list.
            call('GET', '/relay', null, function (e, code, j) {
                if (e || code !== 200 || !j || !j.ok || !j.relay) fail('GET /relay: ' + code + ' ' + JSON.stringify(j));
                var r = j.relay;
                if (!r.enabled || !r.listening || r.port !== RELAY || r.served !== 0 || r.failures !== 0 || r.lastFailure !== null) fail('/relay must carry the state and the counters: ' + JSON.stringify(r));
                if ('allow' in r) fail('/relay must not expose the allow list: ' + JSON.stringify(r));
                holdSession();
            });
        });
    });
}

var held = null, heldClosed = false;
function holdSession() {
    // A client through the relay reaches the fake sdbd (CNXN handshake answered) and stays open.
    held = net.connect(RELAY, '127.0.0.1', function () {
        held.on('close', function () { heldClosed = true; });
        held.on('error', function () {});
        setTimeout(sameSettings, 100);
    });
}
function sameSettings() {
    // 3. Saving the same settings, or only an allow list, keeps the listener and the live session.
    settings({ enabled: true, port: RELAY }, function (e, code, j) {
        if (e || code !== 200 || !j.relay.listening) fail('re-save: ' + code + ' ' + JSON.stringify(j));
        settings({ allow: '127.0.0.1, 10.0.0.9' }, function (e, code, j) {
            if (e || code !== 200 || !j.relay.listening || j.relay.allow.length !== 2) fail('allow only: ' + code + ' ' + JSON.stringify(j));
            setTimeout(function () {
                if (heldClosed) fail('saving unchanged settings or the allow list must not drop a live session');
                if (j.relay.sessions !== 1) fail('the live session must still be counted: ' + JSON.stringify(j.relay));
                seenClients();
            }, 100);
        });
    });
}
function seenClients() {
    // 3b. The client that came through the relay is listed for Settings (the TV only, never on /relay),
    //     and one the allow list keeps out is listed as refused, so it can be switched on there.
    call('GET', '/ping', null, function (e, code, j) {
        var seen = j && j.relay && j.relay.seen;
        if (e || !seen || seen.length !== 1 || seen[0].ip !== '127.0.0.1' || seen[0].via !== 'relay' || seen[0].refused || !seen[0].at) fail('/ping must list who came through the relay: ' + JSON.stringify(seen));
        settings({ allow: ['10.0.0.9'] }, function (e, code, j) {
            if (e || code !== 200) fail('allow list: ' + code);
            var c = net.connect(RELAY, '127.0.0.1');
            c.on('error', function () {});
            c.on('close', function () {
                call('GET', '/ping', null, function (e, code, j) {
                    var seen = j && j.relay && j.relay.seen;
                    if (e || !seen || seen.length !== 1 || seen[0].ip !== '127.0.0.1' || seen[0].refused !== true) fail('a client the allow list kept out must be listed as refused: ' + JSON.stringify(seen));
                    call('GET', '/relay', null, function (e, code, j) {
                        if (e || !j || !j.relay || 'seen' in j.relay) fail('/relay must not list the clients: ' + JSON.stringify(j && j.relay));
                        settings({ allow: [] }, function (e, code, j) {
                            if (e || code !== 200 || j.relay.allow.length !== 0) fail('an empty allow list lets every device in again: ' + JSON.stringify(j && j.relay));
                            if (heldClosed) fail('changing the allow list must not drop a live session');
                            changePort();
                        });
                    });
                });
            });
        });
    });
}
function changePort() {
    // 4. Changing the port restarts the listener: the session is dropped, the new port answers.
    settings({ port: RELAY2 }, function (e, code, j) {
        if (e || code !== 200 || !j.relay.listening || j.relay.port !== RELAY2) fail('port change: ' + code + ' ' + JSON.stringify(j));
        setTimeout(function () {
            if (!heldClosed) fail('a port change must drop the sessions on the old port');
            var c = net.connect(RELAY2, '127.0.0.1', function () { c.destroy(); disable(); });
            c.on('error', function (e) { fail('the new port does not answer: ' + e.message); });
        }, 100);
    });
}
function disable() {
    // 5. Disabling tears the listener down and says so at once.
    settings({ enabled: false }, function (e, code, j) {
        if (e || code !== 200 || j.relay.enabled || j.relay.listening) fail('disable: ' + code + ' ' + JSON.stringify(j));
        var c = net.connect(RELAY2, '127.0.0.1', function () { c.destroy(); fail('the port still answers after disable'); });
        c.on('error', function () {
            if (saved().enabled) fail('disable not saved');
            stop();
            console.log('PASS');
            console.log('  bad relay settings refused with 400 before anything is applied');
            console.log('  enable answers with the listener up and the port; GET /relay says the same to the LAN, without the allow list');
            console.log('  unchanged settings and an allow-list change keep the live session');
            console.log('  /ping lists who came through the relay, refused ones too; /relay does not');
            console.log('  a port change restarts the listener; disable tears it down');
            process.exit(0);
        });
    });
}
