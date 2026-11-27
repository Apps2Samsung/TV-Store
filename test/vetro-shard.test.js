/* The Vetro Shard that puts the start-at-boot flag of TV-Store's service back (#159): the real
 * index.js and tv.sh, run with sh, against a stand-in for the TV's sqlite3 (a script that keeps the
 * flag of each "database" in a file) and for Vetro's ctx.execute. A flag that is off is turned on
 * once and then left alone; one that is on is not written; TV-Store not on the TV; a flag that will
 * not turn on is tried three times and then only read; an agent that is not there yet is waited
 * for; stop() ends it; and the bundle in the repository is the folder as it is now. */
'use strict';
var fs = require('fs'), os = require('os'), path = require('path'), cp = require('child_process');
var SHARD = path.join(__dirname, '..', 'vetro-shard', 'tvstore-onboot');
var shard = require(path.join(SHARD, 'index.js')), pack = require('../scripts/build-shard.js');

function fail(m) { console.error('FAIL: ' + m); process.exit(1); }
var WD = setTimeout(function () { fail('watchdog (60 s)'); }, 60000);
var dir = path.join(os.tmpdir(), 'a2s-shard-' + process.pid + '-' + Date.now()), bin = path.join(dir, 'bin');
fs.mkdirSync(dir); fs.mkdirSync(bin);
// sqlite3 <options> <db> <sql>: the flag is the text of the file; an empty file lists no TV-Store.
fs.writeFileSync(path.join(bin, 'sqlite3'), [
    '#!/bin/sh',
    'for a in "$@"; do db="$sql"; sql="$a"; done',
    'case "$sql" in',
    '  *"app_id=\'A2STVStore.sdbservice\'"*) ;;',
    '  *) echo "another app: $sql" >> "' + path.join(dir, 'wrong') + '"; exit 1 ;;',
    'esac',
    'case "$sql" in',
    '  SELECT\\ app_onboot\\ FROM*) cat "$db" ;;',
    '  *"UPDATE package_app_info SET app_onboot=\'true\' WHERE"*) echo "$db" >> "' + path.join(dir, 'writes') + '"; [ -f "$db.stuck" ] && exit 1; printf true > "$db" ;;',
    '  *) echo "unknown: $sql" >> "' + path.join(dir, 'wrong') + '"; exit 1 ;;',
    'esac', ''].join('\n'));
fs.chmodSync(path.join(bin, 'sqlite3'), 493);

shard.TIMES.first = 20; shard.TIMES.retry = 20; shard.TIMES.again = 150; shard.TIMES.command = 5000;
var n = 0;
function db(text) { var f = path.join(dir, 'db' + (++n)); fs.writeFileSync(f, text); return f; }
function read(f) { try { return fs.readFileSync(f, 'utf8'); } catch (e) { return ''; } }
function writes() { return read(path.join(dir, 'writes')).split('\n').filter(Boolean); }
// One Shard on these databases. `down`: how many times the agent is not there yet.
function run(dbs, down) {
    var calls = [], modes = [];
    var ctx = { id: 'tvstore-onboot', dir: SHARD, config: {}, execute: function (cmd, ms) {
        calls.push(cmd); modes.push(/ tvstore-onboot (set|check)$/.exec(cmd)[1]);
        if (!(ms > 0)) fail('a command without a timeout');
        if (down && down-- > 0) return Promise.reject(new Error('The TV agent is not connected'));
        return new Promise(function (resolve, reject) {
            var env = { PATH: bin + ':' + process.env.PATH, A2S_DBS: dbs.join(' ') };
            cp.execFile('sh', ['-c', cmd], { env: env }, function (err, stdout) { if (err) reject(err); else resolve({ stdout: stdout, exit_code: 0 }); });
        });
    } };
    var s = shard(ctx);
    s.start();
    return { shard: s, calls: calls, modes: modes };
}
function until(what, check, cb) { var t0 = Date.now(); (function look() { if (check()) return cb(); if (Date.now() - t0 > 15000) fail(what); setTimeout(look, 10); })(); }

var steps = [], said = [];
function step(what, fn) { steps.push({ what: what, fn: fn }); }
function next() { var s = steps.shift(); if (!s) return done(); said.push(s.what); s.fn(next); }

