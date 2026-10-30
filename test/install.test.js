/* The install path against the real service and a fake sdbd (#44): two profiles handed over, the
 * TV refuses the copy signed with the first ("same id and different certificate"), the service
 * signs again with the second and the install goes through; the profile that worked is remembered
 * for the package; when every profile is refused the answer is CERT_MISMATCH naming them; and
 * replace: true removes the old copy (0 vd_appuninstall) before the push. The service runs as a
 * child with its data folder in a temp dir and sdbd pointed at the fake through A2S_SDB_PORT. */
'use strict';
var fs = require('fs'), os = require('os'), path = require('path'), http = require('http'), cp = require('child_process');
var zip = require('../tizen-app/service/zip.js');
var Buf = require('../tizen-app/service/compat.js');
var fake = require('./fake-sdbd.js');

function fail(m) { console.error('FAIL: ' + m); process.exit(1); }
var SDB = 26193, F = path.join(__dirname, 'fixtures');
function pem(f) { return fs.readFileSync(path.join(F, f), 'utf8'); }
var PC = { name: 'PC - Public', authorKeyPem: pem('author.key'), authorCertPem: pem('author.crt'), distributorKeyPem: pem('distributor.key'), distributorCertPem: pem('distributor.crt') };
var PHONE = { name: 'Phone - Public', authorKeyPem: pem('distributor.key'), authorCertPem: pem('distributor.crt'), distributorKeyPem: pem('distributor.key'), distributorCertPem: pem('distributor.crt') };
var dir = path.join(os.tmpdir(), 'a2s-install-' + process.pid + '-' + Date.now()); fs.mkdirSync(dir);
var wgt = zip.write([{ name: 'index.html', data: Buf.from('<html></html>') },
    { name: 'config.xml', data: Buf.from('<widget xmlns="http://www.w3.org/ns/widgets" xmlns:tizen="http://tizen.org/ns/widgets" version="1.0.0"><name>Probe</name><tizen:application id="A2SProbe01.Probe" package="A2SProbe01" required_version="2.3"/></widget>') }]);

// What the fake sdbd answers: a script of replies per vd_appinstall, and a record of every shell call.
var MISMATCH = 'install A2SProbe01.Probe package_path /x was_install_app return WAS_TRUE app_id[A2SProbe01.Probe] install start installing[7] app_id[A2SProbe01.Probe] install failed[118, -12], reason: Check certificate error : :Package with the same id and different certificate has been already installed.:<-12>\n';
var OK = 'install A2SProbe01.Probe package_path /x was_install_app return WAS_TRUE installing[100] app_id[A2SProbe01.Probe] install completed\n';
var replies = [], shells = [];
var child = null, err = '', handle = null;
var WD = setTimeout(function () { stop(); fail('watchdog (40 s)' + (err ? '\n' + err : '')); }, 40000);
function stop() { clearTimeout(WD); if (child) child.kill(); if (handle) try { handle.server.close(); } catch (e) {} }

fake.start(SDB, {
    shell: function (cmd) { shells.push(cmd); if (cmd.indexOf('vd_appinstall') >= 0) return replies.length ? replies.shift() : OK; return 'ok\n'; }
}, function (h) {
    handle = h;
    child = cp.spawn(process.execPath, [path.join(__dirname, '..', 'tizen-app', 'service', 'index.js')], { env: { HOME: dir, TMPDIR: dir, TMP: dir, TEMP: dir, PATH: process.env.PATH, A2S_SDB_PORT: String(SDB) }, stdio: ['ignore', 'ignore', 'pipe'] });
    child.stderr.on('data', function (d) { err += d; });
    var tries = 0;
    (function waitUp() {
        call('GET', '/ping', null, function (e, code) {
            if (e || code !== 200) { if (++tries > 100 || child.exitCode !== null) fail('the service never answered /ping' + (err ? '\n' + err : '')); return setTimeout(waitUp, 100); }
            run();
        });
    })();
});

