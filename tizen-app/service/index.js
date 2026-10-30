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
var crypto = require('crypto');
var sdb = require('./sdb.js');
var signer = require('./signer.js');
var zip = require('./zip.js');
var catalogTrust = require('./catalog.js');
var CATALOG_KEY = require('./catalog-key.js');
var manifest = require('./manifest.js');
var refusals = require('./refusal.js');

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
// The package id, from where the service runs (/opt/usr/apps/<pkg>/res/wgt/service). A runtime
// that gives the script no __dirname gets the id TV-Store ships with.
var PKG = typeof __dirname === 'string' ? path.basename(path.resolve(__dirname, '../../..')) : 'A2STVStore';
var CERT_DIRS = ['/opt/usr/home/owner/apps_rw/' + PKG + '/data', '/home/owner/apps_rw/' + PKG + '/data', process.env.HOME, '/tmp']
    .filter(function (d) { return !!d; });
var CERT_FILE = null, CERT_ERROR = null;
var CERTS = null;
var CATALOG = null;        // { catalog, payload, index, at } once a signed catalog verified
// Where the service keeps files: the first of the folders it may write. The log and the packages
// being installed live here, not in /tmp, which is RAM on many sets.
var DATA_DIRS = ['/opt/usr/home/owner/apps_rw/' + PKG + '/data', '/home/owner/apps_rw/' + PKG + '/data', os.tmpdir ? os.tmpdir() : '/tmp', '/tmp'];
var DATA_DIR = null;
for (var di = 0; di < DATA_DIRS.length && !DATA_DIR; di++) {
    try { var probe = path.join(DATA_DIRS[di], '.a2s-write-test'); fs.writeFileSync(probe, ''); fs.unlinkSync(probe); DATA_DIR = DATA_DIRS[di]; } catch (e) {}
}
// The log, on disk so it survives the service going down (the Tizen 6 report: the service vanished
// mid-install and the in-memory log with it). The previous run's log is kept next to it. Anyone on
// the LAN can read both at http://<TV IP>:8077/log.txt; they hold no keys.
var LOG_FILE = DATA_DIR ? path.join(DATA_DIR, 'tvstore.log') : null, LOG_PREV = LOG_FILE ? LOG_FILE.replace(/\.log$/, '.prev.log') : null;
if (LOG_FILE) { try { fs.renameSync(LOG_FILE, LOG_PREV); } catch (e) {} }
function log(m) {
    var l = new Date().toISOString() + ' ' + m; LOGS.push(l); if (LOGS.length > 300) LOGS.shift(); try { console.log(l); } catch (e) {}
    if (!LOG_FILE) return;
    try { if (fs.statSync(LOG_FILE).size > 512 * 1024) fs.renameSync(LOG_FILE, LOG_PREV); } catch (e) {}
    try { fs.appendFileSync(LOG_FILE, l + '\n'); } catch (e) {}
}
// Verbose logging (#31): off by default so the log a user sends stays readable; the page turns it
// on from Settings when a problem needs more. Kept in a file next to the log so it survives a restart.
// Verbose lines start with "verbose" and never contain " install:", which the page reads as progress.
// Never log key material: the /cert body is not logged, only that it arrived.
var VERBOSE_FILE = DATA_DIR ? path.join(DATA_DIR, '.a2s-verbose') : null;
var VERBOSE = false;
try { VERBOSE = !!(VERBOSE_FILE && fs.existsSync(VERBOSE_FILE)); } catch (e) {}
function logv(m) { if (VERBOSE) log('verbose ' + m); }
function setVerbose(on) {
    on = !!on;
    if (on === VERBOSE) return;
    VERBOSE = on;
    try { if (on) fs.writeFileSync(VERBOSE_FILE, ''); else fs.unlinkSync(VERBOSE_FILE); } catch (e) {}
    log('verbose logging ' + (on ? 'on' : 'off'));
    if (on) logPlatform();
}
// What this TV is, for a verbose log: OS, Node, every network address, the folders in use.
function logPlatform() {
    var nets = [];
    try { var ifs = os.networkInterfaces();
        for (var n in ifs) for (var i = 0; i < ifs[n].length; i++) nets.push(n + ' ' + ifs[n][i].family + ' ' + ifs[n][i].address + (ifs[n][i].internal ? ' (internal)' : ''));
    } catch (e) { nets.push('networkInterfaces failed: ' + e.message); }
    logv('platform: ' + os.type() + ' ' + os.release() + ' ' + process.arch + ', node ' + process.version + ', pid ' + process.pid + ', uptime ' + Math.round(os.uptime()) + ' s');
    logv('platform: network ' + nets.join('; '));
    logv('platform: package ' + PKG + ', data ' + DATA_DIR + ', cert ' + (CERT_FILE || 'none yet') + ', cert folders ' + CERT_DIRS.join(', '));
}
// Uploads (#30): a .wgt or .tpk that anyone in the network sends to http://<TV IP>:8077/upload
// waits here, one at a time, until the person at the TV presses Install or Discard on the
// TV-Store screen. Only that screen can start the install: it sends the token below, which the
// service writes into the package's private data folder at start, where only TV-Store's own page
// can read it. Other apps on the TV reach this port too, and none of them gets an upload signed
// with the user's certificate that way. The page is open to the LAN like the log; the file is
// capped, checked to be a Tizen package, and shown on the TV with where it came from.
var UPLOAD = null;             // { id, name, size, sha256, from, at, ids }, the file at UPLOAD_FILE
var UPLOAD_BUSY = false;       // its install is running: no replacing or discarding meanwhile
var UPLOAD_MAX = 400 * 1024 * 1024;
var UPLOAD_FILE = DATA_DIR ? path.join(DATA_DIR, 'upload.pkg') : null;
var UPLOAD_TOKEN = crypto.randomBytes(24).toString('hex');
var TOKEN_FILE = DATA_DIR ? path.join(DATA_DIR, '.a2s-upload-token') : null;
try { if (TOKEN_FILE) fs.writeFileSync(TOKEN_FILE, UPLOAD_TOKEN); } catch (e) { log('upload: cannot write the token file: ' + e.message); }
if (UPLOAD_FILE) { try { fs.unlinkSync(UPLOAD_FILE); } catch (e) {} }     // a previous run's leftover
function unlink(f) { try { fs.unlinkSync(f); } catch (e) {} }
function publicUpload() { return UPLOAD ? { id: UPLOAD.id, name: UPLOAD.name, size: UPLOAD.size, sha256: UPLOAD.sha256, from: UPLOAD.from, at: UPLOAD.at, ids: UPLOAD.ids } : null; }

