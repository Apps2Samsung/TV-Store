/* Uninstall on the On the TV page (#142), against the real page script (see page-harness.js). The
 * page shows the TV's own list next to the catalog's apps: other apps, and the ones built into the
 * TV. Uninstall asks first and Cancel has the focus; a yes sends the app's id from the TV's list
 * with the page token; the row goes when the TV removed it; a refusal shows the service's words
 * and leaves the app; TV-Store itself has no Uninstall; and without the TV's list the catalog's
 * apps still show and are removed by their package id. */
'use strict';
var harness = require('./page-harness.js'), page = harness.page, fail = harness.fail;

function asset(name, pkg, version) {
    return { name: name, browser_download_url: 'https://dl.test/' + name, digest: 'sha256:' + new Array(65).join('a'), package_id: pkg, app_id: pkg + '.App', package_version: version };
}
function provider(id, name, pkg, version) { return { id: id, ok: true, url: 'https://api.github.com/repos/x/' + id + '/releases', releases: [{ assets: [asset(name, pkg, version)] }] }; }
function catalog() { return { schemaVersion: 1, generatedAt: '2026-11-24T10:00:00Z', providers: [provider('moonfin', 'Moonfin.wgt', 'MoonPkg001', '1.1.0'), provider('tv-store', 'TV-Store.wgt', 'A2STVStore', '0.0.0')] }; }
function tvApp(id, title, removable) { return { id: id, title: title, storeId: '', version: '1.0.0', installed: '2026-11-01 10:00:00', size: 38658376, removable: removable }; }
function list() { return [tvApp('A2STVStore.Store', 'TV-Store', true), tvApp('MoonPkg001.App', 'Moonfin', true), tvApp('org.tizen.netflix-app', 'Netflix', true), tvApp('9Ur5IzDKqV.TizenYouTube', 'YouTube', false)]; }

var WD = setTimeout(function () { fail('watchdog (15 s)'); }, 15000);
function open(opts, then) {
    var p = page(opts);
    p.settle(function () { p.press('tabTv'); p.settle(function () { then(p); }); });
}
function has(html, what, why) { if (html.indexOf(what) < 0) fail(why + ': no ' + JSON.stringify(what) + ' in\n' + html.slice(0, 1500)); }
function hasNot(html, what, why) { if (html.indexOf(what) >= 0) fail(why + ': ' + JSON.stringify(what) + ' is there'); }
// The row of an app gets the focus, which puts the app in the panel; then a press in the panel.
function select(p, attr, key) { p.press('', (function () { var a = {}; a[attr] = key; return a; })()); }

var tests = [];
function test(name, fn) { tests.push([name, fn]); }

test('the TV\'s own list shows next to the catalog\'s apps, and Uninstall asks first', function (done) {
    open({ catalog: catalog(), installed: { A2STVStore: '0.0.0', MoonPkg001: '1.1.0' }, tvApps: list() }, function (p) {
        var html = p.html('page');
        has(html, 'Other apps<span class="n">1</span>', 'Netflix is another app');
        has(html, 'Built into the TV<span class="n">1</span>', 'YouTube is built in');
        has(html, 'data-tvapp="tvapp:org.tizen.netflix-app"', 'the row of Netflix');
        if ((html.match(/data-tvapp=/g) || []).length !== 2) fail('the catalog\'s apps and TV-Store must not show again as other apps');
        select(p, 'data-tvapp', 'tvapp:org.tizen.netflix-app');
        p.press('', { 'data-act': 'tvremove' });
        var sheet = p.html('sheet');
        has(sheet, 'Uninstall Netflix from this TV?', 'the question');
        has(sheet, 'data-act="close" data-default>Cancel', 'Cancel has the focus');
        has(sheet, 'not in the catalog', 'what it means for an app outside the catalog');
        if (p.uninstalls.length) fail('nothing is removed before the yes');
        p.press('', { 'data-act': 'removeyes' });
        has(p.html('sheet'), 'Removing Netflix', 'the wait');
        p.settle(function () {
            if (p.uninstalls.length !== 1 || p.uninstalls[0].id !== 'org.tizen.netflix-app' || p.uninstalls[0].token !== 'token') fail('the removal must carry the TV\'s id and the page token: ' + JSON.stringify(p.uninstalls));
            has(p.html('sheet'), 'Netflix is off this TV. That frees 36.9 MB.', 'the outcome');
            p.press('', { 'data-act': 'close' });
            p.settle(function () {
                hasNot(p.html('page'), 'org.tizen.netflix-app', 'Netflix must be gone from the page');
                has(p.html('page'), 'data-app="p:moonfin"', 'Moonfin stays');
                done();
            });
        });
    });
});

