/* What the store page is built as (#126), against the real page script (see page-harness.js):
 *   - a notice stands where the greeting stands, not as a line above it that takes a row's room;
 *   - one category (Show all) has its heading above the list, and the list holds lines of cards only;
 *   - the list is put back where it stood when the same list is built again, and not when another
 *     list takes its place (Show all from a row further down opened the category moved up);
 *   - an app without an icon in the catalog shows the icon it has on the TV once it is installed,
 *     and so does an app on the TV that is not in the catalog. */
'use strict';
var harness = require('./page-harness.js'), page = harness.page, fail = harness.fail;

function asset(name, pkg, version) {
    return { name: name, browser_download_url: 'https://dl.test/' + name, digest: 'sha256:' + new Array(65).join('a'), package_id: pkg, app_id: pkg + '.App', package_version: version };
}
function provider(id, name, pkg, version) { return { id: id, ok: true, url: 'https://api.github.com/repos/x/' + id + '/releases', releases: [{ assets: [asset(name, pkg, version)] }] }; }
var WITH_ICON = provider('litefin', 'Litefin.wgt', 'LitePkg001', '1.0.0');
WITH_ICON.releases[0].assets[0].icon = 'https://dl.test/litefin.png';
WITH_ICON.releases[0].assets[0].icon_digest = 'sha256:' + new Array(65).join('b');
var CATALOG = { schemaVersion: 1, generatedAt: '2026-11-24T10:00:00Z', providers: [provider('moonfin', 'Moonfin.wgt', 'MoonPkg001', '1.1.0'), provider('tizentube', 'TizenTube.wgt', 'TubePkg001', '2.0.0'), WITH_ICON] };
var PING = { ok: true, certReady: true, certificates: [{ name: 'PC', level: 'public' }], browser: { enabled: true }, sourceOf: {}, remembered: {}, userSettings: {},
             selfUpdate: { from: '0.0.1', to: '0.0.2', lines: [] } };

function count(html, what) { return html.split(what).length - 1; }
var WD = setTimeout(function () { fail('watchdog (10 s)'); }, 10000);
var p = page({
    catalog: CATALOG, installed: { A2STVStore: '0.0.0', MoonPkg001: '1.1.0', LitePkg001: '1.0.0', OtherPkg01: '3.0.0' },
    icons: { MoonPkg001: '/opt/usr/apps/MoonPkg001/shared/res/moon fin.png', LitePkg001: '/opt/usr/apps/LitePkg001/shared/res/icon.png', OtherPkg01: '/opt/usr/apps/OtherPkg01/shared/res/icon.png', A2STVStore: 'icon.png' },
    tvApps: [{ id: 'OtherPkg01.App', title: 'Other', version: '3.0.0', size: 1000, removable: true }],
    answer: function (method, path) { return path === '/ping' ? PING : null; }
});
p.settle(function () {
    var html = p.html('page');
    // The notice about the self-update: in the greeting's place.
    var greet = html.indexOf('<div class="greet">'), note = html.indexOf('data-act="selfack"'), sel = html.indexOf('id="selcard"');
    if (greet < 0 || note < 0 || sel < 0) fail('the store did not show with its notice: ' + html.slice(0, 300));
    if (!(greet < note && note < sel)) fail('the notice does not stand in the greeting\'s place');
    if (html.indexOf('<div class="notice') < greet) fail('a single notice still stands above the greeting');
    if (/Good (morning|afternoon|evening)/.test(html)) fail('the greeting shows next to the notice');
    if (html.indexOf('style="margin:0 0 26px"') >= 0) fail('a notice still carries its own margin');
    // Icons: the catalog's own where it has one, else the one on the TV.
    var moon = html.slice(html.indexOf('data-app="p:moonfin"')), lite = html.slice(html.indexOf('data-app="p:litefin"')), tube = html.slice(html.indexOf('data-app="p:tizentube"'));
    moon = moon.slice(0, moon.indexOf('class="nm"')); lite = lite.slice(0, lite.indexOf('class="nm"')); tube = tube.slice(0, tube.indexOf('class="nm"'));
    if (moon.indexOf('src="file:///opt/usr/apps/MoonPkg001/shared/res/moon%20fin.png"') < 0) fail('an installed app without a catalog icon does not show the TV\'s: ' + moon);
    if (lite.indexOf('/icon/' + new Array(65).join('b')) < 0 || lite.indexOf('file://') >= 0) fail('an app with a catalog icon must show that one: ' + lite);
    if (tube.indexOf('<img') >= 0) fail('an app that is not on the TV and has no catalog icon shows an image: ' + tube);

    // Where the list stands: the harness keeps one element per id, so what the page writes to the
    // list's scrollTop is what it puts back; a list that is new starts at 0 on a TV by itself.
    var rowsEl = p.el('rows'), top = 262, put = [];
    Object.defineProperty(rowsEl, 'scrollTop', { get: function () { return top; }, set: function (v) { put.push(v); top = v; } });
    p.press('', { 'data-act': 'selfack' });
    p.settle(function () {
        html = p.html('page');
        if (put.length !== 1 || put[0] !== 262) fail('the same list built again was not put back where it stood: ' + JSON.stringify(put));
        put.length = 0;
        if (html.indexOf('data-act="selfack"') >= 0) fail('Got it left the notice');
        if (!/Good (morning|afternoon|evening)/.test(html)) fail('the greeting did not come back after Got it');

        // One category: its heading above the list, the list lines of cards only.
        p.press('', { 'data-chip': 'media' });
        p.settle(function () {
            html = p.html('page');
            var head = html.indexOf('<div class="shead">'), rows = html.indexOf('id="rows"'), lines = html.indexOf('<div class="sect grid lines">');
            if (head < 0 || rows < 0 || lines < 0) fail('one category did not show as a grid: ' + html.slice(0, 300));
            if (!(head < rows && rows < lines)) fail('the heading of one category is not above its list');
            if (count(html, 'class="shead"') !== 1) fail('one category must have one heading, has ' + count(html, 'class="shead"'));
            if (html.indexOf('Media servers &amp; players</span><span class="n">2</span>') < 0) fail('the heading does not name the category and its count');
            if (put.length) fail('one category was moved to where the rows stood: ' + JSON.stringify(put));

            // On the TV: an app that is not in the catalog shows its own icon too.
            p.press('tabTv');
            p.settle(function () {
                html = p.html('page');
                var other = html.slice(html.indexOf('data-tvapp="tvapp:OtherPkg01.App"'));
                if (html.indexOf('data-tvapp="tvapp:OtherPkg01.App"') < 0) fail('the app that is not in the catalog is not listed');
                if (other.slice(0, other.indexOf('class="txt"')).indexOf('src="file:///opt/usr/apps/OtherPkg01/shared/res/icon.png"') < 0) fail('an app that is not in the catalog does not show its icon on the TV');
                if (html.indexOf('<!--panel-->') >= 0) fail('the place of the panel was left in the page');
                if (html.indexOf('id="tvpanel"') < 0) fail('the On the TV page has no panel');
                if (html.indexOf('src="icon.png"') >= 0 || html.indexOf('file://icon.png') >= 0) fail('a path that is not absolute was used as an icon');
                clearTimeout(WD);
                console.log('PASS');
                console.log('  a notice stands in the greeting\'s place, and Got it brings the greeting back');
                console.log('  one category has its heading above a list of lines of cards');
                console.log('  a list built again stands where it stood, another list starts at its top');
                console.log('  apps without a catalog icon show the one they have on the TV');
                process.exit(0);
            });
        });
    });
});
