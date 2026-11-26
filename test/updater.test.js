/* What the service may install by itself while TV-Store is closed (#157): updater.js, pure. The
 * builds of a catalog keyed as the page keys them; the plan cleaned up; and a round's list: the
 * same build with a newer version than the screen saw and than the TV lists, TV-Store's own first,
 * each switch on its own, and everything that waits with its reason (gone from the TV or the
 * catalog, needs a phone or PC, settings typed elsewhere, tried three times, tried since the
 * start, running). */
'use strict';
var updater = require('../tizen-app/service/updater.js');

function fail(m) { console.error('FAIL: ' + m); process.exit(1); }
function eq(a, b, what) { if (JSON.stringify(a) !== JSON.stringify(b)) fail(what + ': expected ' + JSON.stringify(b) + ', got ' + JSON.stringify(a)); }

var D = 'sha256:' + new Array(65).join('a');
function asset(name, pkg, version, more) {
    var a = { name: name, browser_download_url: 'https://dl.test/' + name, digest: D, package_id: pkg, app_id: pkg + '.App', package_version: version };
    for (var k in more || {}) a[k] = more[k];
    return a;
}
var CAT = { providers: [
    { id: 'moonfin', ok: true, releases: [{ assets: [asset('Moonfin.wgt', 'MoonPkg001', '1.2.0'), asset('Moonfin-old.wgt', 'MoonPkg001', '1.2.0'), asset('notes.txt', '', '')] }] },
    { id: 'broken', ok: false, releases: [{ assets: [asset('Broken.wgt', 'BrokenPk01', '9.0.0')] }] },
    { id: 'jelly', ok: true, releases: [{ assets: [asset('Jellyfin.wgt', 'JellyPkg01', '0.1.0', { web_version: '10.11.2' })] }] },
    { id: 'tvstore', ok: true, releases: [{ assets: [asset('TVStore.wgt', 'A2STVStore', '0.4.0')] }] },
    { id: 'nohash', ok: true, releases: [{ assets: [asset('NoHash.wgt', 'NoHashPk01', '2.0.0', { digest: '' })] }] },
    { id: 'community', ok: true, catalog: { apps: [
        { file: 'Rooty.wgt', name: 'Rooty', flags: ['root'] },
        { file: 'Typed.wgt', name: 'Typed', user_settings: { file: 'x.js', fields: [] } },
        { file: 'TvApp.wgt', group: 'Injector', name: 'Injector one' },
        { file: 'Plain.wgt', name: 'Plain', version: '3.1.0', package_id: 'PlainPkg02' },
        { file: 'Missing.wgt', name: 'Missing' }] },
      releases: [{ assets: [asset('Rooty.wgt', 'RootyPkg01', '1.0.0'), asset('Typed.wgt', 'TypedPkg01', '1.5.0'), asset('TvApp.wgt', 'InjPkg0001', '1.0.0'), asset('Plain.wgt', 'PlainPkg01', '3.0.0')] }] }
] };
var all = updater.builds(CAT);
function build(key, file) { return all.filter(function (b) { return b.key === key && (!file || b.file === file); })[0]; }

eq(all.map(function (b) { return b.key + '/' + b.file; }), ['p:moonfin/Moonfin.wgt', 'p:moonfin/Moonfin-old.wgt', 'p:jelly/Jellyfin.wgt', 'p:tvstore/TVStore.wgt', 'p:nohash/NoHash.wgt', 'c:Rooty/Rooty.wgt', 'c:Typed/Typed.wgt', 'c:Injector/TvApp.wgt', 'c:Plain/Plain.wgt'], 'the builds of a catalog');
eq([build('p:jelly').web, build('p:jelly').version], ['10.11.2', '0.1.0'], 'a web version');
eq([build('c:Plain').version, build('c:Plain').packageId], ['3.1.0', 'PlainPkg02'], 'the community entry over the release');
eq([build('p:nohash').head, build('c:Rooty').head, build('c:Injector').head, build('c:Typed').head, build('c:Typed').settings, build('c:Plain').head], [true, true, true, false, true, false], 'what needs a phone or PC');
var REPO = updater.builds({ providers: [{ id: 'x', ok: true, flags: ['root'], releases: [{ assets: [asset('X.wgt', 'XPkg000001', '1.0.0')] }] },
    { id: 'c', ok: true, catalog: { apps: [{ file: 'S.wgt', name: 'S', user_settings: {} }] }, releases: [{ assets: [asset('S.wgt', 'SPkg000001', '1.0.0')] }] }] }, 'repo.one');
