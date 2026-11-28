/* The screen's side of updates while TV-Store is closed (#157), against the real page script (see
 * page-harness.js).
 *   - The screen hands the service its plan: every app on the TV it would update by itself, with
 *     the build and the version it has, and the switches; TV-Store's own only when it may update
 *     itself. An app whose build is not known, or that needs a phone or PC, is not in it.
 *   - The plan is sent once, and again when a switch changes.
 *   - What the service installed while TV-Store was closed is written down as after an install
 *     from here (a web version too), said once, and the service is told; the screen does not
 *     install that update again.
 *   - While the service still installs, the screen starts no update of its own. */
'use strict';
var harness = require('./page-harness.js'), page = harness.page, fail = harness.fail;
var SETTINGS = 'a2s.store.settings', TRIED = 'a2s.tvstore.autotried', WEB = 'a2s.tvstore.webversions';

function eq(a, b, what) { if (JSON.stringify(a) !== JSON.stringify(b)) fail(what + ': expected ' + JSON.stringify(b) + ', got ' + JSON.stringify(a)); }
function asset(name, pkg, version, web) {
    var a = { name: name, browser_download_url: 'https://dl.test/' + name, digest: 'sha256:' + new Array(65).join('a'), package_id: pkg, app_id: pkg + '.App', package_version: version };
    if (web) a.web_version = web;
    return a;
}
function provider(id, assets) { return { id: id, ok: true, url: 'https://api.github.com/repos/x/' + id + '/releases', releases: [{ assets: assets }] }; }
function catalog() {
    return { schemaVersion: 1, providers: [provider('moonfin', [asset('Moonfin.wgt', 'MoonPkg001', '1.1.0')]), provider('litefin', [asset('Litefin.wgt', 'LitePkg001', '1.0.0')]),
        provider('twins', [asset('Twin-a.wgt', 'TwinPkg001', '1.0.0'), asset('Twin-b.wgt', 'TwinPkg001', '1.0.0')]),
        provider('nohash', [{ name: 'NoHash.wgt', browser_download_url: 'https://dl.test/NoHash.wgt', package_id: 'NoHashPk01', app_id: 'NoHashPk01.App', package_version: '2.0.0' }]),
        provider('jelly', [asset('Jellyfin.wgt', 'JellyPkg01', '0.1.0', '10.11.2')]), provider('notontv', [asset('Not.wgt', 'NotPkg0001', '1.0.0')]),
        provider('tv-store', [asset('TV-Store.wgt', 'A2STVStore', '9.9.9')])] };
}
function onTv() { return { A2STVStore: '0.0.0', MoonPkg001: '1.0.0', LitePkg001: '1.0.0', TwinPkg001: '1.0.0', NoHashPk01: '1.0.0', JellyPkg01: '0.1.0' }; }
function open(opts, then) {
    var plans = [], seen = [], installs = [];
    var p = page({
        catalog: catalog(), installed: opts.installed || onTv(), storage: opts.storage || {},
        answer: function (method, path, body) {
            if (path === '/auto/plan') { plans.push(body); return { ok: true, changed: true }; }
            if (path === '/auto/seen') { seen.push(body); if (opts.auto) opts.auto.landed = []; return { ok: true }; }
            if (path === '/uploads') return { ok: true, pending: null, auto: opts.auto || { running: null, landed: [], last: '' } };
            if (path === '/install') { installs.push(body.packageId); return { ok: true, result: { packageId: body.packageId, appId: body.appId } }; }
            return null;
        }
    });
    p.plans = plans; p.seen = seen; p.sent = installs;
    p.settle(function () { then(p); });
}
function ticks(p, n, then) { if (!n) return then(); p.tick(function () { ticks(p, n - 1, then); }); }
function storage(settings, more) { var s = more || {}; s[SETTINGS] = settings; return s; }

var tests = [];
function test(name, fn) { tests.push([name, fn]); }

test('the plan: what the screen would update by itself, with the build and the version on the TV', function (done) {
    open({ storage: storage({}, (function () { var w = {}; w[WEB] = { JellyPkg01: { key: 'p:jelly', file: 'Jellyfin.wgt', web: '10.10.7' } }; return w; })()) }, function (p) {
        ticks(p, 2, function () {
            eq(p.plans.length, 1, 'plans sent');
            var plan = p.plans[0];
            eq(plan.settings, { apps: false, self: false, closed: false }, 'the switches, all off');
            eq(plan.tizen, '6.5', 'the TV’s Tizen');
            eq(plan.token, 'token', 'with the screen’s token');
            eq(plan.items.map(function (i) { return i.key; }).sort(), ['p:jelly', 'p:litefin', 'p:moonfin'], 'the apps: not the one whose build is not known, the one without a hash, the one not on the TV, or TV-Store');
            var moon = plan.items.filter(function (i) { return i.key === 'p:moonfin'; })[0], jelly = plan.items.filter(function (i) { return i.key === 'p:jelly'; })[0];
            eq(moon, { key: 'p:moonfin', name: moon.name, file: 'Moonfin.wgt', source: 'official', packageId: 'MoonPkg001', appId: 'MoonPkg001.App', have: '1.0.0', web: false, certLevel: '', self: false }, 'one line');
            eq([jelly.have, jelly.web], ['10.10.7', true], 'a build that is compared on its web version');
            eq(plan.tvApps.MoonPkg001, ['MoonPkg001'], 'the names on the TV, for an app under an id of its own');
            ticks(p, 3, function () { eq(p.plans.length, 1, 'the same plan is not sent again'); done(); });
        });
    });
});

