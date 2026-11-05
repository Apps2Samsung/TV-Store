/* App icons (#66). The catalog names an icon per package file, published next to resolved.json
 * with its SHA-256 (`icon` and `icon_digest` on the release asset). The page shows them from this
 * service, not from the web: GET /icon/<sha256> fetches the icon the way a package is fetched
 * (HTTPS without certificate validation, index.js), keeps it only when its bytes hash to what the
 * signed catalog says, caches it on disk under that hash and answers with the image. So the
 * webview never talks to apps2samsung.com (a 2018 set's browser may not trust that certificate
 * chain), a launch does not download a few hundred icons again, and a swapped image never
 * reaches the screen. A cached file is hashed again before it is served: cheap, and the rule stays
 * one line: an icon is shown only when its bytes hash to its name.
 */
'use strict';
var fs = require('fs'), path = require('path');
var catalogTrust = require('./catalog.js');

var MAX_BYTES = 1024 * 1024;   // a Tizen icon is a 512 px PNG, well under this
var MAX_PARALLEL = 3;          // the page asks for a screenful at once; a 2018 set has little CPU
var HEX = /^[0-9a-f]{64}$/;

function coded(code, message) { var e = new Error(message); e.code = code; return e; }

// The media type from the first bytes: the raster formats the webview shows, '' for anything else
// (an SVG can carry scripts and a text file is not an icon, whatever the catalog says).
function sniff(buf) {
    if (buf.length >= 8 && buf[0] === 0x89 && buf[1] === 0x50 && buf[2] === 0x4e && buf[3] === 0x47) return 'image/png';
    if (buf.length >= 3 && buf[0] === 0xff && buf[1] === 0xd8 && buf[2] === 0xff) return 'image/jpeg';
    if (buf.length >= 6 && buf.toString('ascii', 0, 4) === 'GIF8') return 'image/gif';
    if (buf.length >= 12 && buf.toString('ascii', 0, 4) === 'RIFF' && buf.toString('ascii', 8, 12) === 'WEBP') return 'image/webp';
    return '';
}

// o: { dir, get(url, cb(err, buf)), withCatalog(cb(err, cat)), log, logv }. dir null: no cache.
function create(o) {
    var dir = o.dir || null, waiting = {}, queue = [], running = 0;
    if (dir) { try { if (!fs.existsSync(dir)) fs.mkdirSync(dir); } catch (e) { o.log('icons: no cache, cannot create ' + dir + ': ' + e.message); dir = null; } }
    function file(hex) { return dir ? path.join(dir, hex) : null; }

    // cb({ buf, type }) when the cache holds a good copy, else cb(null).
    function cached(hex, cb) {
        var f = file(hex);
        if (!f) return cb(null);
        fs.readFile(f, function (err, buf) {
            if (err || !buf) return cb(null);
            var type = sniff(buf);
            if (type && catalogTrust.sha256(buf) === hex) return cb({ buf: buf, type: type, cached: true });
            o.log('icons: dropping a cached file that does not hash to its name (' + hex.slice(0, 12) + ')');
            fs.unlink(f, function () { cb(null); });
        });
    }

    // One download per hash however many requests wait for it, MAX_PARALLEL at a time.
    function fetch(hex, cb) {
        if (waiting[hex]) return waiting[hex].push(cb);
        waiting[hex] = [cb];
        queue.push(hex);
        pump();
    }
    function pump() {
        while (running < MAX_PARALLEL && queue.length) { running++; download(queue.shift(), function () { running--; pump(); }); }
    }
    function download(hex, next) {
        function done(err, r) { var w = waiting[hex]; delete waiting[hex]; next(); w.forEach(function (f) { f(err, r); }); }
        o.withCatalog(function (err, cat) {
            if (err) return done(err);
            var u = cat.icons && cat.icons[hex];
            if (!u) return done(coded('NOT_IN_CATALOG', 'no icon with that hash in the signed catalog'));
            o.get(u, function (err, buf) {
                if (err) return done(err);
                if (buf.length > MAX_BYTES) return done(coded('TOO_BIG', 'the icon is ' + buf.length + ' bytes, more than ' + MAX_BYTES + '; not showing it'));
                if (catalogTrust.sha256(buf) !== hex) return done(coded('HASH_MISMATCH', 'the icon does not match the catalog (SHA-256 differs); not showing it'));
                var type = sniff(buf);
                if (!type) return done(coded('NOT_AN_IMAGE', 'the icon is not a PNG, JPEG, GIF or WebP; not showing it'));
                var f = file(hex);
                if (f) {
                    try { fs.writeFileSync(f + '.part', buf); fs.renameSync(f + '.part', f); }
                    catch (e) { o.log('icons: cannot cache ' + hex.slice(0, 12) + ': ' + e.message); }
                }
                o.logv('icons: fetched ' + hex.slice(0, 12) + ', ' + buf.length + ' bytes, ' + type);
                done(null, { buf: buf, type: type, cached: false });
            });
        });
    }

    // cb(err, { buf, type, cached }).
    function lookup(hex, cb) {
        if (!HEX.test(hex)) return cb(coded('BAD_HASH', 'not a SHA-256'));
        cached(hex, function (hit) { if (hit) return cb(null, hit); fetch(hex, cb); });
    }

    // Drops cached icons the catalog no longer names (a new release brings a new icon), and
    // leftovers of a write that never finished.
    function prune(icons) {
        if (!dir) return;
        fs.readdir(dir, function (err, names) {
            if (err) return;
            var n = 0;
            names.forEach(function (nm) {
                var stale = /\.part$/.test(nm) || (HEX.test(nm) && !(icons && icons.hasOwnProperty(nm)));
                if (!stale) return;
                try { fs.unlinkSync(path.join(dir, nm)); n++; } catch (e) {}
            });
            if (n) o.logv('icons: dropped ' + n + ' cached icon(s) the catalog no longer names');
        });
    }

    // The answer to GET /icon/<hex>.
    function serve(hex, res) {
        lookup(hex, function (err, r) {
            if (err) {
                var code = err.code === 'NOT_IN_CATALOG' || err.code === 'BAD_HASH' ? 404 : 502;
                o.logv('icons: ' + hex.slice(0, 12) + ' ' + (err.code ? '[' + err.code + '] ' : '') + err.message);
                res.writeHead(code, { 'Content-Type': 'text/plain', 'Access-Control-Allow-Origin': '*' });
                return res.end(err.message);
            }
            // The hash is the name, so the page may keep it for good.
            res.writeHead(200, { 'Content-Type': r.type, 'Content-Length': r.buf.length, 'Cache-Control': 'max-age=31536000, immutable', 'Access-Control-Allow-Origin': '*' });
            res.end(r.buf);
        });
    }

    return { lookup: lookup, prune: prune, serve: serve, dir: dir };
}

module.exports = { create: create, sniff: sniff, MAX_BYTES: MAX_BYTES, MAX_PARALLEL: MAX_PARALLEL };
