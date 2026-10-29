/* The upload path (#30) end to end against the real service: PUT /upload stores a Tizen package
 * and names it under /uploads; junk is refused; POST /install { upload } without the token is
 * refused and with the token reaches the signer (which has no certificate here); discard clears it.
 * The service is started as a child, with its data folder pointed at a temp dir through TMPDIR (and HOME for the certificate). */
'use strict';
var fs = require('fs'), os = require('os'), path = require('path'), http = require('http'), cp = require('child_process');
var zip = require('../tizen-app/service/zip.js');
var Buf = require('../tizen-app/service/compat.js');

function fail(m) { console.error('FAIL: ' + m); process.exit(1); }
var dir = path.join(os.tmpdir(), 'a2s-upload-' + process.pid + '-' + Date.now()); fs.mkdirSync(dir);
var wgt = zip.write([{ name: 'index.html', data: Buf.from('<html></html>') },
    { name: 'config.xml', data: Buf.from('<widget xmlns="http://www.w3.org/ns/widgets" xmlns:tizen="http://tizen.org/ns/widgets" version="1.0.0"><name>Probe</name><tizen:application id="A2SProbe01.Probe" package="A2SProbe01"/></widget>') }]);
var child = cp.spawn(process.execPath, [path.join(__dirname, '..', 'tizen-app', 'service', 'index.js')], { env: { HOME: dir, TMPDIR: dir, TMP: dir, TEMP: dir, PATH: process.env.PATH }, stdio: ['ignore', 'ignore', 'pipe'] }), err = '';
child.stderr.on('data', function (d) { err += d; });
var WD = setTimeout(function () { child.kill(); fail('watchdog (15 s)' + (err ? '\n' + err : '')); }, 15000);

function call(method, p, data, cb) {
    var req = http.request({ host: '127.0.0.1', port: 8077, path: p, method: method, headers: data ? { 'Content-Length': data.length, 'Content-Type': typeof data === 'string' ? 'application/json' : 'application/octet-stream' } : {} }, function (res) {
        var b = ''; res.on('data', function (d) { b += d; }); res.on('end', function () { var j = null; try { j = JSON.parse(b); } catch (e) {} cb(null, res.statusCode, j, b); });
    });
    req.on('error', function (e) { cb(e); });
    if (data) req.write(data);
    req.end();
}
function done(ok) { clearTimeout(WD); child.kill(); try { fs.readdirSync(dir).forEach(function (f) { fs.unlinkSync(path.join(dir, f)); }); fs.rmdirSync(dir); } catch (e) {} if (!ok) process.exit(1); console.log('PASS: upload stored and named, junk refused, install needs the token, discard clears it'); process.exit(0); }

var tries = 0;
(function waitUp() {
    call('GET', '/ping', null, function (e, code) {
        if (e || code !== 200) { if (++tries > 100 || child.exitCode !== null) fail('the service never answered /ping' + (err ? '\n' + err : '')); return setTimeout(waitUp, 100); }
        run();
    });
})();

function run() {
    var token = fs.readFileSync(path.join(dir, '.a2s-upload-token'), 'utf8').trim();
    if (!/^[0-9a-f]{48}$/.test(token)) fail('no token file in the data folder: ' + JSON.stringify(token));
    call('GET', '/upload', null, function (e, code, j, body) {
        if (e || code !== 200 || body.indexOf('Send an app to this TV') < 0) fail('GET /upload is not the upload page (' + code + ')');
        call('PUT', '/upload?name=junk.wgt', Buf.from('this is not a zip'), function (e, code, j) {
            if (e || code !== 400 || !j || j.ok || !/not a Tizen package/.test(j.error)) fail('junk must be refused: ' + code + ' ' + JSON.stringify(j));
            call('PUT', '/upload?name=notes.txt', wgt, function (e, code, j) {
                if (e || code !== 400 || !j || j.ok) fail('a .txt must be refused: ' + code + ' ' + JSON.stringify(j));
                call('PUT', '/upload?name=..%2F..%2FProbe%20App.wgt', wgt, function (e, code, j) {
                    if (e || code !== 200 || !j || !j.ok) fail('a .wgt must be taken: ' + code + ' ' + JSON.stringify(j));
                    var up = j.upload;
                    if (up.name !== 'Probe App.wgt' || up.size !== wgt.length || !/^[0-9a-f]{64}$/.test(up.sha256) || up.ids.appId !== 'A2SProbe01.Probe' || up.ids.packageId !== 'A2SProbe01' || up.ids.version !== '1.0.0' || up.ids.name !== 'Probe') fail('odd upload record ' + JSON.stringify(up));
                    if (!fs.existsSync(path.join(dir, 'upload.pkg'))) fail('the file is not in the data folder');
                    call('GET', '/uploads', null, function (e, code, j) {
                        if (e || code !== 200 || !j.pending || j.pending.id !== up.id) fail('/uploads does not list it: ' + JSON.stringify(j));
                        call('POST', '/install', JSON.stringify({ upload: up.id, token: 'wrong' }), function (e, code, j) {
                            if (e || code !== 200 || !j || j.ok || j.code !== 'NO_TOKEN') fail('install without the token must be refused: ' + JSON.stringify(j));
                            call('POST', '/install', JSON.stringify({ upload: up.id, token: token }), function (e, code, j) {
                                if (e || code !== 200 || !j || j.ok || j.code === 'NO_TOKEN' || j.code === 'NO_UPLOAD') fail('install with the token must reach the signer: ' + JSON.stringify(j));
                                // No certificate here, so the file stays and a discard clears it.
                                call('GET', '/uploads', null, function (e, code, j) {
                                    if (e || !j.pending) fail('the upload must still wait after a failed signing: ' + JSON.stringify(j));
                                    call('POST', '/upload/discard', '{}', function (e, code, j) {
                                        if (e || code !== 200 || !j.ok) fail('discard failed: ' + JSON.stringify(j));
                                        call('GET', '/uploads', null, function (e, code, j) {
                                            if (e || j.pending) fail('still pending after discard');
                                            if (fs.existsSync(path.join(dir, 'upload.pkg'))) fail('the file is still there after discard');
                                            done(true);
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
