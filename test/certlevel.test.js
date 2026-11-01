/* Public or Partner per install (#50), against the real service and a fake sdbd. A Public-only
 * TV: asking for Partner is refused up front (NEEDS_PARTNER, nothing pushed, the upload keeps
 * waiting), a package with a partner-level privilege installs Public. Then a Partner profile is
 * handed over as well: a new package with such a privilege is signed Partner by itself, one the
 * TV already took Public keeps Public, Sign with: Partner on it is a certificate mismatch that is
 * not retried with Public (replace fixes it), and Sign with: Public holds. /ping and /cert name
 * the level of each profile. Same harness as install.test.js. */
'use strict';
var fs = require('fs'), os = require('os'), path = require('path'), http = require('http'), cp = require('child_process');
var zip = require('../tizen-app/service/zip.js');
var Buf = require('../tizen-app/service/compat.js');
var fake = require('./fake-sdbd.js');

function fail(m) { console.error('FAIL: ' + m); process.exit(1); }
var SDB = 26194, F = path.join(__dirname, 'fixtures');
function pem(f) { return fs.readFileSync(path.join(F, f), 'utf8'); }
var PUB = { name: 'PC - Public', authorKeyPem: pem('author.key'), authorCertPem: pem('author.crt'), distributorKeyPem: pem('public-distributor.key'), distributorCertPem: pem('public-distributor.crt') };
var PAR = { name: 'PC - Partner', authorKeyPem: pem('partner-author.key'), authorCertPem: pem('partner-author.crt'), distributorKeyPem: pem('partner-distributor.key'), distributorCertPem: pem('partner-distributor.crt') };
var dir = path.join(os.tmpdir(), 'a2s-certlevel-' + process.pid + '-' + Date.now()); fs.mkdirSync(dir);
function wgt(pkgId, privs) {
    return zip.write([{ name: 'index.html', data: Buf.from('<html></html>') },
        { name: 'config.xml', data: Buf.from('<widget xmlns="http://www.w3.org/ns/widgets" xmlns:tizen="http://tizen.org/ns/widgets" version="1.0.0"><name>Probe</name><tizen:application id="' + pkgId + '.Probe" package="' + pkgId + '" required_version="2.3"/>'
            + (privs || []).map(function (p) { return '<tizen:privilege name="' + p + '"/>'; }).join('') + '</widget>') }]);
}
var PLAIN = wgt('A2SProbe01', ['http://tizen.org/privilege/internet']);
var DRM1 = wgt('A2SProbeD1', ['http://tizen.org/privilege/internet', 'http://developer.samsung.com/privilege/drmplay']);
var DRM2 = wgt('A2SProbeD2', ['http://developer.samsung.com/privilege/drmplay']);

function reply(pkgId, failed) {
    return failed ? 'install ' + pkgId + '.Probe package_path /x was_install_app return WAS_TRUE app_id[' + pkgId + '.Probe] install start installing[7] app_id[' + pkgId + '.Probe] install failed[118, -12], reason: Check certificate error : :Package with the same id and different certificate has been already installed.:<-12>\n'
                  : 'install ' + pkgId + '.Probe package_path /x was_install_app return WAS_TRUE installing[100] app_id[' + pkgId + '.Probe] install completed\n';
}
var replies = [], shells = [];
var child = null, err = '', handle = null;
var WD = setTimeout(function () { stop(); fail('watchdog (60 s)' + (err ? '\n' + err : '')); }, 60000);
function stop() { clearTimeout(WD); if (child) child.kill(); if (handle) try { handle.server.close(); } catch (e) {} }

