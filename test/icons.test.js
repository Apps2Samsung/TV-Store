'use strict';
// App icons (#66): GET /icon/<sha256> hands out an icon only when the signed catalog names that
// hash and the bytes fetched hash to it; one download per hash however many ask, at most three at
// a time; cached on disk and hashed again before it is served; pruned when the catalog drops it.
// A local HTTP server stands in for apps2samsung.com, a stub for the verified catalog.
var fs = require('fs'), os = require('os'), path = require('path'), http = require('http'), crypto = require('crypto');
var Buf = require('../tizen-app/service/compat.js');
var icons = require('../tizen-app/service/icons.js');

function fail(m) { console.error('FAIL: ' + m); process.exit(1); }
var WD = setTimeout(function () { fail('watchdog timeout (10s)'); }, 10000);
function sha(b) { return crypto.createHash('sha256').update(b).digest('hex'); }

// A 1x1 PNG, a JPEG header with junk, a text file, and a too-big body.
var png = Buf.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNkYPhfDwAChwGA60e6kgAAAABJRU5ErkJggg==', 'base64');
var jpg = Buffer.concat([Buf.from([0xff, 0xd8, 0xff, 0xe0]), crypto.randomBytes(40)]);
var txt = Buf.from('<svg xmlns="http://www.w3.org/2000/svg"></svg>', 'utf8');
var big = crypto.randomBytes(icons.MAX_BYTES + 1);
var pngHex = sha(png), jpgHex = sha(jpg), txtHex = sha(txt), bigHex = sha(big), liarHex = sha(Buf.from('what the catalog claims', 'utf8'));
var slowHex = sha(Buf.from('slow', 'utf8'));

var dir = path.join(os.tmpdir(), 'a2s-icons-' + process.pid);
try { fs.mkdirSync(dir); } catch (e) {}
var fetches = {}, inFlight = 0, maxInFlight = 0, slowWaiting = [];
var server = http.createServer(function (req, res) {
    fetches[req.url] = (fetches[req.url] || 0) + 1;
    inFlight++; maxInFlight = Math.max(maxInFlight, inFlight);
    function send(code, body) { inFlight--; res.writeHead(code, { 'Content-Type': 'application/octet-stream' }); res.end(body); }
    if (req.url === '/png') return send(200, png);
    if (req.url === '/jpg') return send(200, jpg);
    if (req.url === '/txt') return send(200, txt);
    if (req.url === '/big') return send(200, big);
    if (req.url === '/liar') return send(200, png);          // the catalog says another hash
    if (req.url === '/gone') return send(404, 'no');
    if (/^\/slow/.test(req.url)) return slowWaiting.push(function () { send(200, Buf.from('slow', 'utf8')); });
    send(404, 'what');
});

