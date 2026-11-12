/* An app's settings end to end, against the real service: a local HTTPS server stands in for
 * apps2samsung.com and the download host, a fake sdbd for the installer. The signed catalog has
 * Baobab (two required settings in js/config.js) and Keys (one optional API key). Baobab without its
 * settings is refused with NEEDS_SETTINGS; the store page gets the form (fields, no find / replace)
 * and asks without settings (NEEDS_SETTINGS), with bad ones (400 and why per field), then with good
 * ones, which are kept on the TV (0600, keys only on /ping and the page, never the values); the
 * install then writes them into the package the TV gets, and an update writes them again; an app
 * already on the TV and current may be asked for again with new settings; Keys on the TV with no
 * settings here is not updated (SETTINGS_ELSEWHERE), and Keys not on the TV installs as published. */
'use strict';
var fs = require('fs'), os = require('os'), path = require('path'), http = require('http'), https = require('https'), cp = require('child_process'), crypto = require('crypto');
var zip = require('../tizen-app/service/zip.js');
var Buf = require('../tizen-app/service/compat.js');
var fake = require('./fake-sdbd.js');

var SDB = 26183, WEB = 26184, F = path.join(__dirname, 'fixtures'), R = path.join(F, 'repositories');
var child = null, err = '', handle = null, web = null, shells = [];
var WD = setTimeout(function () { fail('watchdog (60 s)' + (err ? '\n' + err : '')); }, 60000);
function stop() { clearTimeout(WD); if (child) child.kill(); if (handle) try { handle.server.close(); } catch (e) {} if (web) try { web.close(); } catch (e) {} }
function fail(m) { stop(); console.error('FAIL: ' + m); process.exit(1); }
function pem(f) { return fs.readFileSync(path.join(F, f), 'utf8'); }
var KEY = fs.readFileSync(path.join(R, 'keys', 'test.key.pem'), 'utf8');
var CERT = { name: 'PC - Public', authorKeyPem: pem('author.key'), authorCertPem: pem('author.crt'), distributorKeyPem: pem('public-distributor.key'), distributorCertPem: pem('public-distributor.crt') };
var dir = path.join(os.tmpdir(), 'a2s-settings-' + process.pid + '-' + Date.now()); fs.mkdirSync(dir);

function wgt(pkg, name, extra) {
    return zip.write([{ name: 'index.html', data: Buf.from('<html></html>') },
        { name: 'config.xml', data: Buf.from('<widget xmlns="http://www.w3.org/ns/widgets" xmlns:tizen="http://tizen.org/ns/widgets" version="1.0.0"><name>' + name + '</name><tizen:application id="' + pkg + '.App" package="' + pkg + '" required_version="3.0"/></widget>') }].concat(extra));
}
var FILES = {
    '/c/Baobab.wgt': wgt('BaobabPk01', 'Baobab', [{ name: 'js/config.js', data: Buf.from("window.CFG = {\n  API_BASE_URL: '',\n  SCREEN_KEY: '',\n};\n") }]),
    '/c/Keys.wgt': wgt('KeysPkg001', 'Keys', [{ name: 'js/keys.local.js', data: Buf.from('window.KEYS = { tmdb: "", };') }])
};
var BAOBAB = { help_url: 'https://github.com/Gonqas/baobab#readme', file: 'js/config.js', fields: [
    { key: 'api_base_url', label: 'Baobab server URL', type: 'text', required: true, pattern: '^https?://[^\\s\'\\"\\\\]+$', find: "API_BASE_URL: '',", replace: "API_BASE_URL: '{value}',", isNumber: false },
    { key: 'screen_key', label: 'Screen key', type: 'text', required: true, pattern: '^[A-Za-z0-9._-]+$', find: "SCREEN_KEY: '',", replace: "SCREEN_KEY: '{value}',", isNumber: false }] };