function call(method, p, data, cb) {
    var req = http.request({ host: '127.0.0.1', port: 8077, path: p, method: method, headers: data ? { 'Content-Length': data.length, 'Content-Type': typeof data === 'string' ? 'application/json' : 'application/octet-stream' } : {} }, function (res) {
        var b = ''; res.on('data', function (d) { b += d; }); res.on('end', function () { var j = null; try { j = JSON.parse(b); } catch (e) {} cb(null, res.statusCode, j, b); });
    });
    req.on('error', function (e) { cb(e); });
    if (data) req.write(data);
    req.end();
}
function token() { return fs.readFileSync(path.join(dir, '.a2s-upload-token'), 'utf8').trim(); }
// Upload the probe and install it with the given extra flags; cb(answer, installShellCalls).
function installUpload(flags, cb) {
    var before = shells.length;
    call('PUT', '/upload?name=Probe.wgt', wgt, function (e, code, j) {
        if (e || code !== 200 || !j || !j.ok) fail('upload: ' + code + ' ' + JSON.stringify(j));
        var body = { upload: j.upload.id, token: token(), installed: true };
        Object.keys(flags).forEach(function (k) { body[k] = flags[k]; });
        call('POST', '/install', JSON.stringify(body), function (e, code, j) {
            if (e || code !== 200 || !j) fail('install call: ' + code + ' ' + JSON.stringify(j));
            cb(j, shells.slice(before));
        });
    });
}
function logs(cb) { call('GET', '/logs', null, function (e, code, j) { cb((j && j.logs || []).join('\n')); }); }

function run() {
    // Hand over both profiles, PC first; the old single-profile shape must still be accepted too.
    call('POST', '/cert', JSON.stringify({ authorKeyPem: PC.authorKeyPem, authorCertPem: PC.authorCertPem, distributorKeyPem: PC.distributorKeyPem, distributorCertPem: PC.distributorCertPem, certificates: [PC, PHONE] }), function (e, code, j) {
        if (e || code !== 200 || !j.ok || j.certCount !== 2) fail('hand-over: ' + code + ' ' + JSON.stringify(j));
        call('GET', '/ping', null, function (e, code, j) {
            if (!j.certReady || j.certCount !== 2 || j.certNames.join('|') !== 'PC - Public|Phone - Public') fail('/ping after hand-over: ' + JSON.stringify(j));
            // 1. The TV refuses the PC's signature; the Phone's goes through.
            replies = [MISMATCH, OK];
            installUpload({}, function (j, calls) {
                if (!j.ok || j.result.certificate !== 'Phone - Public') fail('second profile must be taken: ' + JSON.stringify(j));
                if (calls.filter(function (c) { return c.indexOf('vd_appinstall') >= 0; }).length !== 2 || calls.some(function (c) { return c.indexOf('vd_appuninstall') >= 0; })) fail('expected two installs and no uninstall: ' + JSON.stringify(calls));
                logs(function (text) {
                    if (!/signed with ‘PC - Public’/.test(text) || !/trying ‘Phone - Public’/.test(text) || !/signed with ‘Phone - Public’/.test(text)) fail('log must show the retry:\n' + text);
                    var map = JSON.parse(fs.readFileSync(path.join(dir, '.a2s-tvstore-cert-by-package.json'), 'utf8'));
                    if (!map.A2SProbe01) fail('the profile that worked must be remembered for the package');
                    // 2. Next time the Phone's profile goes first, so one install is enough.
                    replies = [OK];
                    installUpload({}, function (j, calls) {
                        if (!j.ok || j.result.certificate !== 'Phone - Public' || calls.filter(function (c) { return c.indexOf('vd_appinstall') >= 0; }).length !== 1) fail('the remembered profile must go first: ' + JSON.stringify(j) + ' ' + JSON.stringify(calls));
                        // 3. Every profile refused: CERT_MISMATCH naming them, nothing removed.
                        replies = [MISMATCH, MISMATCH];
                        installUpload({}, function (j, calls) {
                            if (j.ok || j.code !== 'CERT_MISMATCH' || j.error.indexOf('None of the 2 certificates') < 0 || j.error.indexOf('Phone - Public') < 0) fail('all refused: ' + JSON.stringify(j));
                            if (calls.some(function (c) { return c.indexOf('vd_appuninstall') >= 0; })) fail('nothing may be removed without replace');
                            // 4. replace: the old copy goes first, then the install.
                            replies = [OK];
                            installUpload({ replace: true }, function (j, calls) {
                                if (!j.ok) fail('replace: ' + JSON.stringify(j));
                                var un = calls.indexOf('0 vd_appuninstall A2SProbe01'), ins = -1;
                                calls.forEach(function (c, i) { if (ins < 0 && c.indexOf('vd_appinstall') >= 0) ins = i; });
                                if (un < 0 || ins < 0 || un > ins) fail('replace must uninstall before installing: ' + JSON.stringify(calls));
                                stop();
                                try { fs.readdirSync(dir).forEach(function (f) { fs.unlinkSync(path.join(dir, f)); }); fs.rmdirSync(dir); } catch (e) {}
                                console.log('PASS: a refused signature is retried with the next profile, the one taken is remembered, all refused is CERT_MISMATCH, replace uninstalls first');
                                process.exit(0);
                            });
                        });
                    });
                });
            });
        });
    });
}