test('TV-Store itself is in the plan only when it may update itself; a switch sends the plan again', function (done) {
    open({ storage: storage({ autoUpdateSelf: true, autoUpdateClosed: true }) }, function (p) {
        ticks(p, 2, function () {
            var plan = p.plans[p.plans.length - 1], me = plan.items.filter(function (i) { return i.self; });
            eq(plan.settings, { apps: false, self: true, closed: true }, 'the switches');
            eq(me.map(function (i) { return [i.key, i.packageId, i.have]; }), [['p:tv-store', 'A2STVStore', '0.0.0']], 'TV-Store’s own line');
            var n = p.plans.length;
            p.press('gear');
            p.settle(function () {
                p.press('', { 'data-opt': 'autoUpdateApps' });
                p.settle(function () {
                    p.press('', { 'data-act': 'close' });
                    ticks(p, 3, function () {
                        eq(p.plans.length > n, true, 'sent again after the switch');
                        eq(p.plans[p.plans.length - 1].settings.apps, true, 'with the switch on');
                        // The switch for "while TV-Store is closed" (#158), with the line that says
                        // whether this TV starts the service by itself.
                        var m = p.plans.length;
                        p.press('gear');
                        p.settle(function () {
                            if (p.el('sheet').innerHTML.indexOf('This TV has not started TV-Store by itself yet.') < 0) fail('Settings says whether the TV starts the service');
                            p.press('', { 'data-opt': 'autoUpdateClosed' });
                            p.settle(function () {
                                p.press('', { 'data-act': 'close' });
                                ticks(p, 3, function () {
                                    eq(p.plans.length > m, true, 'sent again after the switch for closed');
                                    eq(p.plans[p.plans.length - 1].settings.closed, false, 'with that switch off');
                                    done();
                                });
                            });
                        });
                    });
                });
            });
        });
    });
});

test('the plan with "Only update the apps I choose": the picked apps, and TV-Store by its own switch', function (done) {
    open({ storage: storage({ autoUpdateApps: true, autoUpdateSelf: true, autoUpdateClosed: true, autoUpdateChosen: true, autoUpdateOnly: ['p:litefin'] }) }, function (p) {
        ticks(p, 2, function () {
            eq(p.plans.length, 1, 'plans sent');
            eq(p.plans[0].items.map(function (i) { return i.key; }).sort(), ['p:litefin', 'p:tv-store'], 'the apps in the plan');
            done();
        });
    });
});

test('what the service installed while TV-Store was closed: written down, said once, not installed again', function (done) {
    var tv = onTv(); tv.MoonPkg001 = '1.1.0';   // the service updated both; Jellyfin's package says 0.1.0 as ever
    var w = {}; w[WEB] = { JellyPkg01: { key: 'p:jelly', file: 'Jellyfin.wgt', web: '10.10.7' } };
    var auto = { running: null, last: '', landed: [
        { key: 'p:moonfin', name: 'Moonfin', file: 'Moonfin.wgt', packageId: 'MoonPkg001', version: '1.1.0', web: '', at: '2026-11-26T03:00:00Z' },
        { key: 'p:jelly', name: 'Jellyfin', file: 'Jellyfin.wgt', packageId: 'JellyPkg01', version: '10.11.2', web: '10.11.2', at: '2026-11-26T03:01:00Z' }] };
    open({ installed: tv, storage: storage({ autoUpdateApps: true, autoUpdateClosed: true }, w), auto: auto }, function (p) {
        ticks(p, 4, function () {
            eq(p.sent, [], 'installs from the screen');
            eq(p.seen.length, 1, 'the service is told once');
            eq(p.seen[0].token, 'token', 'with the token');
            eq(p.stored(WEB).JellyPkg01, { key: 'p:jelly', file: 'Jellyfin.wgt', web: '10.11.2' }, 'the web version on the TV');
            eq(p.stored(TRIED)['p:jelly'], { v: '10.11.2', n: 3 }, 'not tried again');
            if (p.el('toast').textContent.indexOf('2 apps were updated while TV-Store was closed') < 0) fail('the screen says so: ' + p.el('toast').textContent);
            var plan = p.plans[p.plans.length - 1], jelly = plan.items.filter(function (i) { return i.key === 'p:jelly'; })[0];
            eq(jelly.have, '10.11.2', 'the plan that follows has the new version');
            done();
        });
    });
});

test('while the service still installs, the screen starts nothing of its own', function (done) {
    var auto = { running: 'Moonfin', landed: [], last: '' };
    open({ storage: storage({ autoUpdateApps: true }), auto: auto }, function (p) {
        ticks(p, 3, function () {
            eq(p.sent, [], 'installs while the service is at it');
            eq(p.plans.length, 0, 'no plan meanwhile');
            auto.running = null;
            ticks(p, 3, function () { eq(p.sent, ['MoonPkg001'], 'the screen goes on when the service is done'); done(); });
        });
    });
});

(function run(i) {
    if (i >= tests.length) { console.log('auto-plan: ' + tests.length + ' tests passed'); return; }
    tests[i][1](function () { console.log('ok   ' + tests[i][0]); run(i + 1); });
})(0);
