/* Installing through the TV's own wascmd, started by the service itself (TV-Store#57).
 *
 * sdbd's `0 vd_appinstall` is a wrapper around /usr/bin/wascmd ("spend time for wascmd is [12]ms" in
 * its reply). TizenBrewInstaller runs that binary straight from its Node service, with no sdbd in
 * between, so no Developer Mode Host PC IP has to name anyone. Tizen 3 leaves child_process in the
 * service's Node; Tizen 4 and later strip the module but keep the binding child_process is built on
 * (process.binding('spawn_sync')), which is what this reaches for next. The arguments go as an
 * array, never through a shell. The binding is synchronous: the service answers nothing while
 * wascmd runs (up to TIMEOUT_MS), so the page's install call waits longer than that and its polls
 * simply fail and retry meanwhile.
 *
 * Nothing here decides whether the install worked: interpret() reads wascmd's own words, and the
 * install path in index.js falls back to sdbd when wascmd did not get to say them (not found, not
 * allowed under the service's label, "cannot working in released image", nothing printed). ES5, for
 * the TV's Node 4.4.3.
 */
'use strict';
var fs = require('fs');

var WASCMD = process.env.A2S_WASCMD || '/usr/bin/wascmd';   // a test points this at a fake
var TIMEOUT_MS = 5 * 60 * 1000;
var MAX_OUTPUT = 1024 * 1024;

// How this Node can start a process: child_process where the runtime has it, else the binding it
// is built on, else nothing. A2S_SPAWN=spawn_sync makes a test take the binding path on a Node that
// also has the module.
function spawner() {
    var forced = process.env.A2S_SPAWN || '';
    if (forced !== 'spawn_sync') {
        try { var cp = require('child_process'); if (cp && typeof cp.execFile === 'function') return { kind: 'child_process', execFile: cp.execFile }; } catch (e) {}
    }
    try { var b = process.binding('spawn_sync'); if (b && typeof b.spawn === 'function') return { kind: 'spawn_sync', spawn: b.spawn }; } catch (e2) {}
    return null;
}

function present() { try { return fs.statSync(WASCMD).isFile(); } catch (e) { return false; } }

// Whether this service may run the binary, asked of the kernel without starting anything: access(2)
// with X_OK, which the file's mode and the TV's Smack labels both answer. Two Tizen 9 sets (#67,
// #68) said EACCES to the fork that would have found that out, and the fork itself took the
// service's host process down on most starts, before the service was up. null when it may run, else
// the errno name (EACCES).
var X_OK = (fs.constants && fs.constants.X_OK) || fs.X_OK || 1;
function denied() { try { fs.accessSync(WASCMD, X_OK); return null; } catch (e) { return e.code || 'EACCES'; } }

// { path, present, executable, denied, spawn, available }: what /ping reports, and whether an
// install may try this first (available: there, runnable by this service, and a way to start it).
function status() {
    var s = spawner();
    var p = present();
    var why = p ? denied() : null;
    return { path: WASCMD, present: p, executable: p && !why, denied: why, spawn: s ? s.kind : null, available: !!(s && p && !why) };
}
function available() { return status().available; }

// The libuv errno a failed spawn returns, as its name (ENOENT, EACCES) when this Node will say.
function errnoName(n) {
    try { var uv = process.binding('uv'); if (uv && typeof uv.errname === 'function') return uv.errname(n); } catch (e) {}
    return 'errno ' + n;
}
function envPairs() {
    var out = [];
    for (var k in process.env) if (Object.prototype.hasOwnProperty.call(process.env, k)) out.push(k + '=' + process.env[k]);
    return out;
}

// Runs wascmd -i <id> -p <file>. cb(err, out, exitCode): err only when wascmd could not be started or
// did not finish (not found, not allowed, timed out); out is everything it printed, for interpret().
function run(id, file, cb) { exec(['-i', String(id), '-p', String(file)], TIMEOUT_MS, cb); }

// wascmd without arguments: its usage text, for the log. The uninstall flag is not documented
// anywhere, so the first real set's log is where it will be read from. Run once, right before the
// first install, never at start-up (#67, #68). cb(err, out).
function usage(cb) { exec([], 10 * 1000, function (err, out) { cb(err, out); }); }

function exec(args, timeoutMs, cb) {
    var s = spawner();
    if (!s) { var none = new Error('this Node can start no process'); none.code = 'NO_SPAWN'; return cb(none); }
    if (s.kind === 'child_process') {
        return s.execFile(WASCMD, args, { timeout: timeoutMs, maxBuffer: MAX_OUTPUT, env: process.env }, function (err, stdout, stderr) {
            var out = String(stdout || '') + String(stderr || '');
            if (err && err.killed) { var t = new Error('wascmd did not finish in ' + Math.round(timeoutMs / 1000) + ' s'); t.code = 'TIMEOUT'; return cb(t, out); }
            // A string code (ENOENT, EACCES) is the spawn failing; a number is wascmd's own exit code.
            if (err && !out && typeof err.code === 'string') { var e = new Error('cannot run ' + WASCMD + ': ' + err.code); e.code = err.code; return cb(e); }
            cb(null, out, err ? err.code : 0);
        });
    }
    var r;
    try {
        r = s.spawn({
            file: WASCMD, args: ['wascmd'].concat(args), envPairs: envPairs(),
            stdio: [{ type: 'pipe', readable: true, writable: false }, { type: 'pipe', readable: false, writable: true }, { type: 'pipe', readable: false, writable: true }],
            maxBuffer: MAX_OUTPUT, timeout: timeoutMs, killSignal: 15
        });
    } catch (ex) { return cb(ex); }
    if (!r) return cb(new Error('spawn_sync returned nothing'));
    if (r.error) { var name = errnoName(r.error); var se = new Error('cannot run ' + WASCMD + ': ' + name); se.code = name; return cb(se); }
    var text = '';
    if (r.output) for (var i = 1; i < r.output.length; i++) if (r.output[i]) text += r.output[i].toString();
    if (r.signal) { var to = new Error('wascmd was stopped (' + r.signal + ') after ' + Math.round(timeoutMs / 1000) + ' s'); to.code = 'TIMEOUT'; return cb(to, text); }
    cb(null, text, r.status);
}

// What wascmd said: 'refused' (the installer's own "install failed[...]", to be read as with
// vd_appinstall), 'ok' ("install completed" on a 2019 set, "appInstall return : [0]" on an older
// one), or 'unusable' (anything else: it never got to install, so sdbd is the way after all).
function interpret(out) {
    var t = String(out || '');
    if (/install failed\[/i.test(t)) return 'refused';
    if (/install completed|appInstall return\s*:\s*\[0\]/i.test(t)) return 'ok';
    return 'unusable';
}

module.exports = { status: status, available: available, run: run, usage: usage, interpret: interpret, path: WASCMD };
