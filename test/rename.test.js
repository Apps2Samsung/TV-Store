/* Another app's package id (#84), against the real service: a local HTTPS server stands in for
 * apps2samsung.com and the download host, a fake sdbd for the installer. The official catalog has
 * Jellyfin and tacplayer, a fork that kept Jellyfin's package id. With Jellyfin on the TV,
 * tacplayer goes on beside it under the id derived from its catalog entry (config.xml, its service
 * component and the app code that launches it, all renamed); its update lands on that copy;
 * Jellyfin's own update keeps its id; /pkgids gives the page the same ids; a .tpk with another
 * app's id is refused until the person at the TV says Replace; and a page that does not say what
 * the TV has gets the behaviour from before. */
'use strict';
var fs = require('fs'), os = require('os'), path = require('path'), http = require('http'), https = require('https'), cp = require('child_process'), crypto = require('crypto');
var zip = require('../tizen-app/service/zip.js');
var Buf = require('../tizen-app/service/compat.js');
var pkgid = require('../tizen-app/service/pkgid.js');
var fake = require('./fake-sdbd.js');

var SDB = 26199, WEB = 26198, F = path.join(__dirname, 'fixtures'), R = path.join(F, 'repositories');
var child = null, err = '', handle = null, web = null, shells = [];
var WD = setTimeout(function () { fail('watchdog (60 s)' + (err ? '\n' + err : '')); }, 60000);
function stop() { clearTimeout(WD); if (child) child.kill(); if (handle) try { handle.server.close(); } catch (e) {} if (web) try { web.close(); } catch (e) {} }
function fail(m) { stop(); console.error('FAIL: ' + m); process.exit(1); }
function pem(f) { return fs.readFileSync(path.join(F, f), 'utf8'); }
var KEY = fs.readFileSync(path.join(R, 'keys', 'test.key.pem'), 'utf8');
var CERT = { name: 'PC - Public', authorKeyPem: pem('author.key'), authorCertPem: pem('author.crt'), distributorKeyPem: pem('public-distributor.key'), distributorCertPem: pem('public-distributor.crt') };
var dir = path.join(os.tmpdir(), 'a2s-rename-' + process.pid + '-' + Date.now()); fs.mkdirSync(dir);

// ---- what the web serves ------------------------------------------------------------------------------
function wgt(name, version, extra) {
    return zip.write([{ name: 'index.html', data: Buf.from('<html></html>') },
        { name: 'config.xml', data: Buf.from('<widget xmlns="http://www.w3.org/ns/widgets" xmlns:tizen="http://tizen.org/ns/widgets" version="' + version + '"><name>' + name + '</name>'
            + '<tizen:application id="AprZAARz4r.Jellyfin" package="AprZAARz4r" required_version="3.0"/><tizen:service id="AprZAARz4r.bg"><tizen:content src="bg.js"/></tizen:service></widget>') }].concat(extra || []));
}
var FILES = {
    '/j/Jellyfin.wgt': wgt('Jellyfin', '10.10.0'),
    '/c/tacplayer.wgt': wgt('tacplayer', '1.0.0', [{ name: 'js/app.js', data: Buf.from('tizen.application.launch("AprZAARz4r.bg");') }]),
    '/c2/tacplayer.wgt': wgt('tacplayer', '1.1.0'),
    '/c/Native.tpk': zip.write([{ name: 'tizen-manifest.xml', data: Buf.from('<manifest package="NatPkg0001" version="1.0.0" api-version="4.0"><label>Native</label><ui-application appid="NatPkg0001.App"/></manifest>') }])
};
function sha(b) { return crypto.createHash('sha256').update(b).digest('hex'); }
function asset(p, name) { return { name: name, browser_download_url: 'https://dl.test' + p, size: FILES[p].length, digest: 'sha256:' + sha(FILES[p]) }; }
var tacFile = '/c/tacplayer.wgt';
function official() {
    var json = JSON.stringify({ schemaVersion: 1, generatedAt: new Date(Date.now() - 60000).toISOString(), providers: [
        { id: 'jellyfin', ok: true, url: 'https://api.github.test/repos/jv/jellyfin/releases', releases: [{ assets: [asset('/j/Jellyfin.wgt', 'Jellyfin.wgt')] }] },
        { id: 'tizen-community', ok: true, url: 'https://api.github.test/repos/Apps2Samsung/tizen-community-packages/releases',
          catalog: { apps: [{ file: 'tacplayer.wgt', name: 'tacplayer', repo: 'cloud/tacplayer', package_id: 'AprZAARz4r' }, { file: 'Native.tpk', name: 'Native', repo: 'n/native', package_id: 'NatPkg0001' }] },
          releases: [{ assets: [asset(tacFile, 'tacplayer.wgt'), asset('/c/Native.tpk', 'Native.tpk')] }, { assets: [asset('/c2/tacplayer.wgt', 'tacplayer.wgt')] }] }
    ] }, null, 2) + '\n';
    return Buf.from(crypto.createSign('RSA-SHA256').update(Buf.from(json, 'utf8')).sign(KEY, 'base64') + '\n' + json, 'utf8');
}
function route(host, p) {
    if (host === 'official.test' && p === '/resolved.json.signed') return official();
    if (host === 'dl.test' && FILES[p]) return FILES[p];
    return null;
}
var TAC = pkgid.derive('cloud/tacplayer/tacplayer.wgt'), JF = pkgid.derive('jv/jellyfin/Jellyfin.wgt');

