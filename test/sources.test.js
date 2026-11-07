/* Independent repositories on the TV (#82), against the real service: a local HTTPS server stands
 * in for apps2samsung.com, two repositories and the download host (A2S_RESOLVE points their names at
 * it), a fake sdbd for the installer. Without sources the service behaves as before; a source is
 * checked and added only with the approved fingerprint and repository id, and only with the page's
 * token; a broken source next to a working one leaves the official catalog and the other source
 * working; an installed app updates from its own source and moves to another only when told to; a
 * rollback is refused; a removed source keeps its apps installed and offers them nothing. */
'use strict';
var fs = require('fs'), os = require('os'), path = require('path'), http = require('http'), https = require('https'), cp = require('child_process'), crypto = require('crypto');
var zip = require('../tizen-app/service/zip.js');
var Buf = require('../tizen-app/service/compat.js');
var repos = require('../tizen-app/service/repos.js');
var fake = require('./fake-sdbd.js');

var SDB = 26197, WEB = 26196, F = path.join(__dirname, 'fixtures'), R = path.join(F, 'repositories');
var child = null, err = '', handle = null, web = null, shells = [];
var WD = setTimeout(function () { fail('watchdog (90 s)' + (err ? '\n' + err : '')); }, 90000);
function stop() { clearTimeout(WD); if (child) child.kill(); if (handle) try { handle.server.close(); } catch (e) {} if (web) try { web.close(); } catch (e) {} }
function fail(m) { stop(); console.error('FAIL: ' + m); process.exit(1); }
function pem(f) { return fs.readFileSync(path.join(F, f), 'utf8'); }
var KEY = fs.readFileSync(path.join(R, 'keys', 'test.key.pem'), 'utf8'), PUB_PEM = fs.readFileSync(path.join(R, 'keys', 'test.pub.pem'), 'utf8');
var FP = repos.keyInfo(PUB_PEM).fingerprint, OTHER_FP = repos.keyInfo(fs.readFileSync(path.join(R, 'keys', 'other.pub.pem'), 'utf8')).fingerprint;
var CERT = { name: 'PC - Public', authorKeyPem: pem('author.key'), authorCertPem: pem('author.crt'), distributorKeyPem: pem('public-distributor.key'), distributorCertPem: pem('public-distributor.crt') };
var dir = path.join(os.tmpdir(), 'a2s-sources-' + process.pid + '-' + Date.now()); fs.mkdirSync(dir);

