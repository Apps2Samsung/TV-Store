/* Jellyfin builds compared on the catalog's web_version (#124), against the real page script: app.js
 * runs in a vm with a stand-in for the DOM, the platform and the service. What the page makes of
 * the catalog is read from the picture it posts for the store in a browser (POST /store/state), and
 * Update all is asked for the way a browser asks, so the test goes through state(), Update all and
 * the install's bookkeeping; the On the TV page and an app's sheet are drawn too, and read for what
 * they say about the version.
 *
 * Every Jellyfin build declares 0.1.0. With a web_version in the catalog: a build TV-Store installed
 * (written down in localStorage) gets an update when the catalog's is higher and joins Update all;
 * one it did not install reads as not known and gets none; the app whose build was written down is
 * the one that claims the shared package id; a record leaves with its package. Without web_version
 * everything is as before. */
'use strict';
var harness = require('./page-harness.js'), page = harness.page, fail = harness.fail;
var WEB_KEY = 'a2s.tvstore.webversions', VARIANTS_KEY = 'a2s.tvstore.variants';
var JF = 'AprZAARz4r';

function eq(a, b, what) { if (JSON.stringify(a) !== JSON.stringify(b)) fail(what + ': expected ' + JSON.stringify(b) + ', got ' + JSON.stringify(a)); }

function asset(name, pkg, version, web) {
    var a = { name: name, browser_download_url: 'https://dl.test/' + name, digest: 'sha256:' + new Array(65).join('a'), package_id: pkg, app_id: pkg + '.App', package_version: version };
    if (web) a.web_version = web;
    return a;
}
// web: whether the snapshot has run with web versions yet.
function catalog(web, latest) {
    function w(v) { return web ? v : undefined; }
    return { schemaVersion: 1, providers: [
        { id: 'jellyfin-tizen-builds', ok: true, url: 'https://api.github.com/repos/jeppevinkel/jellyfin-tizen-builds/releases',
          releases: [{ assets: [asset('Jellyfin.wgt', JF, '0.1.0', w(latest || '12.5.0')), asset('Jellyfin-10.11.z.wgt', JF, '0.1.0', w('10.11.11')), asset('Jellyfin-master.wgt', JF, '0.1.0', w('13.0.0'))] }] },
        { id: 'jellyfin-legacy', ok: true, url: 'https://api.github.com/repos/someone/jellyfin-legacy/releases',
          releases: [{ assets: [asset('Jellyfin-10.10.z.wgt', JF, '0.1.0', w('10.10.0')), asset('Jellyfin-10.8.z.wgt', JF, '0.1.0')] }] },
        { id: 'moonfin', ok: true, url: 'https://api.github.com/repos/moon/moonfin/releases', releases: [{ assets: [asset('Moonfin.wgt', 'MoonPkg001', '1.1.0')] }] }
    ] };
}

function has(html, text, what) { if (html.indexOf(text) < 0) fail(what + ': "' + text + '" is not on it'); }
function hasNot(html, text, what) { if (html.indexOf(text) >= 0) fail(what + ': "' + text + '" is on it'); }
function ready(opts, then) { var p = page(opts); p.settle(function () { p.tick(function () { then(p); }); }); }

var J = 'p:jellyfin-tizen-builds', L = 'p:jellyfin-legacy', M = 'p:moonfin';
var tests = [];
function test(name, fn) { tests.push([name, fn]); }

test('not installed: the card shows the web version', function (done) {
    ready({ catalog: catalog(true), installed: { A2STVStore: '0.0.0' } }, function (p) {
        var a = p.app(J);
        eq([a.installed, a.update, a.latest, a.unknown], [null, false, '12.5.0', false], 'Jellyfin, not on the TV');
        eq(p.app(M).latest, '1.1.0', 'an app without a web_version keeps its version');
        done();
    });
});

test('on the TV, not installed by TV-Store: not known, no update, not in Update all', function (done) {
    var onTv = { A2STVStore: '0.0.0' }; onTv[JF] = '0.1.0';
    ready({ catalog: catalog(true), installed: onTv }, function (p) {
        var a = p.app(J);
        eq([a.installed, a.update, a.latest, a.unknown, a.can], ['', false, '12.5.0', true, false], 'Jellyfin from a phone or PC');
        eq(p.app(L).installed, null, 'the legacy app does not claim the package');
        p.press('tabTv');
        has(p.html('page'), 'Version not known · v12.5.0 in the catalog', 'the On the TV page');
        has(p.html('page'), '<span class="k">Installed</span><span class="v">Not known</span>', 'the On the TV page');
        hasNot(p.html('page'), 'data-act="updall"', 'the On the TV page');
        hasNot(p.html('page'), 'data-act="tvupd"', 'the On the TV page');
        p.press('', { 'data-app': J });
        has(p.html('sheet'), 'Installed · version not known', 'the sheet');
        has(p.html('sheet'), 'v12.5.0 in the catalog', 'the sheet');
        has(p.html('sheet'), 'TV-Store did not install this copy', 'the sheet');
        hasNot(p.html('sheet'), 'Update to', 'the sheet');
        p.press('', { 'data-act': 'close' });
        p.ask({ id: 'r1', all: true, from: 'a phone' });
        p.tick(function () {
            eq(p.installs.length, 0, 'installs started by Update all');
            eq(p.acks.filter(function (k) { return k.id === 'r1'; }).map(function (k) { return k.status; }), ['failed'], 'the answer to Update all');
            done();
        });
    });
});

