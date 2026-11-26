/* Updates that install by themselves (#154), against the real page script (see page-harness.js).
 *   - Both switches are off until the user turns them on: nothing installs by itself.
 *   - "Update apps automatically": every app Update all would install is installed, one per tick,
 *     without a sheet, and never TV-Store itself. Not while a sheet is open.
 *   - A version is tried by itself once per start and three times in all: not again in the same
 *     start after it failed, again at the next start, not after the third time, never again once
 *     it was installed (also when the TV still lists the old version), and again when the catalog
 *     has a newer one.
 *   - Update all pressed while such an update runs lines the rest up behind it, without the app
 *     that is installing, and what was lined up still installs when the automatic update fails.
 *   - "Update TV-Store automatically": TV-Store's own update goes first, with its sheet, as a
 *     self-update, once per version, and not while the remote is in use. */
'use strict';
var harness = require('./page-harness.js'), page = harness.page, fail = harness.fail;
var SETTINGS = 'a2s.store.settings', TRIED = 'a2s.tvstore.autotried';

function eq(a, b, what) { if (JSON.stringify(a) !== JSON.stringify(b)) fail(what + ': expected ' + JSON.stringify(b) + ', got ' + JSON.stringify(a)); }
function asset(name, pkg, version) {
    return { name: name, browser_download_url: 'https://dl.test/' + name, digest: 'sha256:' + new Array(65).join('a'), package_id: pkg, app_id: pkg + '.App', package_version: version };
}
function provider(id, name, pkg, version) { return { id: id, ok: true, url: 'https://api.github.com/repos/x/' + id + '/releases', releases: [{ assets: [asset(name, pkg, version)] }] }; }
function catalog(moon) {
    return { schemaVersion: 1, providers: [provider('moonfin', 'Moonfin.wgt', 'MoonPkg001', moon || '1.1.0'), provider('tizentube', 'TizenTube.wgt', 'TubePkg001', '2.0.0'),
                                           provider('litefin', 'Litefin.wgt', 'LitePkg001', '1.0.0'), provider('tv-store', 'TV-Store.wgt', 'A2STVStore', '9.9.9')] };
}
var M = 'p:moonfin', T = 'p:tizentube', S = 'p:tv-store';
// Moonfin and TizenTube have an update, Litefin is current, TV-Store itself has one too.
function onTv() { return { A2STVStore: '0.0.0', MoonPkg001: '1.0.0', TubePkg001: '1.0.0', LitePkg001: '1.0.0' }; }
// A page whose installs land the catalog's version, unless `lands` says otherwise.
function open(opts, then) {
    var tv = onTv(), sent = [];
    var versions = { MoonPkg001: opts.moon || '1.1.0', TubePkg001: '2.0.0', A2STVStore: '9.9.9' };
    var p = page({
        catalog: catalog(opts.moon), installed: tv, storage: opts.storage || {},
        answer: function (method, path, body) {
            if (path !== '/install') return null;
            sent.push(body);
            if (opts.fails) return { ok: false, error: 'the TV said no', code: 'INSTALL_FAILED' };
            if (opts.lands !== false) tv[body.packageId] = versions[body.packageId];
            return { ok: true, result: { packageId: body.packageId, appId: body.appId } };
        }
    });
    p.sent = sent;
    p.settle(function () { then(p); });
}
function ticks(p, n, then) { if (!n) return then(); p.tick(function () { ticks(p, n - 1, then); }); }
function pkgs(p) { return p.sent.map(function (b) { return b.packageId; }); }
function on(apps, self) { var s = {}; s[SETTINGS] = { autoUpdateApps: !!apps, autoUpdateSelf: !!self }; return s; }

var tests = [];
function test(name, fn) { tests.push([name, fn]); }