eq(REPO.map(function (b) { return [b.key, b.head]; }), [['r:repo.one:p:x', true], ['r:repo.one:c:S', true]], 'a repository: its key, root, and settings it cannot type');
console.log('  the builds of a catalog: keys as on the page, a web version, the community entry, what needs a phone or PC');

var P = updater.plan({ settings: { apps: true, self: 'yes', closed: true }, tizen: '6.5', tvApps: { MoonPkg001: ['Moonfin'] }, items: [
    { key: 'p:moonfin', name: 'Moonfin', file: 'Moonfin.wgt', source: 'official', packageId: 'MoonPkg001', appId: 'MoonPkg001.App', have: '1.1.0', web: false, certLevel: 'partner', self: false },
    { key: 'p:moonfin', name: 'twice', file: 'Moonfin-old.wgt', packageId: 'MoonPkg001' },
    { key: 'p:nofile', packageId: 'X' }, null, 'junk',
    { key: 'p:jelly', file: 'Jellyfin.wgt', packageId: 'JellyPkg01', have: '10.10.7', web: true, certLevel: 'root' }] });
eq(P.settings, { apps: true, self: false, closed: true }, 'the switches: only true is on');
eq(P.items.map(function (i) { return [i.key, i.name, i.source, i.certLevel, i.web]; }), [['p:moonfin', 'Moonfin', 'official', 'partner', false], ['p:jelly', 'p:jelly', 'official', '', true]], 'the items: one per app, with a file and a package');
eq(updater.plan(null), { settings: { apps: false, self: false, closed: false }, tizen: '', tvApps: null, items: [] }, 'no plan');
console.log('  the plan: only true turns a switch on, one line per app, junk dropped');

function item(key, file, pkg, have, more) { var i = { key: key, name: key, file: file, source: 'official', packageId: pkg, appId: pkg + '.App', have: have, web: false, certLevel: '', self: false }; for (var k in more || {}) i[k] = more[k]; return i; }
function plan(items, s) { return { settings: s || { apps: true, self: true, closed: true }, tizen: '6.5', tvApps: null, items: items }; }
function tv(list) { return list.map(function (a) { return { id: a[0], version: a[1] }; }); }
var MOON = item('p:moonfin', 'Moonfin.wgt', 'MoonPkg001', '1.1.0'), JELLY = item('p:jelly', 'Jellyfin.wgt', 'JellyPkg01', '10.10.7', { web: true }), SELF = item('p:tvstore', 'TVStore.wgt', 'A2STVStore', '0.3.44', { self: true });
var TV = tv([['MoonPkg001.App', '1.1.0'], ['JellyPkg01.Jellyfin', '0.1.0'], ['A2STVStore.Store', '0.3.44'], ['org.tizen.netflix-app', '5.0']]);
function names(d) { return d.list.map(function (c) { return c.item.key + '@' + c.version; }); }
function why(d) { return d.skipped.map(function (s) { return s.item.key + ': ' + s.why; }); }

var d = updater.due(plan([MOON, JELLY, SELF]), all, TV, {}, {}, [], null);
eq(names(d), ['p:tvstore@0.4.0', 'p:moonfin@1.2.0', 'p:jelly@10.11.2'], 'what is due, TV-Store first');
eq(d.skipped, [], 'nothing waits');
eq(names(updater.due(plan([MOON, JELLY, SELF], { apps: true, self: false, closed: true }), all, TV, {}, {}, [], null)), ['p:moonfin@1.2.0', 'p:jelly@10.11.2'], 'TV-Store off');
eq(names(updater.due(plan([MOON, JELLY, SELF], { apps: false, self: true, closed: true }), all, TV, {}, {}, [], null)), ['p:tvstore@0.4.0'], 'apps off');
console.log('  a round: the same build with a newer version, TV-Store first, each switch on its own');

eq(names(updater.due(plan([item('p:moonfin', 'Moonfin.wgt', 'MoonPkg001', '1.2.0')]), all, TV, {}, {}, [], null)), [], 'the screen saw this version already');
eq(names(updater.due(plan([MOON]), all, tv([['MoonPkg001.App', '1.3.0']]), {}, {}, [], null)), [], 'the TV has a newer copy from elsewhere');
eq(names(updater.due(plan([MOON]), all, tv([['MoonPkg001.App', '']]), {}, {}, [], null)), ['p:moonfin@1.2.0'], 'a TV that lists no version: the screen\'s word');
eq(names(updater.due(plan([item('p:moonfin', 'Moonfin.wgt', 'MoonPkg001', '')]), all, TV, {}, {}, [], null)), [], 'no version known: no update');
eq(names(updater.due(plan([item('p:jelly', 'Jellyfin.wgt', 'JellyPkg01', '10.11.2', { web: true })]), all, TV, {}, {}, [], null)), [], 'the web version is the same, whatever the package says');
console.log('  no update: the version the screen saw, a newer copy on the TV, a version nobody knows');

