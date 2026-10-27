/* The bundled service (scripts/bundle-service.js) starts and answers in each way a platform may load
 * it, from a working directory that is not the service folder:
 *   direct  - node <bundle>
 *   module  - require()d by a host that then calls the lifecycle hooks, as wrt-service does
 *   vm      - the Tizen 10 wrt-node wrapper found in libchromium-impl.so: the file read and run with
 *             vm.runInThisContext, require = createRequire(process.cwd()), no __dirname, no module
 * Each must answer /ping and /log.txt. The split sources under tizen-app/service/ fail the vm way
 * (top-level `var crypto` against Node 20's global, and ./x.js resolved from the cwd). */
'use strict';
var fs = require('fs'), os = require('os'), path = require('path'), http = require('http'), cp = require('child_process');

function fail(m) { console.error('FAIL: ' + m); process.exit(1); }
var root = path.join(os.tmpdir(), 'a2s-bundle-' + process.pid + '-' + Date.now());
var svcDir = path.join(root, 'A2STVStore', 'res', 'wgt', 'service'), cwd = path.join(root, 'elsewhere');
[root, path.join(root, 'A2STVStore'), path.join(root, 'A2STVStore', 'res'), path.join(root, 'A2STVStore', 'res', 'wgt'), svcDir, cwd].forEach(function (d) { try { fs.mkdirSync(d); } catch (e) {} });
var bundle = path.join(svcDir, 'index.js');
cp.execFileSync(process.execPath, [path.join(__dirname, '..', 'scripts', 'bundle-service.js'), bundle]);
var src = fs.readFileSync(bundle, 'utf8');

var hosts = {
    direct: null,
    module: "var s = require(process.argv[2]); if (typeof s.onStart !== 'function' || typeof s.onRequest !== 'function') { console.error('no lifecycle hooks'); process.exit(5); } s.onStart();",
    vm: "var fs = require('fs'); var script = fs.readFileSync(process.argv[2], 'utf8'); global.require = require('module').createRequire ? require('module').createRequire(process.cwd() + '/') : require; require('vm').runInThisContext(script);",
};
var names = Object.keys(hosts);
// Node 4 has no module.createRequire; the vm host falls back to its own require there, which
// still leaves the script without __dirname and module.

function get(p, cb) {
    var req = http.get({ host: '127.0.0.1', port: 8077, path: p }, function (res) { var b = ''; res.on('data', function (d) { b += d; }); res.on('end', function () { cb(null, res.statusCode, b); }); });
    req.on('error', function (e) { cb(e); });
}

(function next(i) {
    if (i === names.length) { try { cp.execSync('rm -rf ' + JSON.stringify(root)); } catch (e) {} console.log('PASS: the bundled service answers when run ' + names.join(', ')); process.exit(0); }
    var name = names[i], args;
    if (hosts[name]) { var h = path.join(root, 'host-' + name + '.js'); fs.writeFileSync(h, hosts[name]); args = [h, bundle]; } else args = [bundle];
    var child = cp.spawn(process.execPath, args, { cwd: cwd, stdio: ['ignore', 'ignore', 'pipe'] }), err = '';
    child.stderr.on('data', function (d) { err += d; });
    var tries = 0;
    (function poll() {
        get('/ping', function (e, code, body) {
            if (e || code !== 200) {
                if (++tries > 60 || child.exitCode !== null) { child.kill(); fail(name + ': no /ping (' + (e ? e.message : code) + ')' + (err ? '\n' + err : '')); }
                return setTimeout(poll, 100);
            }
            var ping = JSON.parse(body);
            if (!ping.ok || ping.service !== 'tv-store') fail(name + ': odd /ping ' + body);
            get('/log.txt', function (e2, code2, log) {
                if (e2 || code2 !== 200 || log.indexOf('TV-Store service on port 8077') < 0) fail(name + ': no log');
                child.on('exit', function () { console.log('  ' + name + ': ok (node ' + ping.node + ')'); next(i + 1); });
                child.kill();
            });
        });
    })();
})(0);
