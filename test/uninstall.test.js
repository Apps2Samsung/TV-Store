/* Removing an app from the TV (#142), against the real service and a fake sdbd that keeps a list
 * of apps: GET /tvapps gives the TV's own list; POST /uninstall needs the page token, removes an app
 * by its id or its package and says so only when the list read again no longer has it; an app that
 * is not there is "gone already"; an app the TV keeps (is_removable 0) is tried and the TV's refusal
 * comes back as TV_OWN_APP; a refusal of an app that can be removed as UNINSTALL_FAILED with the
 * TV's words; TV-Store itself and an id that is not one are refused before anything is sent. */
'use strict';
var fs = require('fs'), os = require('os'), path = require('path'), http = require('http'), cp = require('child_process');
var fake = require('./fake-sdbd.js');

function fail(m) { stop(); console.error('FAIL: ' + m); process.exit(1); }
var SDB = 26197;
var dir = path.join(os.tmpdir(), 'a2s-uninstall-' + process.pid + '-' + Date.now()); fs.mkdirSync(dir);

var RULE = '---------------------------------------------------------------------------------------------';
function block(o) {
    return [RULE].concat(Object.keys(o).map(function (k) { var key = k; while (key.length < 38) key += ' '; return '--------------' + key + '=' + o[k] + '-------------'; })).concat([RULE]).join('\n');
}
function app(id, title, removable) { return { app_id: '', app_title: title, app_version: '1.0.0', install_date: '2026-11-01 10:00:00', app_tizen_id: id, app_size: '1048576', is_removable: removable ? '1' : '0' }; }
var onTv = [app('A2STVStore.Store', 'TV-Store', true), app('org.tizen.netflix-app', 'Netflix', true), app('9Ur5IzDKqV.TizenYouTube', 'YouTube', false), app('I2UuTnjfeL.AquaPlay', 'AquaPlay', true), app('StuckPkg01.Stuck', 'Stuck', true)];
var shells = [];
var child = null, err = '', handle = null;
var WD = setTimeout(function () { fail('watchdog (40 s)' + (err ? '\n' + err : '')); }, 40000);
function stop() { clearTimeout(WD); if (child) child.kill(); if (handle) try { handle.server.close(); } catch (e) {} }

fake.start(SDB, {
    shell: function (cmd) {
        shells.push(cmd);
        if (cmd === '0 vd_applist') return 'get app list...\napps count: ' + onTv.length + '\n' + onTv.map(block).join('\n') + '\nspend time for wascmd is [82]ms\n';
        var m = /^0 vd_appuninstall (\S+)$/.exec(cmd);
        if (!m) return 'ok\n';
        var at = -1; onTv.forEach(function (a, i) { if (a.app_tizen_id === m[1]) at = i; });
        if (at < 0) return 'app_id[' + m[1] + '] uninstall failed[132]\n';
        if (onTv[at].is_removable !== '1') return 'app_id[' + m[1] + '] uninstall failed[118, -9], reason: not removable\n';
        if (m[1] === 'StuckPkg01.Stuck') return 'app_id[' + m[1] + '] uninstall failed[118, -2], reason: app is running\n';
        onTv.splice(at, 1);
        return ' uninstall ' + m[1] + ' app_id[' + m[1] + '] uninstall completed\nspend time for wascmd is [900]ms\n';
    }
}, function (h) {
    handle = h;
    child = cp.spawn(process.execPath, [path.join(__dirname, '..', 'tizen-app', 'service', 'index.js')], { env: { HOME: dir, TMPDIR: dir, TMP: dir, TEMP: dir, PATH: process.env.PATH, A2S_SDB_PORT: String(SDB), A2S_PACKAGE_ID: 'A2STVStore' }, stdio: ['ignore', 'ignore', 'pipe'] });
    child.stderr.on('data', function (d) { err += d; });
    var tries = 0;
    (function waitUp() {
        call('GET', '/ping', null, function (e, code) {
            if (e || code !== 200) { if (++tries > 100 || child.exitCode !== null) fail('the service never answered /ping' + (err ? '\n' + err : '')); return setTimeout(waitUp, 100); }
            run();
        });
    })();
});

function call(method, p, obj, cb) {
    var data = obj ? JSON.stringify(obj) : null;
    var req = http.request({ host: '127.0.0.1', port: 8077, path: p, method: method, headers: data ? { 'Content-Length': Buffer.byteLength(data), 'Content-Type': 'application/json' } : {} }, function (res) {
        var b = ''; res.on('data', function (d) { b += d; }); res.on('end', function () { var j = null; try { j = JSON.parse(b); } catch (e) {} cb(null, res.statusCode, j, b); });
    });
    req.on('error', function (e) { cb(e); });
    if (data) req.write(data);
    req.end();
}
function token() { return fs.readFileSync(path.join(dir, '.a2s-upload-token'), 'utf8').trim(); }
function removals() { return shells.filter(function (c) { return c.indexOf('vd_appuninstall') >= 0; }); }
function ids() { return onTv.map(function (a) { return a.app_tizen_id; }); }
function remove(id, cb) { call('POST', '/uninstall', { token: token(), id: id }, function (e, code, j) { if (e || code !== 200 || !j) fail('POST /uninstall ' + id + ': ' + (e ? e.message : code)); cb(j); }); }

