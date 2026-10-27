/* TV-Store background service (#844): the control plane the on-screen UI drives over loopback HTTP,
 * and the install pipeline (download -> sign -> push -> vd_appinstall) over the sdb client.
 *
 * Opening a raw socket to sdbd and running a real HTTP server on loopback are both proven on retail
 * (the tessel SMB proxy, and the #844 phase-0 probe). The sdb transport here is proven end to end
 * against a fake sdbd (test/run.js). The one not-yet-ready step is signer.sign (see signer.js).
 */
'use strict';
var http = require('http');
var https = require('https');
var os = require('os');
var url = require('url');
var fs = require('fs');
var path = require('path');
var sdb = require('./sdb.js');
var signer = require('./signer.js');
var catalogTrust = require('./catalog.js');
var CATALOG_KEY = require('./catalog-key.js');

var PORT = 8077;
// Signed by the Apps2Samsung catalog workflow; see catalog.js for why the content is checked
// instead of the connection.
var CATALOG_URL = 'https://apps2samsung.com/catalog/resolved.json.signed';
var STAGING = '/home/owner/share/tmp/sdk_tools';   // where sdbd accepts a pushed .wgt
var LOGS = [];
var CERT_NAME = '.a2s-tvstore-certs.json';
// Where the handed-over certificate is kept, best first: the package's private data folder
// (what the page's tizen.filesystem calls wgt-private), which survives a reboot and an upgrade.
// The service runs from /opt/usr/apps/<pkg>/res/wgt/service, read-only, and $HOME (/home/owner)
// is not writable for it (both seen on a 2019 Tizen 5.0 set, #881); the data folder lives under
// apps_rw instead. /tmp is the last resort: it survives an app restart, not a reboot, and is
// where 0.3.3 ended up, so a certificate found there is moved up.
var PKG = path.basename(path.resolve(__dirname, '../../..'));
var CERT_DIRS = ['/opt/usr/home/owner/apps_rw/' + PKG + '/data', '/home/owner/apps_rw/' + PKG + '/data', process.env.HOME, '/tmp']
    .filter(function (d) { return !!d; });
var CERT_FILE = null, CERT_ERROR = null;
var CERTS = null;
var CATALOG = null;        // { catalog, payload, index, at } once a signed catalog verified
function log(m) { var l = new Date().toISOString() + ' ' + m; LOGS.push(l); if (LOGS.length > 300) LOGS.shift(); try { console.log(l); } catch (e) {} }

// This TV's own LAN IPv4 — the address sdbd accepts a connection on (phase 0: not loopback).
function ownIp() {
    try { var ifs = os.networkInterfaces();
        for (var n in ifs) for (var i = 0; i < ifs[n].length; i++) { var a = ifs[n][i]; if (a.family === 'IPv4' && !a.internal) return a.address; }
    } catch (e) {}
    return null;
}

// HTTPS without certificate validation: the TV's CA store is too old for today's chains, so
// nothing fetched here is trusted for where it came from. The catalog is trusted through its
// signature and a package through the hash the catalog gives it (catalog.js).
function get(u, cb, hops) {
    hops = hops || 0;
    if (hops > 5) return cb(new Error('too many redirects for ' + u));
    var o = url.parse(u), secure = o.protocol === 'https:';
    var opts = { protocol: o.protocol, hostname: o.hostname, port: o.port || (secure ? 443 : 80), path: o.path,
                 headers: { 'User-Agent': 'Apps2Samsung-TV-Store' } };
    if (secure) opts.rejectUnauthorized = false;
    var req = (secure ? https : http).get(opts, function (res) {
        if (res.statusCode >= 300 && res.statusCode < 400 && res.headers.location) { res.resume(); return get(url.resolve(u, res.headers.location), cb, hops + 1); }
        if (res.statusCode !== 200) { res.resume(); return cb(new Error('HTTP ' + res.statusCode + ' for ' + u)); }
        var chunks = []; res.on('data', function (d) { chunks.push(d); }); res.on('end', function () { cb(null, Buffer.concat(chunks)); });
    });
    req.on('error', cb); req.setTimeout(30000, function () { req.abort(); });
}

