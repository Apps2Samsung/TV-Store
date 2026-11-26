/* Updates while TV-Store is closed (#157), against the real service: a local HTTPS server stands in
 * for the catalog and the download host, a fake sdbd for the TV. The screen hands over its plan
 * and the service is stopped. Started again with nobody asking it anything, it waits, reads the
 * catalog and the TV's list and installs the one update the plan allows, without a request from
 * anyone; what landed is kept for the screen until the screen says it has shown it. With the
 * switch off nothing happens; a request during the wait means TV-Store is open and the round is
 * left to the screen; an app that runs is left alone; a download that does not match is one try,
 * not tried again in the same start; and a second look within the pause does not come. */
'use strict';
var fs = require('fs'), os = require('os'), path = require('path'), http = require('http'), https = require('https'), cp = require('child_process'), crypto = require('crypto');
var zip = require('../tizen-app/service/zip.js');
var Buf = require('../tizen-app/service/compat.js');
var fake = require('./fake-sdbd.js');

var SDB = 26173, WEB = 26174, F = path.join(__dirname, 'fixtures'), R = path.join(F, 'repositories');
var child = null, err = '', handle = null, web = null, shells = [];
var WD = setTimeout(function () { fail('watchdog (90 s)' + (err ? '\n' + err : '')); }, 90000);
function stop() { clearTimeout(WD); if (child) child.kill(); if (handle) try { handle.server.close(); } catch (e) {} if (web) try { web.close(); } catch (e) {} }
function fail(m) { var l = ''; try { l = '\n' + fs.readFileSync(path.join(dir, 'tvstore.log'), 'utf8'); } catch (e) {} stop(); console.error('FAIL: ' + m + l); process.exit(1); }
function pem(f) { return fs.readFileSync(path.join(F, f), 'utf8'); }
var KEY = fs.readFileSync(path.join(R, 'keys', 'test.key.pem'), 'utf8');
var CERT = { name: 'PC - Public', authorKeyPem: pem('author.key'), authorCertPem: pem('author.crt'), distributorKeyPem: pem('public-distributor.key'), distributorCertPem: pem('public-distributor.crt') };
var dir = path.join(os.tmpdir(), 'a2s-autoclosed-' + process.pid + '-' + Date.now()); fs.mkdirSync(dir);

function wgt(pkg, name, version) {
    return zip.write([{ name: 'index.html', data: Buf.from('<html>' + version + '</html>') },
        { name: 'config.xml', data: Buf.from('<widget xmlns="http://www.w3.org/ns/widgets" xmlns:tizen="http://tizen.org/ns/widgets" version="' + version + '"><name>' + name + '</name><tizen:application id="' + pkg + '.App" package="' + pkg + '" required_version="3.0"/></widget>') }]);
}
function sha(b) { return crypto.createHash('sha256').update(b).digest('hex'); }
// What the catalog says now, and what the TV lists; a test step changes both.
var probeVersion = '1.1.0', corrupt = false, onTv = { 'ProbePkg01.App': '1.0.0', 'OtherPkg01.App': '2.0.0' };
function official() {
    var probe = wgt('ProbePkg01', 'Probe', probeVersion), other = wgt('OtherPkg01', 'Other', '2.0.0');
    FILES = { '/Probe.wgt': corrupt ? Buf.from('not the package') : probe, '/Other.wgt': other };
    function asset(name, pkg, version, bytes) { return { name: name, browser_download_url: 'https://dl.test/' + name, size: bytes.length, digest: 'sha256:' + sha(bytes), package_id: pkg, app_id: pkg + '.App', package_version: version }; }
    var json = JSON.stringify({ schemaVersion: 1, generatedAt: new Date(Date.now() - 60000).toISOString(), providers: [
        { id: 'probe', ok: true, url: 'https://api.github.test/repos/x/probe/releases', releases: [{ assets: [asset('Probe.wgt', 'ProbePkg01', probeVersion, probe)] }] },
        { id: 'other', ok: true, url: 'https://api.github.test/repos/x/other/releases', releases: [{ assets: [asset('Other.wgt', 'OtherPkg01', '2.0.0', other)] }] }
    ] }, null, 2) + '\n';
    return Buf.from(crypto.createSign('RSA-SHA256').update(Buf.from(json, 'utf8')).sign(KEY, 'base64') + '\n' + json, 'utf8');
}
var FILES = {};
function route(host, p) {
    if (host === 'official.test' && p === '/resolved.json.signed') return official();
    if (host === 'dl.test' && FILES[p]) return FILES[p];
    return null;
}
function block(id) { return '------------------------------\n--------------app_id   =-------------\n--------------app_title   =' + id.split('.')[1] + '-------------\n--------------app_version   =' + onTv[id] + '-------------\n--------------install_date   =2026-11-01-------------\n--------------app_tizen_id   =' + id + '-------------\n--------------app_size   =1000-------------\n--------------is_removable   =1-------------\n------------------------------'; }

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
function kept() { try { return JSON.parse(fs.readFileSync(path.join(dir, '.a2s-auto.json'), 'utf8')); } catch (e) { return {}; } }
function logged() { try { return fs.readFileSync(path.join(dir, 'tvstore.log'), 'utf8'); } catch (e) { return ''; } }
function installs() { return shells.filter(function (c) { return c.indexOf('vd_appinstall') >= 0; }).length; }