// PUT /upload?name=<file> with the package as the body, from a browser on the upload page.
function receiveUpload(req, res) {
    var name = String(url.parse(req.url, true).query.name || '').replace(/^.*[\\\/]/, '').replace(/[^A-Za-z0-9._ -]/g, '_').trim();
    var from = String(req.socket.remoteAddress || '').replace(/^::ffff:/, '');
    function refuse(code, why) { req.resume(); json(res, code, { ok: false, error: why }); }
    if (!/\.(wgt|tpk)$/i.test(name)) return refuse(400, 'send a .wgt or .tpk file');
    if (!UPLOAD_FILE) return refuse(500, 'the service has no folder it can write to');
    if (UPLOAD_BUSY) return refuse(409, 'the TV is installing the previous file; try again in a minute');
    var declared = parseInt(req.headers['content-length'] || '0', 10);
    if (declared > UPLOAD_MAX) return refuse(413, 'too big: at most ' + Math.round(UPLOAD_MAX / 1048576) + ' MB');
    var tmp = UPLOAD_FILE + '.part', out = fs.createWriteStream(tmp), h = crypto.createHash('sha256'), size = 0, done = false;
    function fin(code, obj) { if (done) return; done = true; if (!obj.ok) { try { out.destroy(); } catch (e) {} unlink(tmp); log('upload: refused ' + name + ' from ' + from + ': ' + obj.error); } json(res, code, obj); }
    log('upload: receiving ' + name + ' from ' + from + (declared ? ', ' + declared + ' bytes' : ''));
    req.on('data', function (d) {
        if (done) return;
        size += d.length; h.update(d);
        if (size > UPLOAD_MAX) { fin(413, { ok: false, error: 'too big: at most ' + Math.round(UPLOAD_MAX / 1048576) + ' MB' }); req.destroy(); }
    });
    req.on('error', function (e) { fin(400, { ok: false, error: 'the upload broke off: ' + e.message }); });
    out.on('error', function (e) { fin(500, { ok: false, error: 'could not store the file: ' + e.message }); });
    out.on('finish', function () {
        if (done) return;
        if (!size) return fin(400, { ok: false, error: 'the file is empty' });
        manifest.read(tmp, function (err, ids) {
            if (err) return fin(400, { ok: false, error: err.message });
            try { fs.renameSync(tmp, UPLOAD_FILE); } catch (e) { return fin(500, { ok: false, error: 'could not store the file: ' + e.message }); }
            UPLOAD = { id: crypto.randomBytes(8).toString('hex'), name: name, size: size, sha256: h.digest('hex'), from: from, at: new Date().toISOString(), ids: ids };
            log('upload: ' + name + ' (' + size + ' bytes, ' + ids.kind + ' ' + (ids.appId || ids.packageId) + (ids.version ? ' v' + ids.version : '') + ') from ' + from + ' waits for OK on the TV');
            fin(200, { ok: true, upload: publicUpload() });
        });
    });
    req.pipe(out);
}

