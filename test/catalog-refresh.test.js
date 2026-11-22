/* The store keeps its catalog current while TV-Store stays open, against the real page script (see
 * page-harness.js). The page asks the service for the catalog again ten minutes after the last
 * one, and two minutes after a try that failed. What changed shows without closing TV-Store; a
 * catalog that was only signed again draws nothing; and a change waits while a sheet is open or
 * the search box has the focus. The clock is moved by hand through Date.now. */
'use strict';
var harness = require('./page-harness.js'), page = harness.page, fail = harness.fail;

function eq(a, b, what) { if (JSON.stringify(a) !== JSON.stringify(b)) fail(what + ': expected ' + JSON.stringify(b) + ', got ' + JSON.stringify(a)); }

var realNow = Date.now, skew = 0;
Date.now = function () { return realNow() + skew; };
var MIN = 60 * 1000;

function asset(name, pkg, version) {
    return { name: name, browser_download_url: 'https://dl.test/' + name, digest: 'sha256:' + new Array(65).join('a'), package_id: pkg, app_id: pkg + '.App', package_version: version };
}
function provider(id, name, pkg, version) { return { id: id, ok: true, url: 'https://api.github.com/repos/x/' + id + '/releases', releases: [{ assets: [asset(name, pkg, version)] }] }; }
function catalog(at, providers) { return { schemaVersion: 1, generatedAt: at, providers: providers }; }
var MOON = provider('moonfin', 'Moonfin.wgt', 'MoonPkg001', '1.1.0'), NEWAPP = provider('newapp', 'NewApp.wgt', 'NewPkg0001', '2.0.0');

function keys(p) { return p.state().apps.map(function (a) { return a.key; }).sort(); }
function catalogAsks(p) { return p.asked.filter(function (x) { return x === '/catalog'; }).length; }
function start(opts, then) {
    skew = 0;
    var p = page(opts);
    p.state = function () { var a = p.posts(); if (!a.length) fail('the page posted no picture of the store'); return a[a.length - 1]; };
    p.settle(function () { p.tick(function () { then(p); }); });
}

var tests = [];
function test(name, fn) { tests.push([name, fn]); }

test('within ten minutes the page does not ask again', function (done) {
    var opts = { catalog: catalog('2026-11-22T10:00:00Z', [MOON]), installed: { A2STVStore: '0.0.0' } };
    start(opts, function (p) {
        eq(catalogAsks(p), 1, 'asked at the start');
        skew = 9 * MIN;
        p.tick(function () { eq(catalogAsks(p), 1, 'asked after nine minutes'); done(); });
    });
});

test('after ten minutes a new app and a new version show, and a removed app goes', function (done) {
    var opts = { catalog: catalog('2026-11-22T10:00:00Z', [MOON]), installed: { A2STVStore: '0.0.0' } };
    start(opts, function (p) {
        eq(keys(p), ['p:moonfin'], 'the store at the start');
        opts.catalog = catalog('2026-11-22T10:30:00Z', [provider('moonfin', 'Moonfin.wgt', 'MoonPkg001', '1.2.0'), NEWAPP]);
        skew = 11 * MIN;
        p.tick(function () { p.tick(function () {
            eq(catalogAsks(p), 2, 'asked after eleven minutes');
            eq(keys(p), ['p:moonfin', 'p:newapp'], 'the store after the refresh');
            eq(p.app('p:moonfin').latest, '1.2.0', 'the new version');
            opts.catalog = catalog('2026-11-22T11:00:00Z', [NEWAPP]);
            skew = 22 * MIN;
            p.tick(function () { p.tick(function () {
                eq(keys(p), ['p:newapp'], 'the store after the app left the catalog');
                done();
            }); });
        }); });
    });
});

test('a catalog that was only signed again draws nothing', function (done) {
    var opts = { catalog: catalog('2026-11-22T10:00:00Z', [MOON]), installed: { A2STVStore: '0.0.0' } };
    start(opts, function (p) {
        p.el('page').innerHTML = 'untouched';
        opts.catalog = catalog('2026-11-22T10:30:00Z', [MOON]);
        skew = 11 * MIN;
        p.tick(function () { p.tick(function () {
            eq(catalogAsks(p), 2, 'asked after eleven minutes');
            eq(p.html('page'), 'untouched', 'the page');
            done();
        }); });
    });
});

test('a catalog that does not come keeps the store, and is asked again after two minutes', function (done) {
    var opts = { catalog: catalog('2026-11-22T10:00:00Z', [MOON]), installed: { A2STVStore: '0.0.0' } };
    start(opts, function (p) {
        opts.catalogFails = true;
        skew = 11 * MIN;
        p.tick(function () {
            eq(catalogAsks(p), 2, 'asked after eleven minutes');
            eq(keys(p), ['p:moonfin'], 'the store after the failure');
            skew = 12 * MIN;
            p.tick(function () {
                eq(catalogAsks(p), 2, 'asked a minute after the failure');
                opts.catalogFails = false; opts.catalog = catalog('2026-11-22T10:30:00Z', [MOON, NEWAPP]);
                skew = 14 * MIN;
                p.tick(function () { p.tick(function () {
                    eq(catalogAsks(p), 3, 'asked three minutes after the failure');
                    eq(keys(p), ['p:moonfin', 'p:newapp'], 'the store once the catalog came');
                    done();
                }); });
            });
        });
    });
});

test('a change waits while the search box has the focus', function (done) {
    var opts = { catalog: catalog('2026-11-22T10:00:00Z', [MOON]), installed: { A2STVStore: '0.0.0' } };
    start(opts, function (p) {
        p.doc.activeElement = p.el('search');
        opts.catalog = catalog('2026-11-22T10:30:00Z', [MOON, NEWAPP]);
        skew = 11 * MIN;
        p.tick(function () { p.tick(function () {
            eq(catalogAsks(p), 2, 'asked after eleven minutes');
            eq(keys(p), ['p:moonfin'], 'the store while typing');
            p.doc.activeElement = null;
            p.tick(function () { p.tick(function () {
                eq(keys(p), ['p:moonfin', 'p:newapp'], 'the store once the search box lost the focus');
                done();
            }); });
        }); });
    });
});

test('a change waits while a sheet is open', function (done) {
    var opts = { catalog: catalog('2026-11-22T10:00:00Z', [MOON]), installed: { A2STVStore: '0.0.0' } };
    start(opts, function (p) {
        p.press('gear');
        opts.catalog = catalog('2026-11-22T10:30:00Z', [MOON, NEWAPP]);
        skew = 11 * MIN;
        p.tick(function () { p.tick(function () {
            eq(catalogAsks(p), 2, 'asked after eleven minutes');
            eq(keys(p), ['p:moonfin'], 'the store behind Settings');
            done();
        }); });
    });
});

var WD = setTimeout(function () { fail('watchdog (30 s)'); }, 30000);
(function next(i) {
    if (i === tests.length) { clearTimeout(WD); console.log('catalog-refresh: ' + tests.length + ' tests passed'); return; }
    tests[i][1](function () { console.log('ok   ' + tests[i][0]); next(i + 1); });
})(0);