test('an app the TV keeps: the warning, and the refusal in the service\'s words', function (done) {
    var why = 'The TV did not remove YouTube. It lists the app as one of its own, and those it keeps (it answered: uninstall failed[118, -9]).';
    open({ catalog: catalog(), installed: { A2STVStore: '0.0.0' }, tvApps: list(), uninstall: function () { return { ok: false, code: 'TV_OWN_APP', error: why }; } }, function (p) {
        select(p, 'data-tvapp', 'tvapp:9Ur5IzDKqV.TizenYouTube');
        has(p.html('tvpanel') || p.html('page'), 'YouTube', 'YouTube in the panel');
        p.press('', { 'data-act': 'tvremove' });
        has(p.html('sheet'), 'one of its own apps. It may refuse', 'the warning for an app the TV keeps');
        p.press('', { 'data-act': 'removeyes' });
        p.settle(function () {
            has(p.html('sheet'), 'uninstall failed[118, -9]', 'the TV\'s words');
            has(p.html('sheet'), 'Try again', 'another try is offered');
            p.press('', { 'data-act': 'close' });
            p.settle(function () { has(p.html('page'), 'tvapp:9Ur5IzDKqV.TizenYouTube', 'YouTube stays on the page'); done(); });
        });
    });
});

test('a catalog app: removed by the id on the TV, installable again; TV-Store itself has no Uninstall', function (done) {
    open({ catalog: catalog(), installed: { A2STVStore: '0.0.0', MoonPkg001: '1.1.0' }, tvApps: list() }, function (p) {
        select(p, 'data-app', 'p:tv-store');
        p.press('', { 'data-act': 'tvremove' });
        if (p.html('sheet').indexOf('Uninstall TV-Store') >= 0) fail('TV-Store must not offer to remove itself');
        p.press('', { 'data-act': 'close' });
        select(p, 'data-app', 'p:moonfin');
        p.press('', { 'data-act': 'tvremove' });
        has(p.html('sheet'), 'Uninstall Moonfin from this TV?', 'the question');
        has(p.html('sheet'), 'install it again from the store', 'a catalog app can come back');
        p.press('', { 'data-act': 'removeyes' });
        p.settle(function () {
            if (p.uninstalls.length !== 1 || p.uninstalls[0].id !== 'MoonPkg001.App') fail('Moonfin must be removed by its id on the TV: ' + JSON.stringify(p.uninstalls));
            p.press('', { 'data-act': 'close' });
            p.settle(function () { p.tick(function () {
                if (p.app('p:moonfin').installed !== null) fail('Moonfin must show as not installed after the removal');
                done();
            }); });
        });
    });
});

test('without the TV\'s list the page says so, and a catalog app goes by its package id', function (done) {
    open({ catalog: catalog(), installed: { A2STVStore: '0.0.0', MoonPkg001: '1.1.0' } }, function (p) {
        has(p.html('page'), 'own list of apps could not be read', 'the note');
        has(p.html('page'), 'no developer connection in this test', 'with the reason');
        select(p, 'data-app', 'p:moonfin');
        p.press('', { 'data-act': 'tvremove' });
        p.press('', { 'data-act': 'removeyes' });
        p.settle(function () {
            if (p.uninstalls.length !== 1 || p.uninstalls[0].id !== 'MoonPkg001') fail('without the list the package id is sent: ' + JSON.stringify(p.uninstalls));
            done();
        });
    });
});

(function next(i) {
    if (i === tests.length) { clearTimeout(WD); console.log('PASS'); tests.forEach(function (t) { console.log('  ' + t[0]); }); process.exit(0); }
    tests[i][1](function () { next(i + 1); });
})(0);