// POST body JSON helper
function body(req, cb) { var c = []; req.on('data', function (d) { c.push(d); }); req.on('end', function () { try { cb(null, c.length ? JSON.parse(Buffer.concat(c).toString('utf8')) : {}); } catch (e) { cb(e); } }); }

function cors(res, code, type) { res.writeHead(code, { 'Content-Type': type, 'Access-Control-Allow-Origin': '*', 'Access-Control-Allow-Headers': '*' }); }
function json(res, code, obj) { cors(res, code, 'application/json'); res.end(JSON.stringify(obj)); }

// The full install pipeline for one package. progress via log; final state via cb.
function install(entry, cb) {
    var downloadUrl = entry.url, remoteName = (entry.file || 'package.wgt').replace(/[^A-Za-z0-9._-]/g, '_');
    // Only what the signed catalog lists, with the hash it gives: the loopback port is open to
    // every app on the TV, and none of them gets to choose what is signed with the user's
    // certificate.
    withCatalog(function (err, cat) {
        if (err) return cb(err);
        if (!cat.index.hasOwnProperty(downloadUrl)) return cb(coded('NOT_IN_CATALOG', 'this download is not in the signed catalog'));
        var want = cat.index[downloadUrl];
        if (!want) return cb(coded('NO_HASH', 'the catalog has no hash for this file, so the TV cannot check it; install it from Apps2Samsung on a phone or PC'));
        log('install: downloading ' + downloadUrl);
        get(downloadUrl, function (err, wgt) {
            if (err) return cb(err);
            var got = catalogTrust.sha256(wgt);
            if (got !== want) { log('install: hash mismatch, got ' + got + ' want ' + want); return cb(coded('HASH_MISMATCH', 'the download does not match the catalog (SHA-256 differs); not installing it')); }
            log('install: downloaded ' + wgt.length + ' bytes, SHA-256 matches the catalog; signing');
            signAndInstall(entry, remoteName, wgt, cb);
        });
    });
}

function coded(code, message) { var e = new Error(message); e.code = code; return e; }

function signAndInstall(entry, remoteName, wgt, cb) {
    var signed;
    try { signed = signer.sign(wgt, loadCerts()); }
    catch (e) { log('install: ' + e.message); return cb(e); }        // SIGNER_NOT_READY surfaces here
    var ip = ownIp();
    if (!ip) return cb(new Error('could not determine this TV’s own IP'));
    var c = new sdb.SdbClient(ip);
    c.connect(function (err) {
        if (err) { c.end(); return cb(err); }
        var remote = STAGING + '/' + remoteName;
        log('install: pushing to ' + remote);
        c.push(remote, signed, function (err) {
            if (err) { c.end(); return cb(err); }
            c.shell('0 vd_appinstall ' + (entry.appId || entry.packageId || '') + ' ' + remote, function (err, out) {
                c.end();
                if (err) return cb(err);
                log('install: vd_appinstall reply: ' + out.replace(/\s+/g, ' ').slice(0, 200));
                cb(null, { reply: out });
            });
        });
    });
}

