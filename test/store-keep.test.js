/* The store page is built once and kept (#126), against the real page script (see page-harness.js).
 * Opening an app's sheet and closing it again leaves the page as it is: building it again drew
 * every icon anew and put the rows back at their start. The 3 s tick leaves it alone too. What does
 * change the page builds it again: another category. */
'use strict';
var harness = require('./page-harness.js'), page = harness.page, fail = harness.fail;

function asset(name, pkg, version) {
    return { name: name, browser_download_url: 'https://dl.test/' + name, digest: 'sha256:' + new Array(65).join('a'), package_id: pkg, app_id: pkg + '.App', package_version: version };
}
function provider(id, name, pkg, version) { return { id: id, ok: true, url: 'https://api.github.com/repos/x/' + id + '/releases', releases: [{ assets: [asset(name, pkg, version)] }] }; }
var CATALOG = { schemaVersion: 1, generatedAt: '2026-11-24T10:00:00Z', providers: [provider('moonfin', 'Moonfin.wgt', 'MoonPkg001', '1.1.0'), provider('tizentube', 'TizenTube.wgt', 'TubePkg001', '2.0.0')] };

var WD = setTimeout(function () { fail('watchdog (10 s)'); }, 10000);
var p = page({ catalog: CATALOG, installed: { A2STVStore: '0.0.0' } });
p.settle(function () {
    var el = p.el('page'), html = el.innerHTML, builds = 0;
    if (html.indexOf('data-app="p:moonfin"') < 0) fail('the store did not show: ' + html.slice(0, 200));
    if (html.indexOf('<!--selected-->') >= 0) fail('the place of the Selected card was left in the page');
    Object.defineProperty(el, 'innerHTML', { get: function () { return html; }, set: function (v) { html = v; builds++; } });

    p.press('', { 'data-app': 'p:moonfin' });
    p.settle(function () {
        if (p.html('sheet').indexOf('Moonfin') < 0) fail('OK on a card did not open its sheet');
        p.press('', { 'data-act': 'close' });
        p.settle(function () {
            if (p.html('sheet') !== '') fail('the sheet did not close');
            if (builds) fail('closing a sheet built the store page again (' + builds + ' times)');
            p.tick(function () {
                if (builds) fail('the 3 s tick built the store page again');
                p.press('', { 'data-chip': 'media' });
                p.settle(function () {
                    if (builds !== 1) fail('another category must build the page once, built ' + builds + ' times');
                    if (html.indexOf('data-app="p:tizentube"') >= 0) fail('Media servers & players shows a streaming app');
                    clearTimeout(WD);
                    console.log('PASS');
                    console.log('  a sheet that opens and closes, and the 3 s tick, leave the store page as it is');
                    console.log('  another category builds it again');
                    process.exit(0);
                });
            });
        });
    });
});