// POST /install { upload, token } from the TV-Store screen: sign the waiting file and install it.
// No catalog, no hash: the person at the TV saw the file, where it came from and pressed Install.
function installUpload(b, cb) {
    if (!UPLOAD || b.upload !== UPLOAD.id) return cb(coded('NO_UPLOAD', 'that file is no longer waiting on the TV; send it again'));
    if (String(b.token || '') !== UPLOAD_TOKEN) { log('upload: refused an install of ' + UPLOAD.name + ' without the token'); return cb(coded('NO_TOKEN', 'only the TV-Store screen may install an uploaded file')); }
    if (UPLOAD_BUSY) return cb(coded('BUSY', 'that file is being installed'));
    if (!DATA_DIR) return cb(new Error('the service has no folder it can write to'));
    var up = UPLOAD, outFile = path.join(DATA_DIR, 'job-' + Date.now() + '.signed.wgt');
    UPLOAD_BUSY = true;
    log('install: uploaded ' + up.size + ' bytes, ' + up.name + ' from ' + up.from + ', SHA-256 ' + up.sha256 + ', confirmed on the TV; signing');
    var entry = { appId: up.ids.appId, packageId: up.ids.packageId, file: up.name, name: up.ids.name, requiredVersion: up.ids.requiredVersion, tizen: b.tizen, installed: !!b.installed, replace: !!b.replace };
    var gate = tizenGate(entry);
    if (gate) { UPLOAD_BUSY = false; return cb(gate); }
    signAndInstall(entry, up.name.replace(/[^A-Za-z0-9._-]/g, '_'), UPLOAD_FILE, outFile, function (err, r) {
        UPLOAD_BUSY = false;
        unlink(outFile);
        // The file is gone once signed (signAndInstall drops it); a failure before that (no
        // certificate yet) keeps the upload waiting for another try.
        if (!err || !fs.existsSync(UPLOAD_FILE)) { UPLOAD = null; unlink(UPLOAD_FILE); }
        cb(err, r);
    });
}

