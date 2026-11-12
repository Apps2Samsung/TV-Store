/* The store in a phone or PC browser (#101), against the real service as a child: the page at / with a
 * script that parses; GET /store/state before the TV-Store screen sent anything; Install refused while
 * the screen is not open; the screen's send needs the page token; Install then checked against what
 * the screen showed (unknown app, an app that cannot be installed from a browser with why, a duplicate
 * gets the same request), refused from another web site (Origin) and by a public host name (DNS
 * rebinding); the request reaches the screen in the answer to its next send, the screen's ack shows on
 * the page; Update all; the switch in Settings turns it off, saved, and fails what was waiting. */
'use strict';
var fs = require('fs'), os = require('os'), path = require('path'), http = require('http'), cp = require('child_process'), vm = require('vm');

var dir = path.join(os.tmpdir(), 'a2s-browser-' + process.pid + '-' + Date.now()); fs.mkdirSync(dir);
var child = null, err = '';
var WD = setTimeout(function () { fail('watchdog (30 s)' + (err ? '\n' + err : '')); }, 30000);
function fail(m) { stop(); console.error('FAIL: ' + m); process.exit(1); }
function stop() { clearTimeout(WD); if (child) child.kill(); }

// No sdbd here (port 1): nothing in this test installs, and the relay's start-up check finds nothing.
child = cp.spawn(process.execPath, [path.join(__dirname, '..', 'tizen-app', 'service', 'index.js')], { env: { HOME: dir, TMPDIR: dir, TMP: dir, TEMP: dir, PATH: process.env.PATH, A2S_SDB_PORT: '1' }, stdio: ['ignore', 'ignore', 'pipe'] });
child.stderr.on('data', function (d) { err += d; });

function call(method, p, data, headers, cb) {
    if (typeof headers === 'function') { cb = headers; headers = {}; }
    var h = {}; for (var k in headers) h[k] = headers[k];
    if (data) { h['Content-Length'] = Buffer.byteLength(data); h['Content-Type'] = 'application/json'; }
    var req = http.request({ host: '127.0.0.1', port: 8077, path: p, method: method, headers: h }, function (res) {
        var b = ''; res.on('data', function (d) { b += d; }); res.on('end', function () { var j = null; try { j = JSON.parse(b); } catch (e) {} cb(null, res.statusCode, j, b, res.headers); });
    });
    req.on('error', function (e) { cb(e); });
    if (data) req.write(data);
    req.end();
}
function post(p, obj, headers, cb) { call('POST', p, JSON.stringify(obj), headers, cb); }
var tries = 0;
(function waitUp() {
    call('GET', '/ping', null, function (e, code, j) {
        if (e || code !== 200) { if (++tries > 100 || child.exitCode !== null) fail('the service never answered /ping' + (err ? '\n' + err : '')); return setTimeout(waitUp, 100); }
        if (!j.browser || j.browser.enabled !== true) fail('/ping must say installing from a browser is on by default: ' + JSON.stringify(j.browser));
        page();
    });
})();

var TOKEN = null;
var STATE = {
    tv: { model: 'UE55RU7020', tizen: '5.0', version: 'test', armed: true, free: 2147483648, certs: [{ name: 'PC', level: 'Public' }] },
    categories: [{ id: 'media', name: 'Media', color: '#2B59FF' }],
    apps: [
        { key: 'c:Jellyfin', name: 'Jellyfin', cat: 'media', installed: null, update: false, latest: '1.0', can: true, why: '' },
        { key: 'c:Needs', name: 'NeedsPC', cat: 'media', installed: null, update: false, latest: '2.0', can: false, why: 'Needs Apps2Samsung on a phone or PC: this build asks for settings before it installs.' },
        { key: 'c:Old', name: 'OldApp', cat: 'media', installed: '1.0', update: true, latest: '1.1', can: true, why: '' }
    ],
    job: null, queue: []
};

function page() {
    call('GET', '/', null, function (e, code, j, html, hdr) {
        if (e || code !== 200 || !/text\/html/.test(hdr['content-type']) || !/<title>TV-Store<\/title>/.test(html)) fail('GET / must serve the store page: ' + code);
        if (hdr['access-control-allow-origin']) fail('the store page must not be open to other sites (CORS)');
        var m = /<script>([\s\S]*)<\/script>/.exec(html);
        if (!m) fail('the store page has no script');
        try { new vm.Script(m[1]); } catch (x) { fail('the store page\'s script does not parse: ' + x.message); }
        if (/https?:\/\/(?!\d)/.test(html.replace(/http:\/\/\d+\.\d+\.\d+\.\d+/g, ''))) fail('the store page must load nothing from outside the LAN');
        call('GET', '/store/state', null, function (e, code, j) {
            if (code !== 200 || !j || !j.ok || j.enabled !== true || j.live !== false || j.state !== null) fail('state before the screen sent anything: ' + JSON.stringify(j));
            post('/store/install', { key: 'c:Jellyfin' }, {}, function (e, code, j) {
                if (code !== 409 || !j || j.ok || !/not open on the TV/.test(j.error)) fail('Install with the screen not open must say so: ' + code + ' ' + JSON.stringify(j));
                TOKEN = fs.readFileSync(path.join(dir, '.a2s-upload-token'), 'utf8').trim();
                screenSends();
            });
        });
    });
}

