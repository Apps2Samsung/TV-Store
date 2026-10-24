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
var sdb = require('./sdb.js');
var signer = require('./signer.js');

var PORT = 8077;
var CATALOG_URL = 'https://apps2samsung.com/catalog/resolved.json';
var STAGING = '/home/owner/share/tmp/sdk_tools';   // where sdbd accepts a pushed .wgt
var LOGS = [];
var CERT_FILE = (process.env.HOME || '/tmp') + '/.a2s-tvstore-certs.json';
var CERTS = null;
function log(m) { var l = new Date().toISOString() + ' ' + m; LOGS.push(l); if (LOGS.length > 300) LOGS.shift(); try { console.log(l); } catch (e) {} }

// This TV's own LAN IPv4 — the address sdbd accepts a connection on (phase 0: not loopback).
function ownIp() {
    try { var ifs = os.networkInterfaces();
        for (var n in ifs) for (var i = 0; i < ifs[n].length; i++) { var a = ifs[n][i]; if (a.family === 'IPv4' && !a.internal) return a.address; }
    } catch (e) {}
    return null;
}

function get(u, cb) {
    var mod = u.indexOf('https') === 0 ? https : http;
    var req = mod.get(u, function (res) {
        if (res.statusCode >= 300 && res.statusCode < 400 && res.headers.location) { res.resume(); return get(res.headers.location, cb); }
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
    log('install: downloading ' + downloadUrl);
    get(downloadUrl, function (err, wgt) {
        if (err) return cb(err);
        log('install: downloaded ' + wgt.length + ' bytes; signing');
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
    });
}

// The signing certificate a head hands over once (see #844): author/distributor key+cert as PEM
// (not a .p12 — Node has no PKCS#12 parser). Kept in memory and persisted best-effort.
function loadCerts() {
    if (CERTS) return CERTS;
    try { CERTS = JSON.parse(require('fs').readFileSync(CERT_FILE, 'utf8')); } catch (e) { CERTS = null; }
    return CERTS;
}
function haveCerts() { var c = loadCerts(); return !!(c && c.authorKeyPem && c.distributorKeyPem); }

http.createServer(function (req, res) {
    if (req.method === 'OPTIONS') { cors(res, 204, 'text/plain'); return res.end(); }
    var path = url.parse(req.url).pathname;
    if (path === '/ping') return json(res, 200, { ok: true, service: 'tv-store', ownIp: ownIp(), signerReady: signer.ready, certReady: haveCerts() });
    if (path === '/logs') return json(res, 200, { logs: LOGS });
    if (path === '/catalog') return get(CATALOG_URL, function (err, buf) { if (err) return json(res, 502, { ok: false, error: err.message }); cors(res, 200, 'application/json'); res.end(buf); });
    if (path === '/cert' && req.method === 'POST') return body(req, function (err, b) {
        if (err || !b || !b.authorKeyPem || !b.authorCertPem || !b.distributorKeyPem || !b.distributorCertPem)
            return json(res, 400, { ok: false, error: 'need { authorKeyPem, authorCertPem, distributorKeyPem, distributorCertPem }' });
        CERTS = b; try { require('fs').writeFileSync(CERT_FILE, JSON.stringify(b)); } catch (e) {}
        log('cert: received signing certificate from a head'); json(res, 200, { ok: true });
    });
    if (path === '/install' && req.method === 'POST') return body(req, function (err, b) {
        if (err || !b || !b.url) return json(res, 400, { ok: false, error: 'need { url, file, appId }' });
        install(b, function (err, r) { if (err) return json(res, 200, { ok: false, error: err.message, code: err.code || null }); json(res, 200, { ok: true, result: r }); });
    });
    cors(res, 404, 'text/plain'); res.end('not found');
}).listen(PORT, '127.0.0.1', function () { log('TV-Store service on 127.0.0.1:' + PORT + ' (signer ready: ' + signer.ready + ')'); });

module.exports.onStart = function () { log('service onStart'); };
module.exports.onRequest = function () { log('service onRequest'); };