d = updater.due(plan([item('p:gone', 'Gone.wgt', 'GonePkg001', '1.0.0'), item('p:moonfin', 'Other.wgt', 'MoonPkg001', '1.0.0'), item('p:moonfin2', 'Moonfin.wgt', 'MoonPkg001', '1.0.0')]), all, TV, {}, {}, [], null);
eq([names(d), d.skipped.length], [[], 3], 'another app or another file is not the same build');
d = updater.due(plan([item('p:moonfin', 'Moonfin.wgt', 'MoonPkg001', '1.1.0')]), all, tv([['OtherPkg01.App', '1.0.0']]), {}, {}, [], null);
eq(why(d), ['p:moonfin: it is not on the TV any more'], 'gone from the TV');
var HEADS = [item('p:nohash', 'NoHash.wgt', 'NoHashPk01', '1.0.0'), item('c:Rooty', 'Rooty.wgt', 'RootyPkg01', '0.9.0'), item('c:Typed', 'Typed.wgt', 'TypedPkg01', '1.0.0')];
var HTV = tv([['NoHashPk01.App', '1.0.0'], ['RootyPkg01.App', '0.9.0'], ['TypedPkg01.App', '1.0.0']]);
d = updater.due(plan(HEADS), all, HTV, {}, {}, [], function () { return false; });
eq([names(d), d.skipped.length], [[], 3], 'a build that needs a phone or PC, and settings typed elsewhere');
eq(names(updater.due(plan(HEADS), all, HTV, {}, {}, [], function (f) { return f === 'Typed.wgt'; })), ['c:Typed@1.5.0'], 'settings the TV holds');
console.log('  waits: not the same build, gone from the TV, needs a phone or PC, settings typed elsewhere');

eq(names(updater.due(plan([MOON]), all, TV, { 'p:moonfin': { v: '1.2.0', n: 2 } }, {}, [], null)), ['p:moonfin@1.2.0'], 'tried twice');
eq(names(updater.due(plan([MOON]), all, TV, { 'p:moonfin': { v: '1.2.0', n: 3 } }, {}, [], null)), [], 'tried three times');
eq(names(updater.due(plan([MOON]), all, TV, { 'p:moonfin': { v: '1.1.5', n: 3 } }, {}, [], null)), ['p:moonfin@1.2.0'], 'three times for an older version');
eq(names(updater.due(plan([MOON]), all, TV, {}, { 'p:moonfin': '1.2.0' }, [], null)), [], 'tried since the start');
var t = {};
updater.mark(t, 'a', '1.0', 1); updater.mark(t, 'a', '1.0', 1); eq(t.a, { v: '1.0', n: 2 }, 'two tries');
updater.mark(t, 'a', '1.0', 5); eq(t.a, { v: '1.0', n: 3 }, 'never more than three');
updater.mark(t, 'a', '1.1', 1); eq(t.a, { v: '1.1', n: 1 }, 'a new version starts again');
console.log('  tries: once per start, three in all per version, a new version starts again');

d = updater.due(plan([MOON, JELLY]), all, TV, {}, {}, ['MoonPkg001.App', 'org.tizen.netflix-app'], null);
eq([names(d), why(d)], [['p:jelly@10.11.2'], ['p:moonfin: it is running']], 'an app that runs is left alone');
eq(names(updater.due(plan([MOON, JELLY]), all, TV, {}, {}, null, null)), ['p:moonfin@1.2.0', 'p:jelly@10.11.2'], 'a TV that does not say what runs: the caller decides');
eq([updater.belongs('AbCdEfGhIj.App', 'AbCdEfGhIj'), updater.belongs('org.tizen.netflix-app', 'org.tizen'), updater.belongs('AbCdEfGhIjK.App', 'AbCdEfGhIj')], [true, false, false], 'which app is part of which package');
console.log('  an app that runs is left alone');
console.log('PASS: updater.js, what a round while TV-Store is closed installs and what waits');