var logs = [], catalogCalls = 0;
function log(m) { logs.push(m); }
var cat = { icons: {} };
server.listen(0, '127.0.0.1', function () {
    var base = 'http://127.0.0.1:' + server.address().port;
    cat.icons[pngHex] = base + '/png'; cat.icons[jpgHex] = base + '/jpg'; cat.icons[txtHex] = base + '/txt';
    cat.icons[bigHex] = base + '/big'; cat.icons[liarHex] = base + '/liar';
    var goneHex = sha(Buf.from('gone', 'utf8')); cat.icons[goneHex] = base + '/gone';
    for (var i = 0; i < 6; i++) cat.icons[sha(Buf.from('slow' + i, 'utf8'))] = base + '/slow' + i;

    // The service's plain get(): follow nothing, buffer the body.
    function get(u, cb) {
        http.get(u, function (res) {
            if (res.statusCode !== 200) { res.resume(); return cb(new Error('HTTP ' + res.statusCode + ' for ' + u)); }
            var c = []; res.on('data', function (d) { c.push(d); }); res.on('end', function () { cb(null, Buffer.concat(c)); });
        }).on('error', cb);
    }
    var ic = icons.create({ dir: dir, get: get, withCatalog: function (cb) { catalogCalls++; cb(null, cat); }, log: log, logv: log });

    // A fake response to drive serve() with.
    function fakeRes(cb) { var r = { head: null, body: null, writeHead: function (c, h) { r.code = c; r.head = h; }, end: function (b) { r.body = b; cb(r); } }; return r; }

    var steps = [
        function (next) { ic.lookup(pngHex, function (err, r) {
            if (err) fail('png: ' + err.message);
            if (r.type !== 'image/png' || !r.buf.equals(png) || r.cached) fail('png: wrong answer');
            if (!fs.existsSync(path.join(dir, pngHex))) fail('png: not cached');
            next(); }); },
        function (next) { ic.lookup(pngHex, function (err, r) {
            if (err || !r.cached || !r.buf.equals(png)) fail('png again: not from the cache');
            if (fetches['/png'] !== 1) fail('png again: fetched twice');
            next(); }); },
        function (next) { ic.lookup(jpgHex, function (err, r) { if (err || r.type !== 'image/jpeg') fail('jpeg: ' + (err ? err.message : r.type)); next(); }); },
        function (next) { ic.lookup(txtHex, function (err) { if (!err || err.code !== 'NOT_AN_IMAGE') fail('svg must be refused: ' + (err ? err.code : 'served')); if (fs.existsSync(path.join(dir, txtHex))) fail('svg cached'); next(); }); },
        function (next) { ic.lookup(bigHex, function (err) { if (!err || err.code !== 'TOO_BIG') fail('too big must be refused: ' + (err ? err.code : 'served')); next(); }); },
        function (next) { ic.lookup(liarHex, function (err) { if (!err || err.code !== 'HASH_MISMATCH') fail('wrong bytes must be refused: ' + (err ? err.code : 'served')); if (fs.existsSync(path.join(dir, liarHex))) fail('mismatch cached'); next(); }); },
        function (next) { ic.lookup(sha(Buf.from('unknown', 'utf8')), function (err) { if (!err || err.code !== 'NOT_IN_CATALOG') fail('unknown hash must be refused: ' + (err ? err.code : 'served')); next(); }); },
        function (next) { ic.lookup('ABC', function (err) { if (!err || err.code !== 'BAD_HASH') fail('not a hash must be refused'); next(); }); },
        function (next) { ic.lookup(goneHex, function (err) { if (!err || !/HTTP 404/.test(err.message)) fail('404 upstream must fail: ' + (err && err.message)); next(); }); },
        // Six slow icons asked for twice each: one download per hash, three at a time.
        function (next) {
            var answers = 0, want = 12;
            for (var i = 0; i < 6; i++) for (var k = 0; k < 2; k++) ic.lookup(sha(Buf.from('slow' + i, 'utf8')), function (err) {
                if (!err || err.code !== 'HASH_MISMATCH') fail('slow: expected a hash mismatch, got ' + (err ? err.code : 'ok'));
                if (++answers === want) {
                    if (maxInFlight !== icons.MAX_PARALLEL) fail('slow: ' + maxInFlight + ' downloads at once, want ' + icons.MAX_PARALLEL);
                    for (var j = 0; j < 6; j++) if (fetches['/slow' + j] !== 1) fail('slow' + j + ' fetched ' + fetches['/slow' + j] + ' times');
                    next();
                }
            });
            (function release() { if (answers === want) return; if (slowWaiting.length) slowWaiting.shift()(); setTimeout(release, 5); })();
        },
        // A cached file that no longer hashes to its name is dropped and fetched again.
        function (next) {
            fs.writeFileSync(path.join(dir, pngHex), jpg);
            ic.lookup(pngHex, function (err, r) {
                if (err || !r.buf.equals(png) || r.cached) fail('tampered cache: ' + (err ? err.message : 'served the tampered bytes'));
                if (fetches['/png'] !== 2) fail('tampered cache: not fetched again');
                next(); });
        },
        // serve(): headers for the page, 404 for what the catalog does not name, 502 for the rest.
        function (next) { ic.serve(pngHex, fakeRes(function (r) {
            if (r.code !== 200 || r.head['Content-Type'] !== 'image/png' || r.head['Content-Length'] !== png.length || !/immutable/.test(r.head['Cache-Control']) || !r.body.equals(png)) fail('serve png: ' + r.code + ' ' + JSON.stringify(r.head));
            next(); })); },
        function (next) { ic.serve(sha(Buf.from('unknown', 'utf8')), fakeRes(function (r) { if (r.code !== 404) fail('serve unknown: ' + r.code); next(); })); },
        function (next) { ic.serve(liarHex, fakeRes(function (r) { if (r.code !== 502) fail('serve mismatch: ' + r.code); next(); })); },
        // prune(): keeps what the catalog names, drops the rest and half-written files.
        function (next) {
            fs.writeFileSync(path.join(dir, 'f'.repeat(64)), png);
            fs.writeFileSync(path.join(dir, pngHex + '.part'), png);
            var keep = {}; keep[pngHex] = 'x';
            ic.prune(keep);
            setTimeout(function () {
                var left = fs.readdirSync(dir).sort();
                if (JSON.stringify(left) !== JSON.stringify([pngHex])) fail('prune left ' + JSON.stringify(left));
                next();
            }, 100);
        },
        // No cache folder: still served, nothing written.
        function (next) {
            var nc = icons.create({ dir: null, get: get, withCatalog: function (cb) { cb(null, cat); }, log: log, logv: log });
            nc.lookup(jpgHex, function (err, r) { if (err || r.type !== 'image/jpeg' || r.cached) fail('no cache dir: ' + (err ? err.message : 'wrong')); next(); });
        }
    ];
    (function run(i) {
        if (i === steps.length) {
            clearTimeout(WD); server.close();
            try { fs.readdirSync(dir).forEach(function (n) { fs.unlinkSync(path.join(dir, n)); }); fs.rmdirSync(dir); } catch (e) {}
            console.log('PASS: icons served only with the catalog\'s hash, cached and hashed again, one download per hash, ' + icons.MAX_PARALLEL + ' at a time, pruned');
            process.exit(0);
        }
        steps[i](function () { run(i + 1); });
    })(0);
});
