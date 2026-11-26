/* The real page script (tizen-app/js/app.js) in a vm, with a stand-in for the DOM, the platform and
 * the service: for the tests that read what the page makes of a catalog. Not a test itself. */
'use strict';
var fs = require('fs'), path = require('path'), vm = require('vm');
var SRC = fs.readFileSync(path.join(__dirname, '..', 'tizen-app', 'js', 'app.js'), 'utf8');

function fail(m) { console.error('FAIL: ' + m); process.exit(1); }

// One page: opts { catalog, installed: { pkg: version }, storage: { key: object }, tvApps: [the TV's own list],
// icons: { pkg: the path of its icon on the TV },
// uninstall: function (body) -> the service's answer }.
function page(opts) {
    var store = {}, posts = [], asked = [], installs = [], uninstalls = [], acks = [], requests = [], intervals = [], onTv = opts.installed, reloads = { n: 0 };
    Object.keys(opts.storage || {}).forEach(function (k) { store[k] = JSON.stringify(opts.storage[k]); });
    // An element that takes whatever the page does to it.
    function el() {
        var e = { style: {}, className: '', innerHTML: '', textContent: '', value: '', children: [], scrollTop: 0, scrollLeft: 0, offsetWidth: 0, offsetHeight: 0 };
        ['removeEventListener', 'appendChild', 'removeChild', 'focus', 'blur', 'setAttribute', 'scrollIntoView'].forEach(function (n) { e[n] = function () {}; });
        e.on = {}; e.addEventListener = function (type, f) { e.on[type] = f; };
        e.getAttribute = function () { return null; };
        e.querySelector = function () { return null; };
        e.querySelectorAll = function () { return []; };
        e.getBoundingClientRect = function () { return { left: 0, top: 0, right: 0, bottom: 0, width: 0, height: 0 }; };
        return e;
    }
    var els = {}, doc = el(), listeners = {};
    doc.addEventListener = function (type, f) { listeners[type] = f; };
    doc.getElementById = function (id) { return els[id] || (els[id] = el()); };
    doc.createElement = el; doc.body = el(); doc.documentElement = el(); doc.activeElement = null;

    function answer(method, p, body) {
        asked.push(p);
        if (opts.answer) { var own = opts.answer(method, p, body); if (own) return own; }
        if (p === '/ping') return { ok: true, certReady: true, certificates: [{ name: 'PC', level: 'public' }], browser: { enabled: true }, sourceOf: {}, remembered: {}, userSettings: {} };
        if (p === '/catalog') return opts.catalogFails ? { ok: false, error: 'the catalog did not come' } : opts.catalog;
        if (p.indexOf('/sources/catalog') === 0) return { ok: true, sources: [] };
        if (p === '/pkgids') return { ok: true, ids: {}, removed: {} };
        if (p === '/uploads') return { ok: true, pending: null };
        if (p === '/store/state') { if (body.state) posts.push(body.state); var r = requests; requests = []; return { ok: true, requests: r }; }
        if (p === '/store/ack') { acks.push(body); return { ok: true }; }
        if (p === '/tvapps') return opts.tvApps ? { ok: true, apps: opts.tvApps } : { ok: false, error: 'no developer connection in this test' };
        if (p === '/uninstall') {
            uninstalls.push(body);
            var said = opts.uninstall ? opts.uninstall(body) : { ok: true, result: { id: body.id, gone: true } };
            if (said.ok) { Object.keys(onTv).forEach(function (pkg) { if (body.id === pkg || body.id.indexOf(pkg + '.') === 0) delete onTv[pkg]; }); if (opts.tvApps) opts.tvApps = opts.tvApps.filter(function (a) { return a.id !== body.id; }); }
            return said;
        }
        if (p === '/install') { installs.push(body); onTv[body.packageId] = '0.1.0'; return { ok: true, result: { packageId: body.packageId, appId: body.appId } }; }
        return { ok: true };
    }
    function XHR() { this.readyState = 0; this.status = 0; this.responseText = ''; }
    XHR.prototype.open = function (m, url) { this.m = m; this.p = url.replace(/^https?:\/\/[^\/]+/, ''); };
    XHR.prototype.setRequestHeader = function () {};
    XHR.prototype.send = function (body) {
        var r = this;
        setImmediate(function () {
            r.responseText = JSON.stringify(answer(r.m, r.p, body ? JSON.parse(body) : null));
            r.status = 200; r.readyState = 4;
            if (r.onreadystatechange) r.onreadystatechange();
        });
    };

    var win = {
        document: doc, XMLHttpRequest: XHR, console: { log: function () {}, error: function () {}, warn: function () {} },
        localStorage: { getItem: function (k) { return store.hasOwnProperty(k) ? store[k] : null; }, setItem: function (k, v) { store[k] = String(v); }, removeItem: function (k) { delete store[k]; } },
        location: { search: '', href: 'file:///index.html', reload: function () { reloads.n++; } }, navigator: { userAgent: 'test' },
        addEventListener: function () {}, removeEventListener: function () {},
        // The page's own clocks are run by hand: the 3 s tick through tick(), a timeout right away.
        setInterval: function (f) { intervals.push(f); return intervals.length; }, clearInterval: function () {},
        setTimeout: function (f) { return setTimeout(f, 0); }, clearTimeout: clearTimeout,
        Math: Math, Date: Date, JSON: JSON, parseInt: parseInt, Object: Object, Array: Array, String: String, Error: Error, RegExp: RegExp, isNaN: isNaN,
        tizen: {
            application: {
                getCurrentApplication: function () { return { appInfo: { id: 'A2STVStore.Store', packageId: 'A2STVStore', version: '0.0.0' }, getRequestedAppControl: function () { return null; } }; },
                getAppsInfo: function (ok) { ok(Object.keys(onTv).map(function (p) { return { packageId: p, id: p + '.App', version: onTv[p], name: p, iconPath: (opts.icons || {})[p] }; })); },
                launch: function (id, ok) { if (ok) ok(); }, launchAppControl: function (c, id, ok) { if (ok) ok(); }
            },
            ApplicationControl: function () {},
            systeminfo: { getCapability: function () { return '6.5'; }, getPropertyValue: function () {} },
            filesystem: { resolve: function (n, ok) { ok({ resolve: function () { return { readAsText: function (got) { got('token'); } }; } }); } },
            tvinputdevice: { registerKey: function () {}, registerKeyBatch: function () {} }
        }
    };
    win.window = win; win.self = win;
    vm.runInNewContext(SRC, win, { filename: 'app.js' });

    var api = {
        // Lets the page's requests and timeouts run out, then calls back.
        settle: function (cb) { var n = 0; (function turn() { if (++n > 40) return cb(); setTimeout(turn, 1); })(); },
        tick: function (cb) { intervals.forEach(function (f) { f(); }); api.settle(cb); },
        // The tick without waiting for what it started: for a press while a request is still out.
        tickNow: function () { intervals.forEach(function (f) { f(); }); },
        // The picture the page last posted, one app of it by key.
        app: function (key) {
            if (!posts.length) fail('the page posted no picture of the store');
            var list = posts[posts.length - 1].apps.filter(function (a) { return a.key === key; });
            if (list.length !== 1) fail('no app ' + key + ' in the picture');
            return list[0];
        },
        ask: function (r) { requests.push(r); },
        // A press on a focusable element with this id or these data- attributes.
        press: function (id, attrs) {
            var t = el(); t.id = id || ''; t.classList = { contains: function (c) { return c === 'f'; } };
            t.getAttribute = function (k) { return attrs && attrs.hasOwnProperty(k) ? attrs[k] : null; };
            listeners.click({ target: t });
        },
        // What the remote's keyboard does to the search box, and one key of the remote.
        type: function (text) { var s = doc.getElementById('search'); s.value = text; if (s.on.input) s.on.input(); },
        key: function (code) { listeners.keydown({ keyCode: code, preventDefault: function () {} }); },
        html: function (id) { return els[id] ? els[id].innerHTML : ''; },
        stored: function (k) { return store.hasOwnProperty(k) ? JSON.parse(store[k]) : null; },
        installs: installs, uninstalls: uninstalls, acks: acks, reloads: reloads, window: win,
        // Every path the page asked the service for, and the document, to say what has the focus.
        asked: asked, posts: function () { return posts; }, doc: doc, el: function (id) { return doc.getElementById(id); }
    };
    return api;
}

module.exports = { page: page, fail: fail };