fake.start(SDB, {
    shell: function (cmd) { shells.push(cmd); if (cmd.indexOf('vd_appinstall') >= 0) return replies.length ? replies.shift() : reply('A2SProbe01', false); return 'ok\n'; }
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
// Upload a package and install it with the given extra flags; cb(answer, installShellCalls, uploadInfo).
function installUpload(file, flags, cb) {
    var before = shells.length;
    call('PUT', '/upload?name=Probe.wgt', file, function (e, code, j) {
        if (e || code !== 200 || !j || !j.ok) fail('upload: ' + code + ' ' + JSON.stringify(j));
        var up = j.upload, body = { upload: up.id, token: token(), installed: true };
        Object.keys(flags).forEach(function (k) { body[k] = flags[k]; });
        call('POST', '/install', JSON.stringify(body), function (e, code, j) {
            if (e || code !== 200 || !j) fail('install call: ' + code + ' ' + JSON.stringify(j));
            cb(j, shells.slice(before), up);
        });
    });
}
function installs(calls) { return calls.filter(function (c) { return c.indexOf('vd_appinstall') >= 0; }).length; }
function logs(cb) { call('GET', '/logs', null, function (e, code, j) { cb((j && j.logs || []).join('\n')); }); }
function handOver(list, cb) {
    call('POST', '/cert', JSON.stringify({ certificates: list }), function (e, code, j) {
        if (e || code !== 200 || !j.ok) fail('hand-over: ' + code + ' ' + JSON.stringify(j));
        cb(j);
    });
}

function run() {
    // A Public-only TV.
    handOver([PUB], function (j) {
        if (JSON.stringify(j.certificates) !== JSON.stringify([{ name: 'PC - Public', level: 'public' }])) fail('/cert must answer the levels: ' + JSON.stringify(j));
        call('GET', '/ping', null, function (e, code, j) {
            if (JSON.stringify(j.certificates) !== JSON.stringify([{ name: 'PC - Public', level: 'public' }])) fail('/ping must name the level: ' + JSON.stringify(j));
            // 1. Sign with: Partner on a Public-only TV: refused before anything is signed, the file keeps waiting.
            installUpload(PLAIN, { certLevel: 'partner' }, function (j, calls, up) {
                if (j.ok || j.code !== 'NEEDS_PARTNER' || j.error.indexOf('PC - Public') < 0 || j.error.indexOf('Arm TV-Store again') < 0) fail('NEEDS_PARTNER: ' + JSON.stringify(j));
                if (calls.length) fail('nothing may reach sdbd: ' + JSON.stringify(calls));
                call('GET', '/uploads', null, function (e, code, j) {
                    if (!j.pending || j.pending.id !== up.id) fail('the upload must keep waiting after NEEDS_PARTNER: ' + JSON.stringify(j));
                    // 2. A package with a partner-level privilege: the upload says so; with no Partner profile it installs Public.
                    installUpload(DRM1, {}, function (j, calls, up) {
                        if (up.ids.partner !== true || up.ids.privileges.indexOf('http://developer.samsung.com/privilege/drmplay') < 0) fail('the upload must carry the privileges: ' + JSON.stringify(up.ids));
                        if (!j.ok || j.result.certificate !== 'PC - Public' || j.result.level !== 'public' || installs(calls) !== 1) fail('Public-only TV installs a partner-privilege package Public: ' + JSON.stringify(j));
                        bothLevels();
                    });
                });
            });
        });
    });
}

function bothLevels() {
    // Armed again from a PC that now has a Partner profile too: Public first, as the head sends it.
    handOver([PUB, PAR], function (j) {
        if (j.certCount !== 2 || JSON.stringify(j.certificates) !== JSON.stringify([{ name: 'PC - Public', level: 'public' }, { name: 'PC - Partner', level: 'partner' }])) fail('two levels: ' + JSON.stringify(j));
        // 3. A plain package: Public, the head's first choice.
        installUpload(PLAIN, {}, function (j, calls) {
            if (!j.ok || j.result.level !== 'public' || installs(calls) !== 1) fail('plain package stays Public: ' + JSON.stringify(j));
            // 4. A new package with a partner-level privilege: Partner by itself.
            installUpload(DRM2, {}, function (j, calls) {
                if (!j.ok || j.result.certificate !== 'PC - Partner' || j.result.level !== 'partner' || installs(calls) !== 1) fail('partner privilege picks Partner: ' + JSON.stringify(j));
                logs(function (text) {
                    if (!/signing with a Partner certificate: the package asks for partner-level privileges/.test(text)) fail('the log must say why:\n' + text);
                    // 5. The package the TV took Public before keeps Public, privilege or not (an update must match the author).
                    installUpload(DRM1, {}, function (j, calls) {
                        if (!j.ok || j.result.level !== 'public' || installs(calls) !== 1) fail('a package installed Public before keeps Public: ' + JSON.stringify(j));
                        // 6. Sign with: Partner on a package installed Public: the TV refuses the Partner author, and
                        // Public is not tried instead; the answer says to remove the old copy.
                        replies = [reply('A2SProbe01', true)];
                        installUpload(PLAIN, { certLevel: 'partner' }, function (j, calls) {
                            if (j.ok || j.code !== 'CERT_MISMATCH' || installs(calls) !== 1 || j.error.indexOf('1 Partner certificate') < 0 || j.error.indexOf('signed Partner') < 0) fail('partner wished, mismatch, no Public retry: ' + JSON.stringify(j) + ' ' + JSON.stringify(calls));
                            if (calls.some(function (c) { return c.indexOf('vd_appuninstall') >= 0; })) fail('nothing may be removed without replace');
                            // 7. Remove the old copy and install again, Partner: uninstall, then one install, remembered as Partner.
                            replies = [reply('A2SProbe01', false)];
                            installUpload(PLAIN, { certLevel: 'partner', replace: true }, function (j, calls) {
                                var un = calls.indexOf('0 vd_appuninstall A2SProbe01'), ins = -1;
                                calls.forEach(function (c, i) { if (ins < 0 && c.indexOf('vd_appinstall') >= 0) ins = i; });
                                if (!j.ok || j.result.level !== 'partner' || un < 0 || ins < 0 || un > ins || installs(calls) !== 1) fail('replace signed Partner: ' + JSON.stringify(j) + ' ' + JSON.stringify(calls));
                                // 8. From now on Automatic takes Partner for it: the remembered profile.
                                installUpload(PLAIN, {}, function (j, calls) {
                                    if (!j.ok || j.result.level !== 'partner' || installs(calls) !== 1) fail('remembered Partner: ' + JSON.stringify(j));
                                    // 9. Sign with: Public on it: only the Public profile is tried (the fake TV takes it).
                                    installUpload(PLAIN, { certLevel: 'public' }, function (j, calls) {
                                        if (!j.ok || j.result.level !== 'public' || installs(calls) !== 1) fail('public wished: ' + JSON.stringify(j));
                                        // 10. A choice the service does not know is Automatic.
                                        installUpload(DRM2, { certLevel: 'platform' }, function (j, calls) {
                                            if (!j.ok || j.result.level !== 'partner' || installs(calls) !== 1) fail('unknown choice is automatic: ' + JSON.stringify(j));
                                            stop();
                                            try { fs.readdirSync(dir).forEach(function (f) { fs.unlinkSync(path.join(dir, f)); }); fs.rmdirSync(dir); } catch (e) {}
                                            console.log('PASS: Partner refused up front on a Public-only TV, a partner privilege picks Partner when there is one, a remembered profile holds, Sign with: Partner is a mismatch fixed by replace, Sign with: Public holds, levels on /ping and /cert');
                                            process.exit(0);
                                        });
                                    });
                                });
                            });
                        });
                    });
                });
            });
        });
    });
}