test('installed by TV-Store: an update when the catalog is higher, and Update all takes it', function (done) {
    var onTv = { A2STVStore: '0.0.0', MoonPkg001: '1.1.0' }, st = {}; onTv[JF] = '0.1.0';
    st[WEB_KEY] = {}; st[WEB_KEY][JF] = { key: J, file: 'Jellyfin.wgt', web: '12.4.0' };
    st[VARIANTS_KEY] = {}; st[VARIANTS_KEY][JF] = 'Jellyfin.wgt';
    ready({ catalog: catalog(true), installed: onTv, storage: st }, function (p) {
        var a = p.app(J);
        eq([a.installed, a.update, a.latest, a.unknown, a.can], ['12.4.0', true, '12.5.0', false, true], 'Jellyfin 12.4.0 with 12.5.0 in the catalog');
        eq(p.app(M).update, false, 'Moonfin is current');
        p.press('tabTv');
        has(p.html('page'), 'v12.4.0 installed · v12.5.0 in the catalog', 'the On the TV page');
        has(p.html('page'), 'data-act="updall"', 'the On the TV page');
        hasNot(p.html('page'), '0.1.0', 'the On the TV page');
        p.press('', { 'data-app': J });
        has(p.html('sheet'), 'Installed · v12.4.0', 'the sheet');
        has(p.html('sheet'), 'Update to v12.5.0', 'the sheet');
        hasNot(p.html('sheet'), '0.1.0', 'the sheet');
        p.press('', { 'data-act': 'close' });
        p.ask({ id: 'r2', all: true, from: 'a phone' });
        p.tick(function () {
            eq(p.installs.map(function (i) { return i.file; }), ['Jellyfin.wgt'], 'what Update all installed');
            eq(p.stored(WEB_KEY)[JF], { key: J, file: 'Jellyfin.wgt', web: '12.5.0' }, 'written down after the update');
            p.tick(function () {
                var b = p.app(J);
                eq([b.installed, b.update, b.unknown], ['12.5.0', false, false], 'Jellyfin after the update');
                done();
            });
        });
    });
});

test('the same version, and a build that stays behind its branch: no update', function (done) {
    var onTv = { A2STVStore: '0.0.0' }, st = {}; onTv[JF] = '0.1.0';
    st[WEB_KEY] = {}; st[WEB_KEY][JF] = { key: J, file: 'Jellyfin-master.wgt', web: '13.0.0' };
    st[VARIANTS_KEY] = {}; st[VARIANTS_KEY][JF] = 'Jellyfin-master.wgt';
    ready({ catalog: catalog(true), installed: onTv, storage: st }, function (p) {
        var a = p.app(J);
        eq([a.installed, a.update, a.latest, a.variant], ['13.0.0', false, '13.0.0', 'Jellyfin-master'], 'Jellyfin-master');
        done();
    });
});

test('the app whose build was written down claims the shared package id', function (done) {
    var onTv = { A2STVStore: '0.0.0' }, st = {}; onTv[JF] = '0.1.0';
    st[WEB_KEY] = {}; st[WEB_KEY][JF] = { key: L, file: 'Jellyfin-10.10.z.wgt', web: '10.9.11' };
    st[VARIANTS_KEY] = {}; st[VARIANTS_KEY][JF] = 'Jellyfin-10.10.z.wgt';
    ready({ catalog: catalog(true), installed: onTv, storage: st }, function (p) {
        eq(p.app(J).installed, null, 'Jellyfin is not the one on the TV');
        var a = p.app(L);
        eq([a.installed, a.update, a.latest], ['10.9.11', true, '10.10.0'], 'the legacy build');
        done();
    });
});

test('an install from here writes the version down', function (done) {
    ready({ catalog: catalog(true), installed: { A2STVStore: '0.0.0' } }, function (p) {
        p.ask({ id: 'r3', key: J, from: 'a phone' });
        p.tick(function () {
            eq(p.installs.map(function (i) { return i.file; }), ['Jellyfin.wgt'], 'what was installed');
            eq(p.stored(WEB_KEY)[JF], { key: J, file: 'Jellyfin.wgt', web: '12.5.0' }, 'written down');
            p.tick(function () {
                eq([p.app(J).installed, p.app(J).unknown], ['12.5.0', false], 'Jellyfin after its install');
                done();
            });
        });
    });
});

test('a record leaves with its package', function (done) {
    var st = {}; st[WEB_KEY] = {}; st[WEB_KEY][JF] = { key: J, file: 'Jellyfin.wgt', web: '12.4.0' };
    ready({ catalog: catalog(true), installed: { A2STVStore: '0.0.0' }, storage: st }, function (p) {
        eq(p.stored(WEB_KEY), {}, 'the records, with Jellyfin gone from the TV');
        eq(p.app(J).installed, null, 'Jellyfin');
        done();
    });
});

test('a catalog without web_version: as before', function (done) {
    var onTv = { A2STVStore: '0.0.0', MoonPkg001: '1.0.0' }, st = {}; onTv[JF] = '0.1.0';
    st[WEB_KEY] = {}; st[WEB_KEY][JF] = { key: J, file: 'Jellyfin.wgt', web: '12.4.0' };
    ready({ catalog: catalog(false), installed: onTv, storage: st }, function (p) {
        var a = p.app(J);
        eq([a.installed, a.update, a.latest, a.unknown], ['0.1.0', false, '0.1.0', false], 'Jellyfin');
        var m = p.app(M);
        eq([m.installed, m.update, m.latest], ['1.0.0', true, '1.1.0'], 'Moonfin');
        done();
    });
});

var WD = setTimeout(function () { fail('watchdog (30 s)'); }, 30000);
(function next(i) {
    if (i === tests.length) { clearTimeout(WD); console.log('web-version: ' + tests.length + ' tests passed'); return; }
    tests[i][1](function () { console.log('ok   ' + tests[i][0]); next(i + 1); });
})(0);