step('a flag that is off is turned on once, and left alone at the next look', function (go) {
    var global = db(''), user = db('false'), r = run([path.join(dir, 'none'), global, user]);
    if (r.shard.status().result !== 'starting') fail('before the first look: ' + JSON.stringify(r.shard.status()));
    until('the flag is set', function () { return r.shard.status().result === 'set'; }, function () {
        if (read(user) !== 'true' || read(global) !== '') fail('only the list that has TV-Store is written: ' + read(user) + ' / ' + read(global));
        var st = r.shard.status();
        if (!st.setAt || st.error || !/next start of the TV/.test(st.text)) fail('the status says so: ' + JSON.stringify(st));
        until('the next look', function () { return r.shard.status().result === 'kept'; }, function () {
            if (writes().length !== 1 || writes()[0] !== user) fail('written once: ' + writes());
            if (r.shard.status().setAt !== st.setAt) fail('when it was set is kept');
            r.shard.stop();
            var c = r.calls.length;
            setTimeout(function () { if (r.calls.length !== c) fail('nothing after stop()'); go(); }, 400);
        });
    });
});
step('a flag that is on is not written', function (go) {
    var before = writes().length, r = run([db('true')]);
    until('kept', function () { return r.shard.status().result === 'kept'; }, function () {
        r.shard.stop();
        if (writes().length !== before) fail('nothing is written');
        go();
    });
});
step('TV-Store is not on the TV', function (go) {
    var before = writes().length, r = run([db(''), path.join(dir, 'none')]);
    until('absent', function () { return r.shard.status().result === 'absent'; }, function () {
        r.shard.stop();
        if (writes().length !== before) fail('nothing is written');
        go();
    });
});
step('a flag that will not turn on: three tries, then it only reads', function (go) {
    var f = db('false'), before = writes().length;
    fs.writeFileSync(f + '.stuck', '');
    var r = run([f]);
    until('it only reads', function () { return r.shard.status().result === 'off' && r.modes.length >= 5; }, function () {
        r.shard.stop();
        if (writes().length - before !== 3) fail('three tries: ' + (writes().length - before));
        if (r.modes.slice(0, 5).join(' ') !== 'set set set check check') fail('then check: ' + r.modes.join(' '));
        if (read(f) !== 'false') fail('the flag is as it was');
        go();
    });
});
step('the agent is not there yet: waited for', function (go) {
    var f = db('false'), r = run([f], 2);
    until('an error is kept meanwhile', function () { return !!r.shard.status().error; }, function () {
        until('set once the agent is there', function () { return r.shard.status().result === 'set'; }, function () {
            r.shard.stop();
            if (r.calls.length !== 3 || r.shard.status().error) fail('two waits and one answer: ' + r.calls.length + ' ' + r.shard.status().error);
            go();
        });
    });
});
step('the bundle in the repository is the folder as it is now, within the catalog’s limits', function (go) {
    var b = pack(), m = b.manifest, names = Object.keys(JSON.parse(b.text).files);
    if (read(b.file) !== b.text) fail(path.basename(b.file) + ' is not what the folder packs to: run node scripts/build-shard.js');
    if (fs.readdirSync(path.dirname(b.file)).filter(function (x) { return /\.vplugin$/.test(x); }).length !== 1) fail('one bundle, of this version');
    if (m.id !== 'tvstore-onboot' || m.apiVersion !== 1 || !/^\d+\.\d+\.\d+$/.test(m.version) || m.permissions.join() !== 'exec') fail('the manifest');
    if (m.name.length > 40 || m.description.length > 160) fail('name up to 40 and description up to 160 characters: ' + m.name.length + ', ' + m.description.length);
    if (names.join() !== 'README.md,index.js,tv.sh' || Buffer.byteLength(b.text) > 512 * 1024) fail('the files: ' + names);
    if (!/^#{1,6}\s+Commands\b/mi.test(read(path.join(SHARD, 'README.md')))) fail('a Shard with exec lists its commands in the README');
    if (/=>|\blet\s|\bconst\s|`/.test(read(path.join(SHARD, 'index.js')))) fail('index.js is ES5');
    go();
});

function done() {
    clearTimeout(WD);
    if (read(path.join(dir, 'wrong'))) fail('a command for something else than TV-Store’s flag:\n' + read(path.join(dir, 'wrong')));
    console.log('PASS: the Vetro Shard for the start-at-boot flag');
    said.forEach(function (s) { console.log('  ' + s); });
    process.exit(0);
}
next();