function screenSends() {
    post('/store/state', { token: 'nope', state: STATE }, {}, function (e, code) {
        if (code !== 403) fail('the screen\'s send without the token must be refused: ' + code);
        post('/store/state', { token: TOKEN, state: STATE }, {}, function (e, code, j) {
            if (code !== 200 || !j.ok || j.want || j.requests.length) fail('the screen\'s send: ' + code + ' ' + JSON.stringify(j));
            call('GET', '/store/state', null, function (e, code, j) {
                if (!j.live || !j.state || j.state.apps.length !== 3 || j.state.tv.model !== 'UE55RU7020') fail('the page must get what the screen sent: ' + JSON.stringify(j));
                asks();
            });
        });
    });
}

var reqId = null;
function asks() {
    post('/store/install', { key: 'c:Nope' }, {}, function (e, code, j) {
        if (code !== 404) fail('an unknown app must be refused with 404: ' + code + ' ' + JSON.stringify(j));
        post('/store/install', { key: 'c:Needs' }, {}, function (e, code, j) {
            if (code !== 409 || !/phone or PC/.test(j.error)) fail('an app that cannot be installed from a browser must say why: ' + code + ' ' + JSON.stringify(j));
            post('/store/install', { key: 'c:Jellyfin' }, { Origin: 'https://evil.example' }, function (e, code) {
                if (code !== 403) fail('a request from another web site must be refused: ' + code);
                post('/store/install', { key: 'c:Jellyfin' }, { Host: 'tv.evil.example:8077' }, function (e, code) {
                    if (code !== 403) fail('a public host name (DNS rebinding) must be refused: ' + code);
                    post('/store/install', { key: 'c:Jellyfin' }, { Origin: 'http://127.0.0.1:8077' }, function (e, code, j) {
                        if (code !== 200 || !j.ok || !j.request || j.request.status !== 'waiting') fail('Install from the page: ' + code + ' ' + JSON.stringify(j));
                        reqId = j.request.id;
                        post('/store/install', { key: 'c:Jellyfin' }, {}, function (e, code, j) {
                            if (code !== 200 || j.request.id !== reqId) fail('a second Install of the same app must get the same request: ' + JSON.stringify(j));
                            screenTakes();
                        });
                    });
                });
            });
        });
    });
}

function screenTakes() {
    post('/store/state', { token: TOKEN }, {}, function (e, code, j) {
        if (code !== 200 || j.requests.length !== 1 || j.requests[0].id !== reqId || j.requests[0].key !== 'c:Jellyfin') fail('the request must reach the screen with its next send: ' + JSON.stringify(j));
        post('/store/ack', { token: TOKEN, id: reqId, status: 'bogus' }, {}, function (e, code) {
            if (code !== 400) fail('an ack with a status that is not taken, done or failed must be refused: ' + code);
            post('/store/ack', { token: TOKEN, id: reqId, status: 'taken' }, {}, function (e, code) {
                if (code !== 200) fail('ack taken: ' + code);
                post('/store/state', { token: TOKEN }, {}, function (e, code, j) {
                    if (j.requests.length) fail('a taken request must not be handed out again: ' + JSON.stringify(j));
                    post('/store/ack', { token: TOKEN, id: reqId, status: 'done' }, {}, function () {
                        call('GET', '/store/state', null, function (e, code, j) {
                            var r = j.requests.filter(function (x) { return x.id === reqId; })[0];
                            if (!r || r.status !== 'done') fail('the page must see the request done: ' + JSON.stringify(j.requests));
                            updateAll();
                        });
                    });
                });
            });
        });
    });
}

function updateAll() {
    post('/store/install', { all: true }, {}, function (e, code, j) {
        if (code !== 200 || !j.request.all || j.request.name !== '1 update') fail('Update all: ' + code + ' ' + JSON.stringify(j));
        var allId = j.request.id;
        post('/settings', { browser: { enabled: 'yes' } }, {}, function (e, code) {
            if (code !== 400) fail('a browser setting that is not true or false must be refused: ' + code);
            post('/settings', { browser: { enabled: false } }, {}, function (e, code, j) {
                if (code !== 200 || !j.browser || j.browser.enabled !== false) fail('turning it off: ' + code + ' ' + JSON.stringify(j));
                var saved = JSON.parse(fs.readFileSync(path.join(dir, '.a2s-browser.json'), 'utf8'));
                if (saved.enabled !== false) fail('the switch must be saved: ' + JSON.stringify(saved));
                post('/store/install', { key: 'c:Old' }, {}, function (e, code, j) {
                    if (code !== 403 || !/off/.test(j.error)) fail('Install with the switch off must be refused: ' + code + ' ' + JSON.stringify(j));
                    call('GET', '/store/state', null, function (e, code, j) {
                        var r = j.requests.filter(function (x) { return x.id === allId; })[0];
                        if (j.enabled !== false || !r || r.status !== 'failed') fail('turning it off must fail what was waiting: ' + JSON.stringify(j.requests));
                        post('/store/state', { token: TOKEN }, {}, function (e, code, j) {
                            if (j.requests.length) fail('nothing goes to the screen with the switch off');
                            stop();
                            console.log('PASS');
                            console.log('  the page at / (no CORS, nothing from outside, its script parses); state before the screen sent anything');
                            console.log('  Install refused while TV-Store is not open; the screen\'s send needs the page token');
                            console.log('  unknown app 404, an app that needs a phone or PC says why, another site and a public host name refused, a duplicate gets the same request');
                            console.log('  the request reaches the screen once, its ack shows on the page; Update all');
                            console.log('  the switch in Settings: on by default, saved off, refuses Install and fails what was waiting');
                            process.exit(0);
                        });
                    });
                });
            });
        });
    });
}
