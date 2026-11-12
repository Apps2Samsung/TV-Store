/* Another app holds the TV's sdbd and shares it through its own sdb tunnel on 127.0.0.1 (#90): Vetro
 * keeps one connection to sdbd open for as long as it runs and multiplexes everyone over it on port
 * 26201, and sdbd takes one client at a time, so every direct connection TV-Store makes is dropped.
 * The install must then go through the tunnel, and the next one go there first. When the tunnel
 * cannot get in either, the advice is still the one the direct attempts call for (HOST_PC_IP), not
 * something the tunnel's answer made up. Against the real service with sdbd and the tunnel pointed
 * at fakes (A2S_SDB_PORT, A2S_TUNNEL_PORT); the fake tunnel is a second fake sdbd, which is what a
 * multiplexing tunnel looks like to a client. */
'use strict';
var fs = require('fs'), os = require('os'), path = require('path'), http = require('http'), net = require('net'), cp = require('child_process');
var zip = require('../tizen-app/service/zip.js');
var sdb = require('../tizen-app/service/sdb.js');
var Buf = require('../tizen-app/service/compat.js');
var fake = require('./fake-sdbd.js');

function fail(m) { stop(); console.error('FAIL: ' + m); process.exit(1); }
var SDB = 26185, TUN = 26186, F = path.join(__dirname, 'fixtures');
function pem(f) { return fs.readFileSync(path.join(F, f), 'utf8'); }
var CERT = { name: 'PC - Public', authorKeyPem: pem('author.key'), authorCertPem: pem('author.crt'), distributorKeyPem: pem('distributor.key'), distributorCertPem: pem('distributor.crt') };
var dir = path.join(os.tmpdir(), 'a2s-tunnel-' + process.pid + '-' + Date.now()); fs.mkdirSync(dir);
// The relay's start-up check (0.3.28) connects to sdbd once, a second after start; this test counts
// sdbd's connections, so it starts with the relay off by choice, which skips that check.
fs.writeFileSync(path.join(dir, '.a2s-relay.json'), JSON.stringify({ enabled: false }));
var wgt = zip.write([{ name: 'index.html', data: Buf.from('<html></html>') },
    { name: 'config.xml', data: Buf.from('<widget xmlns="http://www.w3.org/ns/widgets" xmlns:tizen="http://tizen.org/ns/widgets" version="1.0.0"><name>Probe</name><tizen:application id="A2SProbe01.Probe" package="A2SProbe01" required_version="2.3"/></widget>') }]);
var INSTALLED = 'install A2SProbe01.Probe package_path /x was_install_app return WAS_TRUE installing[100] app_id[A2SProbe01.Probe] install completed\n';

var child = null, err = '', sdbd = null, tunnel = null, holder = null, dropper = null;
var WD = setTimeout(function () { fail('watchdog (40 s)' + (err ? '\n' + err : '')); }, 40000);
function stop() {
    clearTimeout(WD);
    if (child) child.kill();
    if (holder) try { holder.destroy(); } catch (e) {}
    [sdbd, tunnel].forEach(function (h) { if (h && h.server) try { h.server.close(); } catch (e) {} });
    if (dropper) try { dropper.close(); } catch (e) {}
}

function call(method, p, data, cb) {
    var req = http.request({ host: '127.0.0.1', port: 8077, path: p, method: method, headers: data ? { 'Content-Length': data.length, 'Content-Type': typeof data === 'string' ? 'application/json' : 'application/octet-stream' } : {} }, function (res) {
        var b = ''; res.on('data', function (d) { b += d; }); res.on('end', function () { var j = null; try { j = JSON.parse(b); } catch (e) {} cb(null, res.statusCode, j, b); });
    });
    req.on('error', function (e) { cb(e); });
    if (data) req.write(data);
    req.end();
}
function token() { return fs.readFileSync(path.join(dir, '.a2s-upload-token'), 'utf8').trim(); }
function installProbe(cb) {
    call('PUT', '/upload?name=Probe.wgt', wgt, function (e, code, j) {
        if (e || code !== 200 || !j || !j.ok) fail('upload: ' + code + ' ' + JSON.stringify(j));
        call('POST', '/install', JSON.stringify({ upload: j.upload.id, token: token(), installed: true }), function (e, code, j) {
            if (e || code !== 200 || !j) fail('install call: ' + code + ' ' + JSON.stringify(j));
            cb(j);
        });
    });
}