// ---- what the web serves ------------------------------------------------------------------------------
function wgt(pkg, version) {
    return zip.write([{ name: 'index.html', data: Buf.from('<html></html>') },
        { name: 'config.xml', data: Buf.from('<widget xmlns="http://www.w3.org/ns/widgets" xmlns:tizen="http://tizen.org/ns/widgets" version="' + version + '"><name>' + pkg + '</name><tizen:application id="' + pkg + '.App" package="' + pkg + '" required_version="3.0"/></widget>') }]);
}
function sha(b) { return crypto.createHash('sha256').update(b).digest('hex'); }
function sign(obj) { var json = JSON.stringify(obj, null, 2) + '\n'; return Buf.from(crypto.createSign('RSA-SHA256').update(Buf.from(json, 'utf8')).sign(KEY, 'base64') + '\n' + json, 'utf8'); }
function iso(msAgo) { return new Date(Date.now() - msAgo).toISOString().replace(/\.\d+Z$/, 'Z'); }
var FILES = {
    '/official/Shared.wgt': wgt('SrcShared1', '1.0.0'),
    '/good/Shared.wgt': wgt('SrcShared1', '2.0.0'),
    '/good/Only.wgt': wgt('SrcOnly001', '1.0.0'),
    '/good/Evil.wgt': wgt('SrcEvil001', '1.0.0')
};
function asset(p, name, pkg, version, digestOf) {
    return { name: name, browser_download_url: 'https://dl.test' + p, size: FILES[p].length, digest: 'sha256:' + sha(digestOf || FILES[p]), package_version: version, package_id: pkg, app_id: pkg + '.App', required_version: '3.0' };
}
var OFFICIAL = sign({ schemaVersion: 1, generatedAt: iso(60000), providers: [{ id: 'shared', ok: true, releases: [{ assets: [asset('/official/Shared.wgt', 'Shared.wgt', 'SrcShared1', '1.0.0')] }] }] });
function repo(id, name, msAgo) {
    return { schemaVersion: 1, repository: { id: id, name: name, maintainer: 'Test' }, generatedAt: iso(msAgo), providers: [
        { id: 'shared', category: 'media', url: 'https://api.github.test/repos/t/shared/releases', releases: [{ tag_name: 'v2', assets: [asset('/good/Shared.wgt', 'Shared.wgt', 'SrcShared1', '2.0.0')] }] },
        { id: 'only', category: 'tools', url: 'https://api.github.test/repos/t/only/releases', releases: [{ tag_name: 'v1', assets: [asset('/good/Only.wgt', 'Only.wgt', 'SrcOnly001', '1.0.0')] }] },
        { id: 'evil', category: 'tools', url: 'https://api.github.test/repos/t/evil/releases', releases: [{ tag_name: 'v1', assets: [asset('/good/Evil.wgt', 'Evil.wgt', 'SrcEvil001', '1.0.0', Buf.from('other bytes', 'utf8'))] }] }
    ] };
}
var GOOD_NEW = sign(repo('org.example.good', 'Good Repo', 3600000)), GOOD_OLD = sign(repo('org.example.good', 'Good Repo', 7200000));
var FLAKY = sign(repo('org.example.flaky', 'Flaky Repo', 3600000)), FLAKY_BROKEN = Buf.from(FLAKY); FLAKY_BROKEN[FLAKY_BROKEN.length - 10] ^= 1;
var serve = { good: GOOD_NEW, flaky: FLAKY };
var hits = {};

function route(host, p) {
    hits[host + p] = (hits[host + p] || 0) + 1;
    if (host === 'official.test' && p === '/resolved.json.signed') return OFFICIAL;
    if (host === 'repo.test' && p === '/good/repository.json.signed') return serve.good;
    if (host === 'repo.test' && p === '/flaky/repository.json.signed') return serve.flaky;
    if (host === 'repo.test' && /^\/(good|flaky)\/repository\.pem$/.test(p)) return Buf.from(PUB_PEM, 'utf8');
    if (host === 'dl.test' && FILES[p]) return FILES[p];
    return null;
}