test('off by default: nothing installs by itself', function (done) {
    open({}, function (p) {
        ticks(p, 4, function () {
            eq(pkgs(p), [], 'installs with both switches off');
            var html;
            p.press('gear');
            p.settle(function () {
                html = p.html('sheet');
                if (html.indexOf('data-opt="autoUpdateApps"') < 0 || html.indexOf('data-opt="autoUpdateSelf"') < 0) fail('Settings does not have the two switches');
                var apps = html.slice(html.indexOf('data-opt="autoUpdateApps"')), self = html.slice(html.indexOf('data-opt="autoUpdateSelf"'));
                if (apps.slice(0, apps.indexOf('</span></div>')).indexOf('class="sw on"') >= 0 || self.slice(0, self.indexOf('</span></div>')).indexOf('class="sw on"') >= 0) fail('a switch is on without anyone turning it on');
                // Turning one on is remembered.
                p.press('', { 'data-opt': 'autoUpdateApps' });
                p.settle(function () {
                    eq([p.stored(SETTINGS).autoUpdateApps, p.stored(SETTINGS).autoUpdateSelf], [true, false], 'the switch as it is remembered');
                    // Settings is still open: nothing starts under it.
                    ticks(p, 2, function () {
                        eq(pkgs(p), [], 'installs while Settings is open');
                        p.press('', { 'data-act': 'close' });
                        ticks(p, 3, function () { eq(pkgs(p), ['MoonPkg001', 'TubePkg001'], 'installs once Settings is closed'); done(); });
                    });
                });
            });
        });
    });
});

test('apps: every update, one after another, without a sheet, never TV-Store', function (done) {
    open({ storage: on(true, false) }, function (p) {
        p.tick(function () {
            eq(pkgs(p), ['MoonPkg001'], 'the first tick starts one update');
            if (p.html('sheet')) fail('an update that started by itself opened a sheet: ' + p.html('sheet').slice(0, 120));
            if (!/Moonfin was updated to v1\.1\.0 automatically/.test(p.el('toast').textContent)) fail('the line that says what happened: ' + p.el('toast').textContent);
            if (p.sent[0].selfUpdate) fail('an app went out as a self-update');
            ticks(p, 4, function () {
                eq(pkgs(p), ['MoonPkg001', 'TubePkg001'], 'the updates, in order, and nothing twice');
                eq([p.app(M).update, p.app(T).update, p.app(S).update], [false, false, true], 'what still has an update afterwards');
                done();
            });
        });
    });
});

test('apps: one that fails is not tried again, the others still are', function (done) {
    open({ storage: on(true, false), fails: true }, function (p) {
        ticks(p, 5, function () {
            eq(pkgs(p), ['MoonPkg001', 'TubePkg001'], 'each failing update is tried once');
            eq(p.stored(TRIED), { 'p:moonfin': { v: '1.1.0', n: 1 }, 'p:tizentube': { v: '2.0.0', n: 1 } }, 'what is written down');
            if (!/automatic update of TizenTube failed/.test(p.el('toast').textContent)) fail('a failure must be said: ' + p.el('toast').textContent);
            if (p.html('sheet')) fail('a failed automatic update opened a sheet');
            eq(p.app(M).update, true, 'the update still waits under On the TV');
            done();
        });
    });
});

test('apps: a version tried three times waits, a newer one is tried', function (done) {
    function tried() { var s = on(true, false); s[TRIED] = { 'p:moonfin': { v: '1.1.0', n: 3 }, 'p:tizentube': { v: '2.0.0', n: 3 } }; return s; }
    open({ storage: tried() }, function (p) {
        ticks(p, 3, function () {
            eq(pkgs(p), [], 'installs of versions that were tried three times');
            open({ storage: tried(), moon: '1.2.0' }, function (p2) {
                ticks(p2, 3, function () { eq(pkgs(p2), ['MoonPkg001'], 'the newer version is tried'); eq(p2.stored(TRIED)['p:moonfin'], { v: '1.2.0', n: 3 }, 'and written down as installed'); done(); });
            });
        });
    });
});