// The page a phone or PC gets at http://<TV IP>:8077/upload: pick a file, send it, then look at
// the TV. Plain, inline, works in any browser of the last ten years.
function uploadPage() {
    var ip = ownIp() || 'this TV', waiting = UPLOAD ? '<p class="ok"><b>' + escHtml(UPLOAD.name) + '</b> is already waiting on the TV. Sending another file replaces it.</p>' : '';
    return '<!DOCTYPE html><html><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>TV-Store: send an app to the TV</title>'
        + '<style>body{margin:0;background:#0D1B2A;color:#F4F7FB;font-family:-apple-system,"Segoe UI",Roboto,Arial,sans-serif;padding:24px 16px}.card{max-width:520px;margin:0 auto;background:#142638;border-radius:20px;padding:22px}h1{font-size:22px;margin:0 0 6px}p{color:#9FB0C6;line-height:1.5;margin:8px 0}'
        + '.btn{display:block;width:100%;padding:16px;border:0;border-radius:14px;background:#2DD4BF;color:#042F2E;font:inherit;font-weight:700;font-size:18px;margin-top:16px}.btn[disabled]{background:rgba(244,247,251,.14);color:#9FB0C6}input[type=file]{width:100%;margin-top:12px;color:#9FB0C6}'
        + '.bar{height:10px;border-radius:5px;background:rgba(244,247,251,.14);overflow:hidden;margin-top:16px;display:none}.bar i{display:block;height:100%;width:0;background:#2DD4BF}.msg{margin-top:14px;font-size:16px;line-height:1.5}.ok{color:#30C46E}.bad{color:#FF6B5E}.mono{font-family:Menlo,Consolas,monospace;font-size:14px}</style></head>'
        + '<body><div class="card"><h1>Send an app to this TV</h1><p>Pick a Tizen package (<b>.wgt</b> or <b>.tpk</b>). It goes to TV-Store on <span class="mono">' + escHtml(ip) + '</span>. Nothing installs until you press <b>Install</b> on the TV screen.</p>' + waiting
        + '<input type="file" id="f" accept=".wgt,.tpk"><button class="btn" id="b" disabled>Send to the TV</button><div class="bar"><i id="i"></i></div><div class="msg" id="m"></div></div>'
        + '<script>(function(){var f=document.getElementById("f"),b=document.getElementById("b"),m=document.getElementById("m"),bar=document.querySelector(".bar"),i=document.getElementById("i");'
        + 'function esc(s){return String(s).replace(/&/g,"&amp;").replace(/</g,"&lt;")}'
        + 'f.onchange=function(){b.disabled=!f.files.length;m.textContent=""};'
        + 'b.onclick=function(){var file=f.files[0];if(!file)return;b.disabled=true;bar.style.display="block";i.style.width="0";m.className="msg";m.textContent="Sending "+file.name+" ("+(file.size/1048576).toFixed(1)+" MB)\\u2026";'
        + 'var x=new XMLHttpRequest();x.open("PUT","/upload?name="+encodeURIComponent(file.name),true);'
        + 'x.upload.onprogress=function(e){if(e.lengthComputable)i.style.width=Math.round(e.loaded/e.total*100)+"%"};'
        + 'x.onload=function(){var r={};try{r=JSON.parse(x.responseText)}catch(e){}if(x.status===200&&r.ok){i.style.width="100%";m.className="msg ok";m.innerHTML="<b>Sent.</b> Now look at the TV: TV-Store shows "+esc(r.upload.name)+" and asks whether to install it."}else{m.className="msg bad";m.textContent="The TV did not take it: "+(r.error||("HTTP "+x.status));b.disabled=false}};'
        + 'x.onerror=function(){m.className="msg bad";m.textContent="Could not reach the TV.";b.disabled=false};x.send(file)}})();</script></body></html>';
}
function escHtml(s) { return String(s).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;'); }

function logText() {
    var t = '';
    try { t += '--- previous run ---\n' + fs.readFileSync(LOG_PREV, 'utf8') + '\n'; } catch (e) {}
    try { t += '--- this run ---\n' + fs.readFileSync(LOG_FILE, 'utf8'); } catch (e) { t += '--- this run (memory) ---\n' + LOGS.join('\n') + '\n'; }
    return t;
}

// Every address of this TV, loopback included: the only peers the service answers (besides /log.txt).
function ownAddresses() {
    var out = ['127.0.0.1'];
    try { var ifs = os.networkInterfaces();
        for (var n in ifs) for (var i = 0; i < ifs[n].length; i++) if (ifs[n][i].family === 'IPv4') out.push(ifs[n][i].address);
    } catch (e) {}
    return out;
}
function fromThisTv(req) {
    var a = String(req.socket.remoteAddress || '').replace(/^::ffff:/, '');
    return /^127\./.test(a) || ownAddresses().indexOf(a) >= 0;
}

// This TV's own LAN IPv4 is the address sdbd accepts a connection on (phase 0: not loopback).
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
        if (res.statusCode >= 300 && res.statusCode < 400 && res.headers.location) { res.resume(); logv('http: ' + res.statusCode + ' redirect to ' + res.headers.location); return get(url.resolve(u, res.headers.location), cb, hops + 1); }
        if (res.statusCode !== 200) { res.resume(); return cb(new Error('HTTP ' + res.statusCode + ' for ' + u)); }
        var chunks = []; res.on('data', function (d) { chunks.push(d); }); res.on('end', function () { cb(null, Buffer.concat(chunks)); });
    });
    req.on('error', cb); req.setTimeout(30000, function () { req.abort(); });
}