function run() {
    call('GET', '/tvapps', null, function (e, code, j) {
        if (code !== 200 || !j || !j.ok || j.apps.length !== 5) fail('GET /tvapps: ' + code + ' ' + JSON.stringify(j));
        var yt = j.apps.filter(function (a) { return a.title === 'YouTube'; })[0];
        if (!yt || yt.removable !== false || yt.id !== '9Ur5IzDKqV.TizenYouTube' || yt.size !== 1048576) fail('the list must carry the id, the size and what the TV keeps: ' + JSON.stringify(yt));
        call('POST', '/uninstall', { id: 'I2UuTnjfeL.AquaPlay' }, function (e, code, j) {
            if (code !== 403 || !j || j.code !== 'NO_TOKEN') fail('a removal without the page token must be refused: ' + code + ' ' + JSON.stringify(j));
            call('POST', '/uninstall', { token: token() }, function (e, code) {
                if (code !== 400) fail('a removal without an id must be refused: ' + code);
                if (removals().length) fail('nothing may be sent to the TV for a refused request: ' + removals());
                byPackage();
            });
        });
    });
}
function byPackage() {
    remove('I2UuTnjfeL', function (j) {
        if (!j.ok || !j.result.gone || j.result.id !== 'I2UuTnjfeL.AquaPlay' || j.result.title !== 'AquaPlay') fail('removing by package id: ' + JSON.stringify(j));
        if (removals().join() !== '0 vd_appuninstall I2UuTnjfeL.AquaPlay') fail('the TV must be asked with the id from its own list: ' + removals());
        if (ids().indexOf('I2UuTnjfeL.AquaPlay') >= 0) fail('AquaPlay is still on the fake TV');
        remove('I2UuTnjfeL.AquaPlay', function (j) {
            if (!j.ok || !j.result.already) fail('an app that is not there is gone already: ' + JSON.stringify(j));
            if (removals().length !== 1) fail('nothing is sent for an app the TV does not list');
            preinstalled();
        });
    });
}
function preinstalled() {
    remove('org.tizen.netflix-app', function (j) {
        if (!j.ok || !j.result.gone || ids().indexOf('org.tizen.netflix-app') >= 0) fail('an app that came with the TV and may go: ' + JSON.stringify(j));
        remove('9Ur5IzDKqV.TizenYouTube', function (j) {
            if (j.ok || j.code !== 'TV_OWN_APP' || !/one of its own/.test(j.error) || !/not removable/.test(j.error)) fail('an app the TV keeps must come back as TV_OWN_APP with the TV\'s words: ' + JSON.stringify(j));
            if (ids().indexOf('9Ur5IzDKqV.TizenYouTube') < 0) fail('YouTube must still be on the fake TV');
            remove('StuckPkg01.Stuck', function (j) {
                if (j.ok || j.code !== 'UNINSTALL_FAILED' || !/app is running/.test(j.error)) fail('a refusal must come back as UNINSTALL_FAILED with the TV\'s words: ' + JSON.stringify(j));
                refused();
            });
        });
    });
}
function refused() {
    var before = shells.length;
    remove('A2STVStore.Store', function (j) {
        if (j.ok || j.code !== 'SELF') fail('TV-Store must not remove itself: ' + JSON.stringify(j));
        remove('A2STVStore', function (j) {
            if (j.ok || j.code !== 'SELF') fail('TV-Store must not remove itself by its package id: ' + JSON.stringify(j));
            remove('x; rm -rf /', function (j) {
                if (j.ok || j.code !== 'BAD_ID') fail('an id that is not one must be refused: ' + JSON.stringify(j));
                if (shells.length !== before) fail('nothing may reach the TV for these: ' + shells.slice(before));
                if (ids().indexOf('A2STVStore.Store') < 0) fail('TV-Store must still be on the fake TV');
                var log = fs.readFileSync(path.join(dir, 'tvstore.log'), 'utf8');
                if (!/uninstall: removing Netflix \(org\.tizen\.netflix-app\)/.test(log) || !/is_removable 0/.test(log) || !/uninstall: YouTube is still on this TV/.test(log)) fail('the log must say what was removed and what the TV kept:\n' + log);
                stop();
                console.log('PASS');
                console.log('  GET /tvapps: the TV\'s own list, with what it lets go');
                console.log('  POST /uninstall: needs the page token and an id; by id or by package, with the id from the list');
                console.log('  gone only when the list read again no longer has it; not there: gone already');
                console.log('  an app that came with the TV: removed when the TV lets it go, TV_OWN_APP when it keeps it; a refusal with the TV\'s words');
                console.log('  TV-Store itself and a bad id: refused, nothing sent');
                process.exit(0);
            });
        });
    });
}