// The service as a child; `ask`: wait until it answers (which also tells it that someone is there).
function start(env, ask, cb) {
    var e = { HOME: dir, TMPDIR: dir, TMP: dir, TEMP: dir, PATH: process.env.PATH, A2S_SDB_PORT: String(SDB), A2S_CATALOG_URL: 'https://official.test/resolved.json.signed',
              A2S_CATALOG_KEY: path.join(R, 'keys', 'test.pub.pem'), A2S_RESOLVE: ['official.test', 'dl.test'].map(function (h) { return h + '=127.0.0.1:' + WEB; }).join(','),
              A2S_AUTO_WAIT: '700', A2S_AUTO_RETRY: '200', A2S_RUNNING: 'none' };
    for (var k in env || {}) { if (env[k] === undefined) delete e[k]; else e[k] = env[k]; }
    child = cp.spawn(process.execPath, [path.join(__dirname, '..', 'tizen-app', 'service', 'index.js')], { env: e, stdio: ['ignore', 'ignore', 'pipe'] });
    child.stderr.on('data', function (d) { err += d; });
    if (!ask) return cb();
    var tries = 0;
    (function waitUp() {
        call('GET', '/ping', null, function (e, code) {
            if (e || code !== 200) { if (++tries > 100) fail('the service never answered /ping' + (err ? '\n' + err : '')); return setTimeout(waitUp, 100); }
            cb();
        });
    })();
}
function end(cb) { var c = child; child = null; if (!c) return cb(); c.on('exit', function () { setTimeout(cb, 100); }); c.kill(); }
// Until the log has `text` (after `from` characters), or not within ms.
function waitLog(text, from, ms, cb) {
    var t0 = Date.now();
    (function look() {
        if (logged().slice(from).indexOf(text) >= 0) return cb(true);
        if (Date.now() - t0 > ms) return cb(false);
        setTimeout(look, 50);
    })();
}
function planBody(closed, have) {
    return { token: token(), settings: { apps: true, self: false, closed: closed }, tizen: '6.0', tvApps: { ProbePkg01: ['Probe'], OtherPkg01: ['Other'] }, items: [
        { key: 'p:probe', name: 'Probe', file: 'Probe.wgt', source: 'official', packageId: 'ProbePkg01', appId: 'ProbePkg01.App', have: have, web: false, certLevel: '', self: false },
        { key: 'p:other', name: 'Other', file: 'Other.wgt', source: 'official', packageId: 'OtherPkg01', appId: 'OtherPkg01.App', have: '2.0.0', web: false, certLevel: '', self: false }] };
}

