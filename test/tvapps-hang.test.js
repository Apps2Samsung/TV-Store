/* A TV that does not answer when asked for its apps (#126), against the real service and a fake
 * sdbd that leaves the first `0 vd_applist` without an answer: GET /tvapps gives up after its wait
 * and says so (NO_LISTING), the connection is let go, and the next GET /tvapps reads the list. It
 * used to wait for good with the connection open, and every later request was told that an install
 * was running, until TV-Store was started again. */
'use strict';
var fs = require('fs'), os = require('os'), path = require('path'), http = require('http'), cp = require('child_process');
var fake = require('./fake-sdbd.js');

function fail(m) { stop(); console.error('FAIL: ' + m); process.exit(1); }
var SDB = 26198;
var dir = path.join(os.tmpdir(), 'a2s-tvapps-hang-' + process.pid + '-' + Date.now()); fs.mkdirSync(dir);
var RULE = '---------------------------------------------------------------------------------------------';
var LISTING = 'get app list...\napps count: 1\n' + RULE + '\n--------------app_title   =Netflix-------------\n--------------app_tizen_id   =org.tizen.netflix-app-------------\n--------------is_removable   =1-------------\n' + RULE + '\nspend time for wascmd is [82]ms\n';
var lists = 0, child = null, err = '', handle = null;
var WD = setTimeout(function () { fail('watchdog (30 s): the request for the list never ended' + (err ? '\n' + err : '')); }, 30000);
function stop() { clearTimeout(WD); if (child) child.kill(); if (handle) try { handle.server.close(); } catch (e) {} }

fake.start(SDB, {
    shell: function (cmd) {
        if (cmd !== '0 vd_applist') return 'ok\n';
        return ++lists === 1 ? false : LISTING;
    }
}, function (h) {
    handle = h;
    child = cp.spawn(process.execPath, [path.join(__dirname, '..', 'tizen-app', 'service', 'index.js')], { env: { HOME: dir, TMPDIR: dir, TMP: dir, TEMP: dir, PATH: process.env.PATH, A2S_SDB_PORT: String(SDB), A2S_PACKAGE_ID: 'A2STVStore', A2S_LIST_WAIT: '700' } });
    child.stderr.on('data', function (d) { err += d; });
    var tries = 0;
    (function waitUp() {
        call('/ping', function (e, code) {
            if (e || code !== 200) { if (++tries > 100 || child.exitCode !== null) fail('the service never answered /ping' + (err ? '\n' + err : '')); return setTimeout(waitUp, 100); }
            run();
        });
    })();
});

function call(p, cb) {
    var req = http.request({ host: '127.0.0.1', port: 8077, path: p, method: 'GET' }, function (res) {
        var b = ''; res.on('data', function (d) { b += d; }); res.on('end', function () { var j = null; try { j = JSON.parse(b); } catch (e) {} cb(null, res.statusCode, j); });
    });
    req.on('error', function (e) { cb(e); });
    req.end();
}

function run() {
    var started = Date.now();
    call('/tvapps', function (e, code, j) {
        var took = Date.now() - started;
        if (e || code !== 200 || !j) fail('GET /tvapps on a TV that does not answer: ' + (e ? e.message : code));
        if (j.ok !== false || j.code !== 'NO_LISTING' || !/did not answer/.test(j.error || '')) fail('a TV that does not answer must be NO_LISTING with the reason: ' + JSON.stringify(j));
        if (took < 600 || took > 10000) fail('it should give up after its wait (0.7 s here), took ' + took + ' ms');
        call('/tvapps', function (e2, code2, j2) {
            if (e2 || code2 !== 200 || !j2) fail('the second GET /tvapps: ' + (e2 ? e2.message : code2));
            if (j2.code === 'BUSY') fail('the connection of the request that was given up on is still counted as open: ' + j2.error);
            if (!j2.ok || !Array.isArray(j2.apps) || j2.apps.length !== 1 || j2.apps[0].id !== 'org.tizen.netflix-app') fail('the list after the one that hung: ' + JSON.stringify(j2));
            stop();
            console.log('PASS');
            console.log('  a TV that does not answer vd_applist: NO_LISTING after ' + took + ' ms, not a request that never ends');
            console.log('  the next request reads the list: the connection was let go');
            process.exit(0);
        });
    });
}