// get() to a file, hashing on the way: cb(err, { size, sha256 }). A package never sits in memory.
function getToFile(u, file, cb, hops) {
    hops = hops || 0;
    if (hops > 5) return cb(new Error('too many redirects for ' + u));
    var o = url.parse(u), secure = o.protocol === 'https:', done = false;
    function fin(err, r) { if (done) return; done = true; cb(err, r); }
    var opts = { protocol: o.protocol, hostname: o.hostname, port: o.port || (secure ? 443 : 80), path: o.path,
                 headers: { 'User-Agent': 'Apps2Samsung-TV-Store' } };
    if (secure) opts.rejectUnauthorized = false;
    var req = (secure ? https : http).get(opts, function (res) {
        if (res.statusCode >= 300 && res.statusCode < 400 && res.headers.location) { res.resume(); done = true; logv('http: ' + res.statusCode + ' redirect to ' + res.headers.location); return getToFile(url.resolve(u, res.headers.location), file, cb, hops + 1); }
        if (res.statusCode !== 200) { res.resume(); return fin(new Error('HTTP ' + res.statusCode + ' for ' + u)); }
        var h = crypto.createHash('sha256'), size = 0, out = fs.createWriteStream(file);
        res.on('data', function (d) { size += d.length; h.update(d); });
        res.on('error', fin); out.on('error', fin);
        out.on('finish', function () { fin(null, { size: size, sha256: h.digest('hex') }); });
        res.pipe(out);
    });
    req.on('error', fin); req.setTimeout(30000, function () { req.abort(); });
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
    // certificate. (A file the user sent in by hand goes through installUpload instead, behind
    // the token only the TV-Store screen has.)
    withCatalog(function (err, cat) {
        if (err) return cb(err);
        if (!cat.index.hasOwnProperty(downloadUrl)) return cb(coded('NOT_IN_CATALOG', 'this download is not in the signed catalog'));
        var want = cat.index[downloadUrl];
        if (!want) return cb(coded('NO_HASH', 'the catalog has no hash for this file, so the TV cannot check it; install it from Apps2Samsung on a phone or PC'));
        if (!DATA_DIR) return cb(new Error('the service has no folder it can write to'));
        var base = path.join(DATA_DIR, 'job-' + Date.now()), inFile = base + '.in.wgt', outFile = base + '.signed.wgt';
        function clean(err, r) { [inFile, outFile].forEach(function (f) { try { fs.unlinkSync(f); } catch (e) {} }); cb(err, r); }
        log('install: downloading ' + downloadUrl);
        var started = Date.now();
        getToFile(downloadUrl, inFile, function (err, got) {
            logv('timing: download took ' + (Date.now() - started) + ' ms');
            if (err) return clean(err);
            if (got.sha256 !== want) { log('install: hash mismatch, got ' + got.sha256 + ' want ' + want); return clean(coded('HASH_MISMATCH', 'the download does not match the catalog (SHA-256 differs); not installing it')); }
            log('install: downloaded ' + got.size + ' bytes, SHA-256 matches the catalog; signing');
            // The Tizen version the package asks for, against the one the page reports for this TV
            // (#47): a package the TV would refuse with [118, -19] is turned away before the push.
            manifest.read(inFile, function (err, ids) {
                if (err) logv('install: could not read the manifest (' + err.message + '); the TV decides');
                else entry.requiredVersion = ids.requiredVersion;
                var gate = tizenGate(entry);
                if (gate) return clean(gate);
                signAndInstall(entry, remoteName, inFile, outFile, clean);
            });
        });
    });
}

