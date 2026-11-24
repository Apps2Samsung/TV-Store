/* The TV's own app list and its answer to a removal (#142): tvapps.js reads a real `0 vd_applist`
 * reply (a Tizen 6.5 set, the same one Apps2Samsung's parser is tested with), with Windows line
 * ends, with an app listed twice and with nothing listed; finds an app by its id or its package;
 * and reads the answers to `0 vd_appuninstall`. */
'use strict';
var tvapps = require('../tizen-app/service/tvapps.js');
function fail(m) { console.error('FAIL: ' + m); process.exit(1); }
function eq(a, b, what) { if (JSON.stringify(a) !== JSON.stringify(b)) fail(what + ': expected ' + JSON.stringify(b) + ', got ' + JSON.stringify(a)); }

var RULE = '---------------------------------------------------------------------------------------------';
function block(o) {
    return [RULE].concat(['app_id', 'app_title', 'app_version', 'install_date', 'app_tizen_id', 'app_size', 'is_removable'].map(function (k) {
        var key = k; while (key.length < 38) key += ' ';
        return '--------------' + key + '=' + o[k] + '-------------';
    })).concat([RULE]).join('\n');
}
var NETFLIX = { app_id: '3201907018807', app_title: 'Netflix', app_version: '70.23.15090', install_date: '2023-12-15 16:20:06', app_tizen_id: 'org.tizen.netflix-app', app_size: '38658376', is_removable: '1' };
var YOUTUBE = { app_id: '111299001912', app_title: 'YouTube', app_version: '2.1.513', install_date: '2025-05-04 14:03:32', app_tizen_id: '9Ur5IzDKqV.TizenYouTube', app_size: '73728', is_removable: '0' };
var AQUA = { app_id: '', app_title: '', app_version: '1.0.0', install_date: '2026-10-26 10:55:40', app_tizen_id: 'I2UuTnjfeL.AquaPlay', app_size: '1642498', is_removable: '1' };
var LISTING = 'get app list...\napps count: 3\n' + [NETFLIX, YOUTUBE, AQUA].map(block).join('\n') + '\nspend time for wascmd is [82]ms\n';

var apps = tvapps.parse(LISTING);
eq(apps.map(function (a) { return a.id; }), ['org.tizen.netflix-app', '9Ur5IzDKqV.TizenYouTube', 'I2UuTnjfeL.AquaPlay'], 'the apps, in the TV\'s order');
eq(apps[0], { id: 'org.tizen.netflix-app', title: 'Netflix', storeId: '3201907018807', version: '70.23.15090', installed: '2023-12-15 16:20:06', size: 38658376, removable: true }, 'Netflix');
eq(apps[1].removable, false, 'YouTube is one the TV keeps');
eq([apps[2].title, apps[2].storeId, apps[2].removable], ['', '', true], 'a sideloaded app without a title');
eq(tvapps.parse(LISTING.replace(/\n/g, '\r\n')).length, 3, 'Windows line ends');
eq(tvapps.parse(LISTING + block(NETFLIX)).length, 3, 'an app listed twice is one app');
eq(tvapps.parse('get app list...\napps count: 0\nspend time for wascmd is [3]ms\n'), [], 'a TV with nothing to list');
eq([tvapps.isListing(LISTING), tvapps.isListing('apps count: 0\n'), tvapps.isListing('closed'), tvapps.isListing('')], [true, true, false, false], 'what is a listing');

eq(tvapps.find(apps, 'org.tizen.netflix-app').title, 'Netflix', 'found by its id');
eq(tvapps.find(apps, 'I2UuTnjfeL').id, 'I2UuTnjfeL.AquaPlay', 'found by its package');
eq(tvapps.find(apps, 'I2UuTnjfe'), null, 'part of a package id is not that package');
eq(tvapps.find(apps, 'org.tizen'), null, 'part of an id is not that app');
eq([tvapps.belongs('A2STVStore.Store', 'A2STVStore'), tvapps.belongs('A2STVStore', 'A2STVStore'), tvapps.belongs('A2STVStoreX.Store', 'A2STVStore'), tvapps.belongs('x', '')], [true, true, false, false], 'which app is in which package');
eq([tvapps.packageOf('I2UuTnjfeL.AquaPlay'), tvapps.packageOf('org.tizen.netflix-app')], ['I2UuTnjfeL', 'org.tizen.netflix-app'], 'the package of an app');
eq(['I2UuTnjfeL.AquaPlay', 'org.tizen.netflix-app', 'a b', 'x;rm', '', '.x'].map(function (i) { return tvapps.SAFE_ID.test(i); }), [true, true, false, false, false, false], 'ids that go into the command');

eq(tvapps.verdict(' uninstall I2UuTnjfeL.AquaPlay app_id[I2UuTnjfeL.AquaPlay] uninstall completed\nspend time for wascmd is [900]ms\n').ok, true, 'a removal that went through');
eq(tvapps.verdict('app_id[x] uninstall failed[118, -9]').ok, false, 'a removal the TV refused');
eq(tvapps.verdict('error: closed').ok, false, 'an error');
eq([tvapps.verdict('uninstall failed[132]').ok, tvapps.verdict('uninstall failed[132]').gone], [true, true], 'failed[132]: the app was not there');
console.log('PASS');
console.log('  a real vd_applist reply: ids, titles, sizes, what the TV lets go; line ends, doubles, an empty list');
console.log('  an app by its id or its package, never by part of one; ids safe for the command');
console.log('  the answers to vd_appuninstall');