var KEYS = { file: 'js/keys.local.js', fields: [{ key: 'tmdb', label: 'TMDB API key', type: 'text', required: false, pattern: '^[A-Za-z0-9]+$', find: 'tmdb: "",', replace: 'tmdb: "{value}",' }] };
function sha(b) { return crypto.createHash('sha256').update(b).digest('hex'); }
function asset(p, name) { return { name: name, browser_download_url: 'https://dl.test' + p, size: FILES[p].length, digest: 'sha256:' + sha(FILES[p]) }; }
function official() {
    var json = JSON.stringify({ schemaVersion: 1, generatedAt: new Date(Date.now() - 60000).toISOString(), providers: [
        { id: 'tizen-community', ok: true, url: 'https://api.github.test/repos/Apps2Samsung/tizen-community-packages/releases',
          catalog: { apps: [{ file: 'Baobab.wgt', name: 'Baobab', repo: 'g/baobab', user_settings: BAOBAB }, { file: 'Keys.wgt', name: 'Keys', repo: 'k/keys', user_settings: KEYS }] },
          releases: [{ assets: [asset('/c/Baobab.wgt', 'Baobab.wgt'), asset('/c/Keys.wgt', 'Keys.wgt')] }] }
    ] }, null, 2) + '\n';
    return Buf.from(crypto.createSign('RSA-SHA256').update(Buf.from(json, 'utf8')).sign(KEY, 'base64') + '\n' + json, 'utf8');
}
function route(host, p) {
    if (host === 'official.test' && p === '/resolved.json.signed') return official();
    if (host === 'dl.test' && FILES[p]) return FILES[p];
    return null;
}

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
function install(file, installed, cb) {
    var before = shells.length;
    call('POST', '/install', { url: 'https://dl.test' + file, file: path.basename(file), name: path.basename(file, '.wgt'), tizen: '6.0', source: 'official', installed: installed, tvApps: {} }, function (e, code, j) {
        if (e || !j) fail('install: ' + (e && e.message));
        var cmds = shells.slice(before).filter(function (c) { return c.indexOf('vd_appinstall') >= 0; }), pushed = {};
        var m = cmds.length ? /(\S+)$/.exec(cmds[cmds.length - 1]) : null;
        if (m && handle.received[m[1]]) zip.readEntries(handle.received[m[1]]).forEach(function (x) { pushed[x.name] = x.data.toString('utf8'); });
        cb(j, cmds, pushed);
    });
}
function token() { return fs.readFileSync(path.join(dir, '.a2s-upload-token'), 'utf8').trim(); }
var BAO = { key: 'c:Baobab', url: 'https://dl.test/c/Baobab.wgt', file: 'Baobab.wgt', name: 'Baobab', cat: 'other', installed: null, update: false, latest: '1.0.0', can: true, why: '' };
function screen(apps, cb) { call('POST', '/store/state', { token: token(), state: { tv: { armed: true }, categories: [], apps: apps, job: null, queue: [] } }, function (e, c, j) { if (c !== 200) fail('screen send: ' + c); cb(j); }); }
function ask(body, cb) { call('POST', '/store/install', body, function (e, c, j, raw) { cb(c, j, raw); }); }

var steps = [], said = [];
function step(what, fn) { steps.push({ what: what, fn: fn }); }
function next() { var s = steps.shift(); if (!s) return done(); said.push(s.what); s.fn(next); }