function coded(code, message) { var e = new Error(message); e.code = code; return e; }

// The page sends the TV's platform version with every install (entry.tizen, "4.0"); the package's
// own manifest says what it asks for (entry.requiredVersion). A mismatch is refused here with the
// reason, instead of by the TV with a bare [118, -19] (#44, #47). Either side unknown: no gate.
function tizenGate(entry) {
    var tv = refusals.tizenVersionOf(entry), req = entry.requiredVersion || '';
    if (!manifest.needsNewer(req, tv)) return null;
    log('install: ' + (entry.file || 'the package') + ' asks for Tizen ' + req + ', this TV runs Tizen ' + tv + '; not pushing it');
    return coded('NEEDS_NEWER_TIZEN', 'This app asks for Tizen ' + req + ' or newer, and this TV runs Tizen ' + tv + '. The TV would refuse it. If the catalog has a build for older sets, pick that one.');
}

// An app installed from a phone or PC carries that device's author certificate, and the TV only
// updates it with the same one (#44). When the page asks for a replace, the old copy goes first
// (0 vd_appuninstall, the verb the heads use), on its own connection; a refusal is logged and the
// install goes ahead anyway, so the TV's own answer is what the user sees.
function removeOld(entry, cb) {
    var ip = ownIp();
    if (!entry.replace || !entry.packageId || !ip) return cb();
    log('install: removing the old copy of ' + entry.packageId + ' first (installed with another certificate)');
    connectSdb([ip, '127.0.0.1'], function (err, c) {
        if (err) { log('install: could not remove the old copy: ' + err.message); return cb(); }
        c.shell('0 vd_appuninstall ' + entry.packageId, function (err, out) {
            c.end();
            log('install: vd_appuninstall reply: ' + (err ? err.message : out.replace(/\s+/g, ' ').slice(0, 200)));
            cb();
        });
    });
}

// sdbd on this TV, at the first address that completes the handshake. The LAN IP is what Developer
// Mode's Host PC IP lets in; loopback is a fallback for a Host PC IP of 127.0.0.1.
// When none gets in, the error says what to change on the TV instead of the socket error (#26).
function connectSdb(hosts, cb, i, seen) {
    i = i || 0; seen = seen || [];
    var c = new sdb.SdbClient(hosts[i]);
    c.trace = VERBOSE ? function (m) { logv('sdb ' + hosts[i] + ': ' + m); } : null;
    c.connect(function (err) {
        if (!err) { log('install: sdb connected to ' + hosts[i] + ', first frame ' + c.firstFrame); return cb(null, c); }
        c.end();
        log('install: ' + err.message);
        seen.push({ code: err.code, frame: c.firstFrame });
        if (i + 1 < hosts.length) return connectSdb(hosts, cb, i + 1, seen);
        cb(sdbAdvice(err, seen, hosts[0]));
    });
}