// sdbd with Host PC IP 127.0.0.1, taking one client at a time; Vetro's upstream is that one client.
fake.start(SDB, { bind: '0.0.0.0', hostPcIp: '127.0.0.1', single: true, shell: function () { return 'ok\n'; } }, function (h) {
    sdbd = h;
    holder = net.connect(SDB, '127.0.0.1', function () { holder.write(sdb.frame(sdb.CMD.CNXN, 0x01000000, 4096, Buf.from('host::'))); });
    holder.on('error', function (e) { fail('the holder lost sdbd: ' + e.message); });
    holder.once('data', function () {
        if (sdbd.live !== 1) fail('the holder must be sdbd\'s one client: live=' + sdbd.live);
        fake.start(TUN, { shell: function (cmd) { return cmd.indexOf('vd_appinstall') >= 0 ? INSTALLED : 'ok\n'; } }, function (t) {
            tunnel = t;
            child = cp.spawn(process.execPath, [path.join(__dirname, '..', 'tizen-app', 'service', 'index.js')], { env: { HOME: dir, TMPDIR: dir, TMP: dir, TEMP: dir, PATH: process.env.PATH, A2S_SDB_PORT: String(SDB), A2S_TUNNEL_PORT: String(TUN) }, stdio: ['ignore', 'ignore', 'pipe'] });
            child.stderr.on('data', function (d) { err += d; });
            var tries = 0;
            (function waitUp() {
                call('GET', '/ping', null, function (e, code) {
                    if (e || code !== 200) { if (++tries > 100 || child.exitCode !== null) fail('the service never answered /ping' + (err ? '\n' + err : '')); return setTimeout(waitUp, 100); }
                    run();
                });
            })();
        });
    });
});

function run() {
    call('POST', '/cert', JSON.stringify({ certificates: [CERT] }), function (e, code, j) {
        if (e || code !== 200 || !j.ok) fail('hand-over: ' + code + ' ' + JSON.stringify(j));
        // 1. Both direct addresses are dropped (loopback because sdbd is taken); the tunnel carries the install.
        installProbe(function (j) {
            if (!j.ok) fail('with sdbd held by another app, the install must go through its tunnel: ' + JSON.stringify(j));
            if (!sdbd.busyDrops) fail('the direct loopback attempt must have been dropped as a second client');
            var pushed = Object.keys(tunnel.received);
            if (pushed.length !== 1 || !/\/home\/owner\/share\/tmp\/sdk_tools\//.test(pushed[0])) fail('the package must have been pushed through the tunnel: ' + JSON.stringify(pushed));
            var drops = sdbd.drops;
            // 2. The tunnel is remembered: the second install goes there first, no new drop at sdbd.
            installProbe(function (j) {
                if (!j.ok) fail('second install: ' + JSON.stringify(j));
                if (sdbd.drops !== drops) fail('the remembered tunnel must be tried first (no new drop at sdbd): ' + drops + ' -> ' + sdbd.drops);
                deadTunnel();
            });
        });
    });
}

// 3. The tunnel is there but cannot reach sdbd either (it accepts and drops, as Vetro's does when its
//    own connection is refused). The answer stays HOST_PC_IP, from the direct attempts.
function deadTunnel() {
    tunnel.server.close(function () {
        dropper = net.createServer(function (s) { s.on('error', function () {}); s.once('data', function () { s.destroy(); }); });
        dropper.listen(TUN, '127.0.0.1', function () {
            installProbe(function (j) {
                if (j.ok || j.code !== 'HOST_PC_IP') fail('a tunnel that drops too must leave the advice at HOST_PC_IP: ' + JSON.stringify(j));
                stop();
                try { fs.readdirSync(dir).forEach(function (f) { fs.unlinkSync(path.join(dir, f)); }); fs.rmdirSync(dir); } catch (e) {}
                console.log('PASS: with sdbd held by another app, the install goes through its sdb tunnel on loopback (#90), the tunnel is tried first next time, and a tunnel that cannot get in either leaves the advice at HOST_PC_IP');
                process.exit(0);
            });
        });
    });
}