step('Baobab without its settings: NEEDS_SETTINGS, nothing pushed', function (go) {
    call('POST', '/cert', { certificates: [CERT] }, function () {
        install('/c/Baobab.wgt', false, function (j, cmds) {
            if (j.ok || j.code !== 'NEEDS_SETTINGS' || cmds.length || j.error.indexOf('Baobab server URL; Screen key') < 0) fail('NEEDS_SETTINGS: ' + JSON.stringify(j));
            go();
        });
    });
});
step('the store page gets the form: fields, no find / replace, nothing saved yet', function (go) {
    call('GET', '/catalog', null, function () {
        screen([BAO], function () {
            call('GET', '/store/state', null, function (e, c, j, raw) {
                var a = j.state.apps[0];
                if (!a.settings || a.settings.fields.length !== 2 || a.settings.help !== 'https://github.com/Gonqas/baobab#readme' || a.saved.length || a.settingsSet) fail('the form: ' + JSON.stringify(a));
                if (raw.indexOf('API_BASE_URL') >= 0) fail('the page must not get find / replace');
                go();
            });
        });
    });
});
step('Install without settings, with bad ones, then good ones: kept on the TV, keys only out', function (go) {
    ask({ key: 'c:Baobab' }, function (c, j) {
        if (c !== 409 || j.code !== 'NEEDS_SETTINGS') fail('no settings: ' + c + ' ' + JSON.stringify(j));
        ask({ key: 'c:Baobab', settings: { api_base_url: 'ftp://x', screen_key: '' } }, function (c, j) {
            if (c !== 400 || !j.fields || !j.fields.api_base_url || !j.fields.screen_key) fail('bad settings: ' + c + ' ' + JSON.stringify(j));
            ask({ key: 'c:Baobab', settings: { api_base_url: 'http://srv.lan:4000', screen_key: 'hall-1' } }, function (c, j) {
                if (c !== 200 || !j.ok) fail('good settings: ' + c + ' ' + JSON.stringify(j));
                var f = path.join(dir, '.a2s-user-settings.json'), st = fs.statSync(f);
                if (process.platform !== 'win32' && (st.mode & 511) !== 384) fail('the settings file must be 0600: ' + (st.mode & 511).toString(8));
                if (JSON.parse(fs.readFileSync(f, 'utf8'))['Baobab.wgt'].values.api_base_url !== 'http://srv.lan:4000') fail('kept on the TV');
                call('GET', '/ping', null, function (e, c, p, praw) {
                    if (JSON.stringify(p.userSettings) !== JSON.stringify({ 'Baobab.wgt': ['api_base_url', 'screen_key'] }) || praw.indexOf('srv.lan') >= 0) fail('/ping: keys only: ' + JSON.stringify(p.userSettings));
                    call('GET', '/store/state', null, function (e, c, s, sraw) {
                        if (sraw.indexOf('srv.lan') >= 0 || sraw.indexOf('hall-1') >= 0 || s.state.apps[0].saved.length !== 2 || !s.state.apps[0].settingsSet) fail('the page: keys only: ' + sraw.slice(0, 400));
                        go();
                    });
                });
            });
        });
    });
});
step('the install writes them into the package the TV gets; an update writes them again', function (go) {
    install('/c/Baobab.wgt', false, function (j, cmds, pushed) {
        if (!j.ok || cmds.length !== 1) fail('install with settings: ' + JSON.stringify(j));
        if (pushed['js/config.js'] !== "window.CFG = {\n  API_BASE_URL: 'http://srv.lan:4000',\n  SCREEN_KEY: 'hall-1',\n};\n") fail('the pushed config: ' + pushed['js/config.js']);
        if (!pushed['author-signature.xml']) fail('signed after the settings went in');
        install('/c/Baobab.wgt', true, function (j, cmds, pushed) {
            if (!j.ok || pushed['js/config.js'].indexOf('srv.lan:4000') < 0) fail('the update keeps them: ' + JSON.stringify(j));
            go();
        });
    });
});
step('an app on the TV and current may be asked for again with new settings', function (go) {
    var cur = {}; for (var k in BAO) cur[k] = BAO[k];
    cur.installed = '1.0.0'; cur.can = false;
    screen([cur], function () {
        ask({ key: 'c:Baobab' }, function (c) {
            if (c !== 409) fail('without new settings, a current app is not installed again: ' + c);
            ask({ key: 'c:Baobab', settings: { screen_key: 'hall-2' } }, function (c, j) {
                if (c !== 200 || !j.request.again) fail('again with new settings: ' + c + ' ' + JSON.stringify(j));
                screen([cur], function (s) {
                    if (!s.requests.length || !s.requests[0].again) fail('the screen sees again: ' + JSON.stringify(s));
                    install('/c/Baobab.wgt', true, function (j, cmds, pushed) {
                        if (!j.ok || pushed['js/config.js'].indexOf("SCREEN_KEY: 'hall-2'") < 0 || pushed['js/config.js'].indexOf('srv.lan:4000') < 0) fail('the new key, the old URL: ' + pushed['js/config.js']);
                        go();
                    });
                });
            });
        });
    });
});
step('Keys on the TV, settings not here: SETTINGS_ELSEWHERE; not on the TV: installs as published', function (go) {
    install('/c/Keys.wgt', true, function (j, cmds) {
        if (j.ok || j.code !== 'SETTINGS_ELSEWHERE' || cmds.length) fail('SETTINGS_ELSEWHERE: ' + JSON.stringify(j));
        install('/c/Keys.wgt', false, function (j, cmds, pushed) {
            if (!j.ok || pushed['js/keys.local.js'] !== 'window.KEYS = { tmdb: "", };') fail('as published: ' + JSON.stringify(j) + ' ' + pushed['js/keys.local.js']);
            go();
        });
    });
});

function done() {
    call('GET', '/logs', null, function (e, c, j) {
        var text = (j && j.logs || []).join('\n');
        if (text.indexOf('srv.lan') >= 0 || text.indexOf('hall-1') >= 0) fail('values must never be logged:\n' + text);
        if (text.indexOf('wrote the settings api_base_url, screen_key into js/config.js') < 0) fail('the log says which keys went where:\n' + text);
        stop();
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