// ---- the service -------------------------------------------------------------------------------------
function start(cb) {
    var hosts = ['official.test', 'dl.test'].map(function (h) { return h + '=127.0.0.1:' + WEB; }).join(',');
    child = cp.spawn(process.execPath, [path.join(__dirname, '..', 'tizen-app', 'service', 'index.js')], { env: { HOME: dir, TMPDIR: dir, TMP: dir, TEMP: dir, PATH: process.env.PATH, A2S_SDB_PORT: String(SDB),
        A2S_CATALOG_URL: 'https://official.test/resolved.json.signed', A2S_CATALOG_KEY: path.join(R, 'keys', 'test.pub.pem'), A2S_RESOLVE: hosts }, stdio: ['ignore', 'ignore', 'pipe'] });
    child.stderr.on('data', function (d) { err += d; });
    var tries = 0;
    (function waitUp() {
        call('GET', '/ping', null, function (e, code) {
            if (e || code !== 200) { if (++tries > 100) fail('the service never answered /ping' + (err ? '\n' + err : '')); return setTimeout(waitUp, 100); }
            cb();
        });
    })();
}
function call(method, p, data, cb) {
    if (data && typeof data !== 'string') data = JSON.stringify(data);
    var req = http.request({ host: '127.0.0.1', port: 8077, path: p, method: method, headers: data ? { 'Content-Length': Buf.from(data, 'utf8').length, 'Content-Type': 'application/json' } : {} }, function (res) {
        var b = ''; res.on('data', function (d) { b += d; }); res.on('end', function () { var j = null; try { j = JSON.parse(b); } catch (e) {} cb(null, res.statusCode, j, b); });
    });
    req.on('error', function (e) { cb(e); });
    if (data) req.write(data);
    req.end();
}
// One install; cb(answer, the vd_appinstall commands it sent, what it pushed: { name: Buffer }).
function install(b, cb) {
    var before = shells.length;
    call('POST', '/install', b, function (e, code, j) {
        if (e || !j) fail('install: ' + (e && e.message));
        var cmds = shells.slice(before).filter(function (c) { return c.indexOf('vd_appinstall') >= 0; }), pushed = {};
        var m = cmds.length ? /(\S+)$/.exec(cmds[cmds.length - 1]) : null;
        if (m && handle.received[m[1]]) zip.readEntries(handle.received[m[1]]).forEach(function (x) { pushed[x.name] = x.data.toString('utf8'); });
        cb(j, cmds, pushed);
    });
}
function req(file, tvApps, extra) {
    var b = { url: 'https://dl.test' + file, file: path.basename(file), tizen: '6.0', source: 'official' };
    if (tvApps) b.tvApps = tvApps;
    for (var k in extra || {}) b[k] = extra[k];
    return b;
}

var steps = [], said = [];
function step(what, fn) { steps.push({ what: what, fn: fn }); }
function next() { var s = steps.shift(); if (!s) return done(); said.push(s.what); s.fn(next); }