var steps = [], said = [];
function step(what, fn) { steps.push({ what: what, fn: fn }); }
function next() { var s = steps.shift(); if (!s) return done(); said.push(s.what); s.fn(next); }

step('the screen hands over its plan with the switch off; only the screen may', function (go) {
    start(null, true, function () {
        call('POST', '/cert', { certificates: [CERT] }, function () {
            var bad = planBody(false, '1.0.0'); bad.token = 'nope';
            call('POST', '/auto/plan', bad, function (e, c) {
                if (c !== 403) fail('a plan without the token: ' + c);
                call('POST', '/auto/plan', planBody(false, '1.0.0'), function (e, c, j) {
                    if (c !== 200 || !j.ok || !j.changed) fail('the plan: ' + c + ' ' + JSON.stringify(j));
                    call('POST', '/auto/plan', planBody(false, '1.0.0'), function (e, c, j) {
                        if (!j.ok || j.changed) fail('the same plan again: ' + JSON.stringify(j));
                        call('GET', '/uploads', null, function (e, c, j) {
                            if (!j.auto || j.auto.running !== null || j.auto.landed.length) fail('/uploads: ' + JSON.stringify(j));
                            end(go);
                        });
                    });
                });
            });
        });
    });
});
step('closed, the switch off: nothing is looked for', function (go) {
    var from = 0;   // the log starts again with every start of the service
    start(null, false, function () {
        setTimeout(function () {
            if (installs() || logged().slice(from).indexOf('auto:') >= 0) fail('the switch is off');
            // Someone asks only now: the wait is over, so this is not what kept the round away.
            call('POST', '/auto/plan', planBody(true, '1.0.0'), function (e, c, j) {
                if (!j || !j.changed) fail('the plan with the switch on: ' + JSON.stringify(j));
                end(go);
            });
        }, 1800);
    });
});
step('closed, a request during the wait: TV-Store is open, the round is the screen’s', function (go) {
    var from = 0;   // the log starts again with every start of the service
    start(null, true, function () {
        setTimeout(function () { if (installs() || logged().slice(from).indexOf('auto: TV-Store is closed') >= 0) fail('someone was there'); end(go); }, 1500);
    });
});
step('closed, the app runs: it is left alone', function (go) {
    var from = 0;   // the log starts again with every start of the service
    start({ A2S_RUNNING: 'ProbePkg01.App,org.tizen.netflix-app', A2S_AUTO_EVERY: '0' }, false, function () {
        waitLog('auto: nothing to update', from, 15000, function (ok) {
            if (!ok || installs()) fail('a running app');
            if (logged().slice(from).indexOf('auto: Probe waits: it is running') < 0) fail('the log says why');
            end(go);
        });
    });
});
step('closed, a TV that does not say what runs and has been on for a while: nothing', function (go) {
    var from = 0;   // the log starts again with every start of the service
    // No A2S_RUNNING and no platform object in a test: unknown. The machine has been up for longer than 1 ms.
    start({ A2S_RUNNING: undefined, A2S_AUTO_EVERY: '0', A2S_AUTO_BOOT: '1' }, false, function () {
        waitLog('nothing is installed over an app that may be on screen', from, 15000, function (ok) {
            if (!ok || installs()) fail('unknown and not just started');
            end(go);
        });
    });
});
step('closed, a download that does not match: one try, not again in this start', function (go) {
    var from = 0;   // the log starts again with every start of the service
    corrupt = true;
    start({ A2S_AUTO_EVERY: '0' }, false, function () {
        waitLog('auto: 0 updated, 1 failed', from, 15000, function (ok) {
            if (!ok || installs()) fail('a bad download');
            if (logged().slice(from).indexOf('[HASH_MISMATCH]') < 0) fail('the log says why');
            var k = kept();
            if (!k.tried['p:probe'] || k.tried['p:probe'].v !== '1.1.0' || k.tried['p:probe'].n !== 1 || k.landed.length) fail('one try written down: ' + JSON.stringify(k.tried));
            corrupt = false;
            end(go);
        });
    });
});
step('closed: the update installs with nobody asking, and waits for the screen', function (go) {
    var from = 0;   // the log starts again with every start of the service
    start({ A2S_AUTO_EVERY: '0' }, false, function () {
        waitLog('auto: 1 updated, 0 failed', from, 20000, function (ok) {
            if (!ok || installs() !== 1) fail('the update: ' + installs() + ' installs');
            var text = logged().slice(from);
            if (text.indexOf('auto: updating Probe from v1.0.0 to v1.1.0') < 0 || text.indexOf('auto: Probe is now v1.1.0') < 0) fail('the log says what happened');
            if (text.indexOf('Other') >= 0 && text.indexOf('auto: updating Other') >= 0) fail('Other had no update');
            var pushed = Object.keys(handle.received);
            if (!pushed.length) fail('nothing was pushed to the TV');
            onTv['ProbePkg01.App'] = '1.1.0';
            call('GET', '/uploads', null, function (e, c, j) {
                var l = j && j.auto && j.auto.landed;
                if (!l || l.length !== 1 || l[0].key !== 'p:probe' || l[0].version !== '1.1.0' || l[0].packageId !== 'ProbePkg01' || l[0].file !== 'Probe.wgt' || l[0].web !== '') fail('what landed: ' + JSON.stringify(j));
                call('POST', '/auto/seen', { token: 'nope' }, function (e, c) {
                    if (c !== 403) fail('seen without the token: ' + c);
                    call('POST', '/auto/seen', { token: token() }, function (e, c, j) {
                        if (!j.ok) fail('seen: ' + JSON.stringify(j));
                        call('GET', '/uploads', null, function (e, c, j) {
                            if (j.auto.landed.length) fail('shown, so gone: ' + JSON.stringify(j.auto));
                            if (kept().plan.items[0].have !== '1.1.0') fail('the plan knows the new version');
                            end(go);
                        });
                    });
                });
            });
        });
    });
});
step('closed, a newer version within the pause: not looked for yet', function (go) {
    var from = 0;   // the log starts again with every start of the service
    probeVersion = '1.2.0';
    start(null, false, function () {
        setTimeout(function () {
            if (installs() !== 1 || logged().slice(from).indexOf('auto: TV-Store is closed') >= 0) fail('the pause between two looks');
            end(go);
        }, 1800);
    });
});
step('closed, after the pause: the next version installs', function (go) {
    var from = 0;   // the log starts again with every start of the service
    start({ A2S_AUTO_EVERY: '0' }, false, function () {
        waitLog('auto: Probe is now v1.2.0', from, 20000, function (ok) {
            if (!ok || installs() !== 2) fail('the next version: ' + installs() + ' installs');
            end(go);
        });
    });
});

function done() {
    stop();
    said.forEach(function (s) { console.log('  ' + s); });
    console.log('PASS: updates while TV-Store is closed');
    process.exit(0);
}

web = https.createServer({ key: pem('author.key'), cert: pem('author.crt') }, function (req, res) {
    var body = route(String(req.headers.host || '').replace(/:\d+$/, ''), req.url);
    if (!body) { res.writeHead(404); return res.end('not found'); }
    res.writeHead(200, { 'Content-Length': body.length }); res.end(body);
}).listen(WEB, '127.0.0.1', function () {
    fake.start(SDB, {
        shell: function (cmd) {
            shells.push(cmd);
            if (cmd === '0 vd_applist') { var ids = Object.keys(onTv); return 'get app list...\napps count: ' + ids.length + '\n' + ids.map(block).join('\n') + '\nspend time for wascmd is [82]ms\n'; }
            return cmd.indexOf('vd_appinstall') >= 0 ? 'install x installing[100] install completed\n' : 'ok\n';
        }
    }, function (h) { handle = h; next(); });
});