// The signed catalog, fetched and verified, cached for 10 minutes (the workflow publishes every
// 30). A download URL is installable only when this lists it.
// Requests that arrive while a fetch is running wait for that one.
var CATALOG_WAITING = null;
function withCatalog(cb, fresh) {
    if (CATALOG && !fresh && Date.now() - CATALOG.at < 10 * 60 * 1000) return cb(null, CATALOG);
    if (CATALOG_WAITING) return CATALOG_WAITING.push(cb);
    CATALOG_WAITING = [cb];
    function done(err, cat) { var w = CATALOG_WAITING; CATALOG_WAITING = null; w.forEach(function (f) { f(err, cat); }); }
    get(CATALOG_URL, function (err, buf) {
        if (err) return done(err);
        var cat;
        try { cat = catalogTrust.verify(buf, CATALOG_KEY); }
        catch (e) { log('catalog: ' + e.message); return done(e); }
        cat.at = Date.now(); CATALOG = cat;
        log('catalog: signature ok, generated ' + cat.catalog.generatedAt + ', ' + Object.keys(cat.index).length + ' files');
        done(null, cat);
    });
}

// The signing certificate a head hands over once (see #844): author/distributor key+cert as PEM
// (not a .p12 — Node has no PKCS#12 parser). Kept in memory and persisted best-effort.
function loadCerts() {
    if (CERTS) return CERTS;
    for (var i = 0; i < CERT_DIRS.length; i++) {
        var f = path.join(CERT_DIRS[i], CERT_NAME);
        try { CERTS = JSON.parse(fs.readFileSync(f, 'utf8')); CERT_FILE = f; } catch (e) { continue; }
        // Found in a worse place (0.3.3 kept it in $HOME or /tmp): move it up where it persists.
        if (i > 0) saveCerts(CERTS);
        return CERTS;
    }
    return null;
}
function saveCerts(b) {
    CERTS = b; CERT_ERROR = null;
    for (var i = 0; i < CERT_DIRS.length; i++) {
        var f = path.join(CERT_DIRS[i], CERT_NAME);
        try { fs.writeFileSync(f, JSON.stringify(b)); CERT_FILE = f; log('cert: stored in ' + f); return; }
        catch (e) { CERT_ERROR = f + ': ' + e.message; log('cert: cannot write ' + CERT_ERROR); }
    }
}
function haveCerts() { var c = loadCerts(); return !!(c && c.authorKeyPem && c.distributorKeyPem); }

http.createServer(function (req, res) {
    if (req.method === 'OPTIONS') { cors(res, 204, 'text/plain'); return res.end(); }
    var route = url.parse(req.url).pathname;
    if (route === '/ping') return json(res, 200, { ok: true, service: 'tv-store', ownIp: ownIp(), signerReady: signer.ready, certReady: haveCerts(),
        certFile: CERT_FILE, certError: CERT_ERROR, node: process.version });
    if (route === '/logs') return json(res, 200, { logs: LOGS });
    if (route === '/catalog') return withCatalog(function (err, cat) { if (err) return json(res, 502, { ok: false, error: err.message }); cors(res, 200, 'application/json'); res.end(cat.payload); });
    if (route === '/cert' && req.method === 'POST') return body(req, function (err, b) {
        if (err || !b || !b.authorKeyPem || !b.authorCertPem || !b.distributorKeyPem || !b.distributorCertPem)
            return json(res, 400, { ok: false, error: 'need { authorKeyPem, authorCertPem, distributorKeyPem, distributorCertPem }' });
        log('cert: received signing certificate from a head'); saveCerts(b);
        json(res, 200, { ok: true, certFile: CERT_FILE, certError: CERT_FILE ? null : CERT_ERROR });
    });
    if (route === '/install' && req.method === 'POST') return body(req, function (err, b) {
        if (err || !b || !b.url) return json(res, 400, { ok: false, error: 'need { url, file, appId }' });
        install(b, function (err, r) { if (err) return json(res, 200, { ok: false, error: err.message, code: err.code || null }); json(res, 200, { ok: true, result: r }); });
    });
    cors(res, 404, 'text/plain'); res.end('not found');
}).listen(PORT, '127.0.0.1', function () { log('TV-Store service on 127.0.0.1:' + PORT + ' (signer ready: ' + signer.ready + ')'); });

module.exports.onStart = function () { log('service onStart'); };
module.exports.onRequest = function () { log('service onRequest'); };