test('apps: one that failed is tried again at the next start, three times in all', function (done) {
    var s = on(true, false); s[TRIED] = { 'p:moonfin': { v: '1.1.0', n: 1 }, 'p:tizentube': { v: '2.0.0', n: 2 } };
    open({ storage: s, fails: true }, function (p) {
        ticks(p, 5, function () {
            eq(pkgs(p), ['MoonPkg001', 'TubePkg001'], 'each tried once more at this start');
            eq(p.stored(TRIED), { 'p:moonfin': { v: '1.1.0', n: 2 }, 'p:tizentube': { v: '2.0.0', n: 3 } }, 'the count');
            var s2 = on(true, false); s2[TRIED] = p.stored(TRIED);
            open({ storage: s2, fails: true }, function (p2) {
                ticks(p2, 5, function () { eq(pkgs(p2), ['MoonPkg001'], 'the one tried three times waits, the other gets its third try'); done(); });
            });
        });
    });
});

test('Update all while an automatic update runs: lined up behind it, and kept when it fails', function (done) {
    // TizenTube waits (tried three times), so the automatic update is Moonfin's, and it fails.
    var s = on(true, false); s[TRIED] = { 'p:tizentube': { v: '2.0.0', n: 3 } };
    var tv = onTv(), sent = [];
    var p = page({ catalog: catalog(), installed: tv, storage: s,
        answer: function (method, path, body) {
            if (path !== '/install') return null;
            sent.push(body.packageId);
            if (body.packageId === 'MoonPkg001') return { ok: false, error: 'the TV said no', code: 'INSTALL_FAILED' };
            tv[body.packageId] = '2.0.0';
            return { ok: true, result: { packageId: body.packageId, appId: body.appId } };
        } });
    p.settle(function () {
        // The tick starts Moonfin; Update all is pressed before its answer is in.
        p.tickNow();
        p.press('', { 'data-act': 'updall' });
        p.settle(function () {
            p.settle(function () {
                eq(sent, ['MoonPkg001', 'TubePkg001'], 'Moonfin once, then the app Update all lined up');
                done();
            });
        });
    });
});

test('apps: a TV that still lists the old version is not sent the update again and again', function (done) {
    open({ storage: on(true, false), lands: false }, function (p) {
        ticks(p, 6, function () { eq(pkgs(p), ['MoonPkg001', 'TubePkg001'], 'each update once, although the TV still lists the old versions'); done(); });
    });
});

test('TV-Store itself: first, with its sheet, once', function (done) {
    open({ storage: on(true, true) }, function (p) {
        p.tick(function () {
            eq(pkgs(p), ['A2STVStore'], 'TV-Store goes before the apps');
            eq([p.sent[0].selfUpdate, p.sent[0].toVersion], [true, '9.9.9'], 'it goes out as a self-update');
            if (p.html('sheet').indexOf('TV-Store') < 0) fail('TV-Store\'s own update must show its sheet: ' + p.html('sheet').slice(0, 200));
            eq(p.stored(TRIED)[S], { v: '9.9.9', n: 3 }, 'written down when it starts, as its one try');
            done();
        });
    });
});

test('TV-Store itself: only with its own switch, and not while the remote is in use', function (done) {
    open({ storage: on(true, false) }, function (p) {
        ticks(p, 5, function () {
            if (pkgs(p).indexOf('A2STVStore') >= 0) fail('TV-Store updated itself with only the apps\' switch on');
            open({ storage: on(false, true) }, function (p2) {
                p2.key(40);   // the remote was just used
                ticks(p2, 3, function () {
                    eq(pkgs(p2), [], 'installs right after a key of the remote');
                    var s = on(false, true); s[TRIED] = { 'p:tv-store': { v: '9.9.9', n: 3 } };
                    open({ storage: s }, function (p3) {
                        ticks(p3, 3, function () { eq(pkgs(p3), [], 'a version of TV-Store that was tried before'); done(); });
                    });
                });
            });
        });
    });
});

var WD = setTimeout(function () { fail('watchdog (30 s)'); }, 30000);
(function next(i) {
    if (i === tests.length) { clearTimeout(WD); console.log('PASS'); tests.forEach(function (t) { console.log('  ' + t[0]); }); process.exit(0); }
    tests[i][1](function () { next(i + 1); });
})(0);