// What the user can do about a failed sdb connection. A refused connection means sdbd is not
// listening: Developer Mode is off. One that sdbd accepts and drops without a word is what a caller
// other than the Host PC IP gets (the Tizen 10 report in #26, Host PC IP was 127.0.0.1).
function sdbAdvice(err, seen, ip) {
    if (seen.every(function (s) { return s.code === 'ECONNREFUSED'; }))
        return coded('DEV_MODE_OFF', 'Developer Mode is off on this TV. Turn it on (Apps, then 1 2 3 4 5) with Host PC IP ' + ip + ', restart the TV and try again.');
    if (seen.some(function (s) { return !s.frame && /^(ECONNRESET|EPIPE|SDB_CLOSED)$/.test(s.code || ''); }))
        return coded('HOST_PC_IP', 'The TV turned the install away. In Developer Mode (Apps, then 1 2 3 4 5), Host PC IP must be this TV\u2019s own IP, ' + ip + ', not 127.0.0.1 or a phone or PC. Change it, restart the TV and try again.');
    return err;
}

function signAndInstall(entry, remoteName, inFile, outFile, cb) {
    var started = Date.now();
    signer.signFile(inFile, outFile, loadCerts(), function (err) {
        if (err) { log('install: ' + err.message); return cb(err); }        // NO_CERT surfaces here
        try { fs.unlinkSync(inFile); } catch (e) {}
        var size = fs.statSync(outFile).size;
        log('install: signed in ' + Math.round((Date.now() - started) / 1000) + ' s, ' + size + ' bytes');
        var ip = ownIp();
        if (!ip) return cb(new Error('could not determine this TV’s own IP'));
        removeOld(entry, function () { connectSdb([ip, '127.0.0.1'], function (err, c) {
            if (err) return cb(err);
            var remote = STAGING + '/' + remoteName, fd;
            try { fd = fs.openSync(outFile, 'r'); } catch (e) { c.end(); return cb(e); }
            log('install: pushing to ' + remote);
            var pushStarted = Date.now();
            c.push(remote, { size: size, read: function (off, len) { return zip.readAt(fd, off, len); } }, function (err) {
                try { fs.closeSync(fd); } catch (e) {}
                if (err) { c.end(); return cb(err); }
                logv('timing: push took ' + (Date.now() - pushStarted) + ' ms');
                var installStarted = Date.now();
                c.shell('0 vd_appinstall ' + (entry.appId || entry.packageId || '') + ' ' + remote, function (err, out) {
                    c.end();
                    if (err) return cb(err);
                    logv('timing: vd_appinstall took ' + (Date.now() - installStarted) + ' ms');
                    log('install: vd_appinstall reply: ' + out.replace(/\s+/g, ' ').slice(0, 200));
                    // sdbd answers the shell call either way; the installer's own words say whether it
                    // worked ("install failed[118, -12], reason: ..." on a refused package).
                    var failed = /install failed\[([^\]]*)\](?:,\s*reason:\s*([^\n]*))?/i.exec(out);
                    if (failed) { var r = refusals.refusal(failed[1], failed[2], entry); return cb(coded(r.code, r.message)); }
                    cb(null, { reply: out });
                });
            });
        }); });
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
// (not a .p12: Node has no PKCS#12 parser). Kept in memory and persisted best-effort.
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
    // The page polls /ping and /logs all the time; those would drown the rest.
    if (VERBOSE && !/^\/(ping|logs|log\.txt|uploads)$/.test(route)) res.on('finish', function () { logv('http: ' + req.method + ' ' + route + ' -> ' + res.statusCode); });
    if (route === '/log.txt') { res.writeHead(200, { 'Content-Type': 'text/plain; charset=utf-8', 'Access-Control-Allow-Origin': '*' }); return res.end(logText()); }
    // The upload page and the upload itself come from a phone or PC (#30); the install of it only
    // from the TV-Store screen, below the gate and with the token.
    if (route === '/upload' && req.method === 'GET') { res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8' }); return res.end(uploadPage()); }
    if (route === '/upload' && (req.method === 'PUT' || req.method === 'POST')) return receiveUpload(req, res);
    // The rest only for this TV: the port is open to the LAN because Tizen 10 may not route a page's
    // request to the service over loopback, but nothing else on the network gets to hand over a
    // certificate or start an install.
    if (!fromThisTv(req)) { cors(res, 403, 'text/plain'); return res.end('only this TV may use TV-Store'); }
    if (route === '/ping') return json(res, 200, { ok: true, service: 'tv-store', ownIp: ownIp(), logUrl: 'http://' + ownIp() + ':' + PORT + '/log.txt', signerReady: signer.ready, certReady: haveCerts(),
        certFile: CERT_FILE, certError: CERT_ERROR, node: process.version, verbose: VERBOSE });
    if (route === '/settings' && req.method === 'POST') return body(req, function (err, b) {
        if (err || !b || typeof b.verbose !== 'boolean') return json(res, 400, { ok: false, error: 'need { verbose: true|false }' });
        setVerbose(b.verbose);
        json(res, 200, { ok: true, verbose: VERBOSE });
    });
    if (route === '/logs') return json(res, 200, { logs: LOGS });
    if (route === '/uploads') return json(res, 200, { pending: publicUpload(), busy: UPLOAD_BUSY });
    if (route === '/upload/discard' && req.method === 'POST') return body(req, function () {
        if (UPLOAD_BUSY) return json(res, 409, { ok: false, error: 'that file is being installed' });
        if (UPLOAD) log('upload: ' + UPLOAD.name + ' discarded on the TV');
        UPLOAD = null; unlink(UPLOAD_FILE);
        json(res, 200, { ok: true });
    });
    if (route === '/catalog') return withCatalog(function (err, cat) { if (err) { log('catalog: failed: ' + err.message); return json(res, 502, { ok: false, error: err.message }); } cors(res, 200, 'application/json'); res.end(cat.payload); });
    if (route === '/cert' && req.method === 'POST') return body(req, function (err, b) {
        if (err || !b || !b.authorKeyPem || !b.authorCertPem || !b.distributorKeyPem || !b.distributorCertPem) {
            log('cert: refused a handover that is not { authorKeyPem, authorCertPem, distributorKeyPem, distributorCertPem }');
            return json(res, 400, { ok: false, error: 'need { authorKeyPem, authorCertPem, distributorKeyPem, distributorCertPem }' });
        }
        log('cert: received signing certificate from a head'); saveCerts(b);
        json(res, 200, { ok: true, certFile: CERT_FILE, certError: CERT_FILE ? null : CERT_ERROR });
    });
    if (route === '/install' && req.method === 'POST') return body(req, function (err, b) {
        if (err || !b || !(b.url || b.upload)) return json(res, 400, { ok: false, error: 'need { url, file, appId } or { upload, token }' });
        (b.upload ? installUpload : install)(b, function (err, r) { if (err) { log('install: failed' + (err.code ? ' [' + err.code + ']' : '') + ': ' + err.message); return json(res, 200, { ok: false, error: err.message, code: err.code || null }); } json(res, 200, { ok: true, result: r }); });
    });
    cors(res, 404, 'text/plain'); res.end('not found');
}).listen(PORT, '0.0.0.0', function () { log('TV-Store service on port ' + PORT + ', node ' + process.version + ' ' + process.arch + ', this TV ' + ownIp() + ', data ' + DATA_DIR + (VERBOSE ? ', verbose logging on' : '')); logPlatform(); });

module.exports.onStart = function () { log('service onStart'); };
module.exports.onRequest = function () { log('service onRequest'); };
