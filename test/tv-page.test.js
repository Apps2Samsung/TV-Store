/* The On the TV page (#126), against the real page script (see page-harness.js):
 *   - the search box searches the page it stands above: under On the TV it narrows the TV's apps
 *     down (the catalog's, the ones that are not in it, the built-in ones) and stays on that page;
 *     RETURN shows them all again, and only the next RETURN goes back to the store;
 *   - on the store the same box still searches the catalog;
 *   - when the TV's own list cannot be read, the note that says so (with the reason) stands above
 *     the list, not after its last app where the bottom of the screen cut it off. */
'use strict';
var harness = require('./page-harness.js'), page = harness.page, fail = harness.fail;
var RETURN = 10009;

function asset(name, pkg, version) {
    return { name: name, browser_download_url: 'https://dl.test/' + name, digest: 'sha256:' + new Array(65).join('a'), package_id: pkg, app_id: pkg + '.App', package_version: version };
}
function provider(id, name, pkg, version) { return { id: id, ok: true, url: 'https://api.github.com/repos/x/' + id + '/releases', releases: [{ assets: [asset(name, pkg, version)] }] }; }
var CATALOG = { schemaVersion: 1, providers: [provider('moonfin', 'Moonfin.wgt', 'MoonPkg001', '1.1.0'), provider('tizentube', 'TizenTube.wgt', 'TubePkg001', '2.0.0'), provider('litefin', 'Litefin.wgt', 'LitePkg001', '1.0.0')] };
var TV_APPS = [{ id: 'OtherPkg01.App', title: 'Gallery', version: '3.0.0', size: 1000, removable: true }, { id: 'org.tizen.primevideo', title: 'Prime Video', version: '5.0.0', size: 2000, removable: false },
               { id: 'MoonPkg001.App', title: 'Moonfin', version: '1.0.0', size: 3000, removable: true }];
function rows(html) { var out = [], re = /data-k="tv:([^"]+)"/g, m; while ((m = re.exec(html))) out.push(m[1]); return out; }
function eq(a, b, what) { if (JSON.stringify(a) !== JSON.stringify(b)) fail(what + ': expected ' + JSON.stringify(b) + ', got ' + JSON.stringify(a)); }

var WD = setTimeout(function () { fail('watchdog (20 s)'); }, 20000);
var p = page({ catalog: CATALOG, installed: { A2STVStore: '0.0.0', MoonPkg001: '1.0.0', LitePkg001: '1.0.0', OtherPkg01: '3.0.0' }, tvApps: TV_APPS });
p.settle(function () {
    p.press('tabTv');
    p.settle(function () {
        var html = p.html('page');
        eq(rows(html), ['p:moonfin', 'p:litefin', 'tvapp:OtherPkg01.App', 'tvapp:org.tizen.primevideo'], 'the page without a search');
        if (html.indexOf('data-act="updall"') < 0) fail('Update is offered at the top without a search');

        // By name, in every group.
        p.type('prime');
        p.settle(function () {
            html = p.html('page');
            if (html.indexOf('class="tvtop"') < 0) fail('typing in the search box left the On the TV page');
            eq(rows(html), ['tvapp:org.tizen.primevideo'], 'a search for "prime"');
            if (html.indexOf('1 app on this TV matches “prime”') < 0) fail('the page does not say what the search found: ' + html.slice(0, 300));
            if (html.indexOf('data-act="updall"') >= 0) fail('Update all shows while a search narrows the list');
            if (html.indexOf('Prime Video</div><div class="mt">org.tizen.primevideo') < 0) fail('the panel does not show the app the search left');

            p.type('fin');
            p.settle(function () {
                eq(rows(p.html('page')), ['p:moonfin', 'p:litefin'], 'a search for "fin": the catalog\'s apps on the TV');
                // By its id, for an app that is not in the catalog.
                p.type('otherpkg');
                p.settle(function () {
                    eq(rows(p.html('page')), ['tvapp:OtherPkg01.App'], 'a search by id');
                    p.type('zzz');
                    p.settle(function () {
                        html = p.html('page');
                        eq(rows(html), [], 'a search that finds nothing');
                        if (html.indexOf('Nothing on this TV matches “zzz”') < 0 || html.indexOf('class="tvtop"') < 0) fail('nothing found must say so, on the same page: ' + html.slice(0, 300));
                        // RETURN: first the search goes, then the page.
                        p.key(RETURN);
                        p.settle(function () {
                            html = p.html('page');
                            if (p.el('search').value !== '') fail('RETURN left the search text in the box');
                            eq(rows(html).length, 4, 'every app again after RETURN');
                            if (html.indexOf('class="tvtop"') < 0) fail('the first RETURN left the On the TV page');
                            p.key(RETURN);
                            p.settle(function () {
                                html = p.html('page');
                                if (html.indexOf('class="tvtop"') >= 0 || html.indexOf('id="rows"') < 0) fail('the second RETURN did not go back to the store');
                                // On the store the box searches the catalog, as before.
                                p.type('tizentube');
                                p.settle(function () {
                                    html = p.html('page');
                                    if (html.indexOf('data-app="p:tizentube"') < 0 || html.indexOf('data-app="p:moonfin"') >= 0 || html.indexOf('<h1>Search</h1>') < 0) fail('the store\'s search changed: ' + html.slice(0, 300));
                                    unread();
                                });
                            });
                        });
                    });
                });
            });
        });
    });
});

// The TV's own list cannot be read: the note stands above the list.
function unread() {
    var q = page({ catalog: CATALOG, installed: { A2STVStore: '0.0.0', MoonPkg001: '1.0.0', LitePkg001: '1.0.0' },
                   answer: function (method, path) { return path === '/tvapps' ? { ok: false, error: 'The TV did not answer when asked for its apps.', code: 'NO_LISTING' } : null; } });
    q.settle(function () {
        q.press('tabTv');
        q.settle(function () {
            var html = q.html('page'), note = html.indexOf('could not be read'), list = html.indexOf('class="tvcols"'), last = html.lastIndexOf('data-k="tv:');
            if (note < 0 || list < 0 || last < 0) fail('the page with a list that could not be read: ' + html.slice(0, 300));
            if (!(note < list)) fail('the note stands inside or after the list, where the screen cuts it off');
            if (html.indexOf('The TV did not answer when asked for its apps.') < 0) fail('the note does not give the reason');
            if (html.split('could not be read').length !== 2) fail('the note shows more than once');
            eq(rows(html), ['p:moonfin', 'p:litefin'], 'the catalog\'s apps still show');
            clearTimeout(WD);
            console.log('PASS');
            console.log('  the search box under On the TV narrows the TV\'s apps down and stays there; RETURN clears it first');
            console.log('  on the store it still searches the catalog');
            console.log('  the note about a list that could not be read stands above the list, with its reason');
            process.exit(0);
        });
    });
}