step('/pkgids: the id each catalog file gets, the same Apps2Samsung derives', function (go) {
    call('POST', '/cert', { certificates: [CERT] }, function () {
        call('GET', '/pkgids', null, function (e, c, j) {
            if (!j || !j.ok || j.ids['https://dl.test' + tacFile] !== TAC || j.ids['https://dl.test/j/Jellyfin.wgt'] !== JF || !Array.isArray(j.renames) || j.renames.length) fail('/pkgids: ' + JSON.stringify(j));
            go();
        });
    });
});
step('nothing on the TV: Jellyfin keeps its id', function (go) {
    install(req('/j/Jellyfin.wgt', {}), function (j, cmds) {
        if (!j.ok || j.result.packageId !== 'AprZAARz4r' || j.result.renamed || cmds.length !== 1 || cmds[0].indexOf('vd_appinstall AprZAARz4r.Jellyfin ') < 0) fail('Jellyfin: ' + JSON.stringify([j, cmds]));
        go();
    });
});
step('tacplayer with Jellyfin on the TV: a separate app under its derived id', function (go) {
    install(req(tacFile, { AprZAARz4r: ['Jellyfin'] }), function (j, cmds, pushed) {
        if (!j.ok || j.result.packageId !== TAC || j.result.appId !== TAC + '.Jellyfin') fail('tacplayer: ' + JSON.stringify(j));
        if (JSON.stringify(j.result.renamed) !== JSON.stringify({ from: 'AprZAARz4r', to: TAC, why: 'collision', other: 'Jellyfin' })) fail('renamed: ' + JSON.stringify(j.result.renamed));
        if (cmds.length !== 1 || cmds[0].indexOf('vd_appinstall ' + TAC + '.Jellyfin ') < 0) fail('installed under the new app id: ' + JSON.stringify(cmds));
        var cfg = pushed['config.xml'] || '';
        if (cfg.indexOf('package="' + TAC + '"') < 0 || cfg.indexOf('<tizen:service id="' + TAC + '.bg"') < 0 || cfg.indexOf('AprZAARz4r') >= 0) fail('the pushed config.xml: ' + cfg);
        if (pushed['js/app.js'] !== 'tizen.application.launch("' + TAC + '.bg");') fail('the app code: ' + pushed['js/app.js']);
        if (!pushed['author-signature.xml'] || !pushed['signature1.xml']) fail('the renamed package is signed');
        call('GET', '/pkgids', null, function (e, c, p) {
            var r = p.renames[0];
            if (p.renames.length !== 1 || r.originalPackageId !== 'AprZAARz4r' || r.newPackageId !== TAC || r.newAppId !== TAC + '.Jellyfin' || r.originalAppId !== 'AprZAARz4r.Jellyfin' || r.key !== 'cloud/tacplayer/tacplayer.wgt') fail('the record: ' + JSON.stringify(p.renames));
            call('GET', '/ping', null, function (e, c, q) {
                if (q.sourceOf[TAC] !== 'official' || !q.remembered[TAC]) fail('source and certificate are remembered under the id on the TV: ' + JSON.stringify([q.sourceOf, q.remembered]));
                go();
            });
        });
    });
});
step('tacplayer\'s update lands on its renamed copy; Jellyfin\'s keeps its own id', function (go) {
    var tv = { AprZAARz4r: ['Jellyfin'] }; tv[TAC] = ['tacplayer'];
    install(req('/c2/tacplayer.wgt', tv), function (j, cmds) {
        if (!j.ok || j.result.packageId !== TAC || !j.result.renamed || j.result.renamed.why !== 'update' || j.result.renamed.other !== null || cmds[0].indexOf('vd_appinstall ' + TAC + '.Jellyfin ') < 0) fail('update: ' + JSON.stringify([j, cmds]));
        install(req('/j/Jellyfin.wgt', tv), function (j, cmds) {
            if (!j.ok || j.result.packageId !== 'AprZAARz4r' || j.result.renamed || cmds[0].indexOf('vd_appinstall AprZAARz4r.Jellyfin ') < 0) fail('Jellyfin update: ' + JSON.stringify([j, cmds]));
            go();
        });
    });
});
step('a .tpk with another app\'s id: refused until Replace', function (go) {
    install(req('/c/Native.tpk', { NatPkg0001: ['Something Else'] }), function (j, cmds) {
        if (j.ok || j.code !== 'PACKAGE_ID_TAKEN' || j.error.indexOf('Already on your TV: Something Else') < 0 || cmds.length) fail('tpk: ' + JSON.stringify([j, cmds]));
        install(req('/c/Native.tpk', { NatPkg0001: ['Something Else'] }, { replaceOther: true }), function (j, cmds) {
            if (!j.ok || j.result.packageId !== 'NatPkg0001' || cmds.length !== 1) fail('tpk replace: ' + JSON.stringify([j, cmds]));
            go();
        });
    });
});
step('a page that does not say what the TV has: as before #84', function (go) {
    install(req(tacFile, null), function (j, cmds) {
        if (!j.ok || j.result.renamed || cmds[0].indexOf('vd_appinstall AprZAARz4r.Jellyfin ') < 0) fail('without tvApps: ' + JSON.stringify([j, cmds]));
        go();
    });
});

function done() {
    call('GET', '/logs', null, function (e, c, j) {
        var text = (j && j.logs || []).join('\n');
        if (text.indexOf('which ‘Jellyfin’ on this TV already has; installing it as a separate app under ' + TAC) < 0) fail('the log says why:\n' + text);
        stop();
        try { fs.readdirSync(dir).forEach(function (f) { try { fs.unlinkSync(path.join(dir, f)); } catch (x) {} }); fs.rmdirSync(dir); } catch (x) {}
        console.log('PASS');
        said.forEach(function (s) { console.log('  ' + s); });
        process.exit(0);
    });
}

web = https.createServer({ key: pem('author.key'), cert: pem('author.crt') }, function (req, res) {
    var body = route(String(req.headers.host || '').replace(/:\d+$/, ''), req.url);
    if (!body) { res.writeHead(404); return res.end('not found'); }
    res.writeHead(200, { 'Content-Length': body.length }); res.end(body);
}).listen(WEB, '127.0.0.1', function () {
    fake.start(SDB, {
        shell: function (cmd) { shells.push(cmd); return cmd.indexOf('vd_appinstall') >= 0 ? 'install x installing[100] install completed\n' : 'ok\n'; }
    }, function (h) { handle = h; start(function () { next(); }); });
});