// ---- the service -------------------------------------------------------------------------------------
function start(cb) {
    var hosts = ['official.test', 'repo.test', 'dl.test'].map(function (h) { return h + '=127.0.0.1:' + WEB; }).join(',');
    child = cp.spawn(process.execPath, [path.join(__dirname, '..', 'tizen-app', 'service', 'index.js')], { env: { HOME: dir, TMPDIR: dir, TMP: dir, TEMP: dir, PATH: process.env.PATH, A2S_SDB_PORT: String(SDB),
        A2S_CATALOG_URL: 'https://official.test/resolved.json.signed', A2S_CATALOG_KEY: path.join(R, 'keys', 'test.pub.pem'), A2S_RESOLVE: hosts }, stdio: ['ignore', 'ignore', 'pipe'] });
    child.stderr.on('data', function (d) { err += d; });
    var tries = 0;
    (function waitUp() {
        call('GET', '/ping', null, function (e, code, j) {
            if (e || code !== 200) { if (++tries > 100) fail('the service never answered /ping' + (err ? '\n' + err : '')); return setTimeout(waitUp, 100); }
            cb(j);
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
function token() { return fs.readFileSync(path.join(dir, '.a2s-upload-token'), 'utf8').trim(); }
function installs() { return shells.filter(function (c) { return c.indexOf('vd_appinstall') >= 0; }).length; }
function install(b, cb) {
    var before = installs();
    call('POST', '/install', b, function (e, code, j) { if (e || !j) fail('install: ' + (e && e.message)); cb(j, installs() - before); });
}
function good(extra) { var s = { url: 'https://repo.test/good/repository.json.signed', repositoryId: 'org.example.good', fingerprint: FP }; for (var k in extra) s[k] = extra[k]; return s; }
function flaky(extra) { var s = { url: 'https://repo.test/flaky/repository.json.signed', repositoryId: 'org.example.flaky', fingerprint: FP, publicKeyPem: PUB_PEM }; for (var k in extra) s[k] = extra[k]; return s; }
function sourcesCatalog(cb) { call('GET', '/sources/catalog?fresh=1', null, function (e, code, j) { if (e || !j || !j.ok) fail('/sources/catalog: ' + JSON.stringify(j)); var by = {}; j.sources.forEach(function (s) { by[s.repositoryId] = s; }); cb(by, j.sources); }); }
function ping(cb) { call('GET', '/ping', null, function (e, code, j) { cb(j); }); }

// Steps, one after the other.
var steps = [], said = [];
function step(what, fn) { steps.push({ what: what, fn: fn }); }
function next() { var s = steps.shift(); if (!s) return done(); said.push(s.what); s.fn(next); }

step('no sources: as before', function (go) {
    ping(function (p) {
        if (!Array.isArray(p.sources) || p.sources.length || JSON.stringify(p.sourceOf) !== '{}') fail('a fresh service has no sources: ' + JSON.stringify([p.sources, p.sourceOf]));
        sourcesCatalog(function (by, list) {
            if (list.length) fail('no sources, none listed');
            call('POST', '/cert', { certificates: [CERT] }, function () {
                install({ url: 'https://dl.test/official/Shared.wgt', file: 'Shared.wgt', appId: 'SrcShared1.App', packageId: 'SrcShared1', name: 'Shared' }, function (j, n) {
                    if (!j.ok || n !== 1 || j.result.source !== 'official') fail('an official install without a source: ' + JSON.stringify(j));
                    ping(function (p) { if (p.sourceOf.SrcShared1 !== 'official') fail('remembered as official: ' + JSON.stringify(p.sourceOf)); go(); });
                });
            });
        });
    });
});
step('check: approved fingerprint and id only', function (go) {
    call('POST', '/sources/check', good(), function (e, c, j) {
        if (!j.ok || j.source.name !== 'Good Repo' || j.source.apps !== 3 || j.source.domain !== 'repo.test' || j.source.fingerprint !== FP) fail('check: ' + JSON.stringify(j));
        if (!hits['repo.test/good/repository.pem']) fail('without a key handed over, repository.pem is fetched and pinned by the fingerprint');
        call('POST', '/sources/check', good({ fingerprint: OTHER_FP }), function (e, c, j) {
            if (j.ok || j.reason !== 'fingerprint') fail('another fingerprint: ' + JSON.stringify(j));
            call('POST', '/sources/check', good({ repositoryId: 'org.example.other' }), function (e, c, j) {
                if (j.ok || j.reason !== 'repository-id') fail('another repository id: ' + JSON.stringify(j));
                call('POST', '/sources/check', good({ url: 'https://127.0.0.1/r.signed' }), function (e, c, j) {
                    if (j.ok || j.code !== 'BAD_SOURCE') fail('an IP address: ' + JSON.stringify(j));
                    call('GET', '/sources', null, function (e, c, j) { if (j.sources.length) fail('a check keeps nothing'); go(); });
                });
            });
        });
    });
});
step('add: only with the page token', function (go) {
    call('POST', '/sources/add', good(), function (e, c, j) {
        if (c !== 403 || j.ok) fail('an add without the token: ' + c + ' ' + JSON.stringify(j));
        call('POST', '/sources/add', good({ token: token() }), function (e, c, j) {
            if (!j.ok || j.sources.length !== 1 || j.sources[0].name !== 'Good Repo' || !j.sources[0].ok) fail('add good: ' + JSON.stringify(j));
            call('POST', '/sources/add', flaky({ token: token() }), function (e, c, j) {
                if (!j.ok || j.sources.length !== 2) fail('add flaky: ' + JSON.stringify(j));
                var stored = JSON.parse(fs.readFileSync(path.join(dir, '.a2s-sources.json'), 'utf8')).sources;
                if (stored.length !== 2 || !stored[0].publicKeyPem || stored[0].lastGeneratedAt !== JSON.parse(GOOD_NEW.toString('utf8').split('\n').slice(1).join('\n')).generatedAt) fail('stored: ' + JSON.stringify(stored));
                ping(function (p) { if (p.sources.length !== 2 || p.sources.some(function (s) { return 'publicKeyPem' in s; })) fail('/ping lists the sources, without keys'); go(); });
            });
        });
    });
});
step('a broken source next to a working one', function (go) {
    serve.flaky = FLAKY_BROKEN;
    sourcesCatalog(function (by) {
        if (!by['org.example.good'].manifest || by['org.example.good'].error) fail('the good source still loads: ' + JSON.stringify(by['org.example.good']));
        if (by['org.example.flaky'].manifest || by['org.example.flaky'].reason !== 'signature' || !by['org.example.flaky'].lastError) fail('the broken source says why and drops out: ' + JSON.stringify(by['org.example.flaky']));
        install({ url: 'https://dl.test/good/Shared.wgt', file: 'Shared.wgt', appId: 'SrcShared1.App', packageId: 'SrcShared1', name: 'Shared', source: 'org.example.flaky', installed: false }, function (j, n) {
            if (j.ok || j.code !== 'SOURCE_FAILED' || n) fail('nothing installs from a broken source: ' + JSON.stringify(j));
            call('GET', '/catalog', null, function (e, c, j) { if (c !== 200 || !j || !j.providers) fail('the official catalog still loads'); go(); });
        });
    });
});
step('install from a source, hash checked', function (go) {
    install({ url: 'https://dl.test/good/Only.wgt', file: 'Only.wgt', appId: 'SrcOnly001.App', packageId: 'SrcOnly001', name: 'Only', source: 'org.example.good' }, function (j, n) {
        if (!j.ok || n !== 1 || j.result.source !== 'org.example.good') fail('install from good: ' + JSON.stringify(j));
        install({ url: 'https://dl.test/good/Evil.wgt', file: 'Evil.wgt', appId: 'SrcEvil001.App', packageId: 'SrcEvil001', name: 'Evil', source: 'org.example.good' }, function (j, n) {
            if (j.ok || j.code !== 'HASH_MISMATCH' || n) fail('a file that does not hash to its digest: ' + JSON.stringify(j));
            install({ url: 'https://dl.test/official/Shared.wgt', file: 'Shared.wgt', appId: 'SrcShared1.App', packageId: 'SrcShared1', name: 'Shared', source: 'org.example.good' }, function (j, n) {
                if (j.ok || j.code !== 'NOT_IN_CATALOG' || n) fail('a file of another source: ' + JSON.stringify(j));
                ping(function (p) { if (p.sourceOf.SrcOnly001 !== 'org.example.good') fail('remembered: ' + JSON.stringify(p.sourceOf)); go(); });
            });
        });
    });
});
step('same package from two sources: never switched silently', function (go) {
    var b = { url: 'https://dl.test/good/Shared.wgt', file: 'Shared.wgt', appId: 'SrcShared1.App', packageId: 'SrcShared1', name: 'Shared', source: 'org.example.good', installed: true };
    install(b, function (j, n) {
        if (j.ok || j.code !== 'SOURCE_SWITCH' || n) fail('a switch without a yes: ' + JSON.stringify(j));
        b.switchSource = true;
        install(b, function (j, n) {
            if (!j.ok || n !== 1) fail('a switch confirmed on the TV: ' + JSON.stringify(j));
            ping(function (p) {
                if (p.sourceOf.SrcShared1 !== 'org.example.good') fail('moved to good: ' + JSON.stringify(p.sourceOf));
                // And back to the official catalog, also only when told; it installs with the broken source still there.
                install({ url: 'https://dl.test/official/Shared.wgt', file: 'Shared.wgt', appId: 'SrcShared1.App', packageId: 'SrcShared1', name: 'Shared', installed: true }, function (j, n) {
                    if (j.ok || j.code !== 'SOURCE_SWITCH' || n) fail('back to official without a yes: ' + JSON.stringify(j));
                    install({ url: 'https://dl.test/official/Shared.wgt', file: 'Shared.wgt', appId: 'SrcShared1.App', packageId: 'SrcShared1', name: 'Shared', installed: true, switchSource: true, source: 'official' }, function (j, n) {
                        if (!j.ok || n !== 1 || j.result.source !== 'official') fail('back to official: ' + JSON.stringify(j));
                        go();
                    });
                });
            });
        });
    });
});
step('rollback refused', function (go) {
    serve.good = GOOD_OLD;
    sourcesCatalog(function (by) {
        if (by['org.example.good'].reason !== 'rollback' || by['org.example.good'].manifest) fail('an older manifest after a newer one: ' + JSON.stringify(by['org.example.good']));
        serve.good = GOOD_NEW;
        sourcesCatalog(function (by) { if (!by['org.example.good'].manifest) fail('the newer one again is fine'); go(); });
    });
});
step('turn off, on, remove', function (go) {
    call('POST', '/sources/enable', { repositoryId: 'org.example.flaky', enabled: false }, function (e, c, j) {
        if (c !== 403) fail('a change without the token');
        call('POST', '/sources/enable', { repositoryId: 'org.example.flaky', enabled: false, token: token() }, function (e, c, j) {
            if (!j.ok || j.sources[1].enabled !== false) fail('off: ' + JSON.stringify(j));
            sourcesCatalog(function (by) {
                if (!by['org.example.flaky'] || by['org.example.flaky'].manifest || by['org.example.flaky'].error || by['org.example.flaky'].enabled !== false) fail('a source that is off is listed, not loaded: ' + JSON.stringify(by['org.example.flaky']));
                call('POST', '/sources/remove', { repositoryId: 'org.example.good', token: token() }, function (e, c, j) {
                    if (!j.ok || j.sources.length !== 1) fail('remove: ' + JSON.stringify(j));
                    ping(function (p) {
                        if (p.sourceOf.SrcOnly001 !== 'org.example.good') fail('the app stays remembered with its removed source');
                        install({ url: 'https://dl.test/good/Only.wgt', file: 'Only.wgt', appId: 'SrcOnly001.App', packageId: 'SrcOnly001', name: 'Only', source: 'org.example.good', installed: true }, function (j, n) {
                            if (j.ok || j.code !== 'UNKNOWN_SOURCE' || n) fail('no updates from a removed source: ' + JSON.stringify(j));
                            install({ url: 'https://dl.test/good/Only.wgt', file: 'Only.wgt', appId: 'SrcOnly001.App', packageId: 'SrcOnly001', name: 'Only', installed: true, switchSource: true }, function (j, n) {
                                if (j.ok || j.code !== 'NOT_IN_CATALOG' || n) fail('nor from the official catalog that never had it: ' + JSON.stringify(j));
                                go();
                            });
                        });
                    });
                });
            });
        });
    });
});
step('kept across a restart', function (go) {
    child.kill(); child = null;
    setTimeout(function () {
        start(function (p) {
            if (p.sources.length !== 1 || p.sources[0].repositoryId !== 'org.example.flaky' || p.sources[0].enabled !== false || p.sourceOf.SrcOnly001 !== 'org.example.good') fail('after a restart: ' + JSON.stringify([p.sources, p.sourceOf]));
            go();
        });
    }, 300);
});

function done() {
    call('GET', '/logs', null, function (e, c, j) {
        var text = (j && j.logs || []).join('\n');
        if (text.indexOf('BEGIN PUBLIC KEY') >= 0 || text.indexOf('PRIVATE KEY') >= 0) fail('the log holds key material');
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
