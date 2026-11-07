/* Another app's package id (#84), the pure parts: the id derived from a catalog entry (the values
 * below were computed apart from this code, with Python's hashlib, so a change to the scheme that
 * Apps2Samsung#1028 shares shows up here), the catalog keys, the decision, the whole-token
 * replace, and the rewrite of a package with a service component and app code that launches it. */
'use strict';
var fs = require('fs'), os = require('os'), path = require('path');
var pkgid = require('../tizen-app/service/pkgid.js');
var catalog = require('../tizen-app/service/catalog.js');
var manifest = require('../tizen-app/service/manifest.js');
var zip = require('../tizen-app/service/zip.js');
var Buf = require('../tizen-app/service/compat.js');

function fail(m) { console.error('FAIL: ' + m); process.exit(1); }
function eq(a, b, what) { if (JSON.stringify(a) !== JSON.stringify(b)) fail(what + ': got ' + JSON.stringify(a) + ', want ' + JSON.stringify(b)); }

// ---- the id ----
eq(pkgid.derive('sfsdffesfsfg-cloud/tacplayer/tacplayer.wgt'), 'ln9ooxgrYz', 'tacplayer id');
eq(pkgid.derive('jeppevinkel/jellyfin-tizen-builds/Jellyfin.wgt'), 'NlEuwl5oL0', 'Jellyfin id');
eq(pkgid.derive('tacplayer/tacplayer-tizen/tacplayer.wgt'), 'qf1Q0J856J', 'another key');
if (!/^[0-9A-Za-z]{10}$/.test(pkgid.derive('x'))) fail('a derived id is 10 letters and digits');
eq(pkgid.githubRepo('https://api.github.com/repos/jeppevinkel/jellyfin-tizen-builds/releases/tags/2024-10-27-1821'), 'jeppevinkel/jellyfin-tizen-builds', 'repo from a tag URL');
eq(pkgid.githubRepo('https://example.com/feed.json'), '', 'no repo outside the GitHub API');

// ---- the catalog's keys ----
var scanned = catalog.scan({ providers: [
    { id: 'jellyfin-tizen-builds', url: 'https://api.github.com/repos/jeppevinkel/jellyfin-tizen-builds/releases', releases: [{ assets: [{ name: 'Jellyfin.wgt', browser_download_url: 'https://dl/j/Jellyfin.wgt' }] }] },
    { id: 'tizen-community', url: 'https://api.github.com/repos/Apps2Samsung/tizen-community-packages/releases',
      catalog: { apps: [{ file: 'tacplayer.wgt', repo: 'sfsdffesfsfg-cloud/tacplayer', package_id: 'AprZAARz4r' }, { file: 'NoRepo.wgt' }] },
      releases: [{ assets: [{ name: 'tacplayer.wgt', browser_download_url: 'https://dl/c/tacplayer.wgt' }, { name: 'NoRepo.wgt', browser_download_url: 'https://dl/c/NoRepo.wgt' }] }] },
    { id: 'elsewhere', url: 'https://example.com/feed.json', releases: [{ assets: [{ name: 'E.wgt', browser_download_url: 'https://dl/e/E.wgt' }] }] }
] });
eq(scanned.keys, { 'https://dl/j/Jellyfin.wgt': 'jeppevinkel/jellyfin-tizen-builds/Jellyfin.wgt', 'https://dl/c/tacplayer.wgt': 'sfsdffesfsfg-cloud/tacplayer/tacplayer.wgt' },
    'keys: a provider by its GitHub repo, a community package by its own repo (not the bundle\'s), none without one');
eq(scanned.files['https://dl/c/NoRepo.wgt'], 'NoRepo.wgt', 'files by URL');
eq(pkgid.key('https://repo.example/r/repository.json.signed', 'App.wgt'), 'https://repo.example/r/repository.json.signed/App.wgt', 'a repository key');

// ---- the decision ----
var TAC = pkgid.derive('sfsdffesfsfg-cloud/tacplayer/tacplayer.wgt');
function d(o) { return pkgid.decide(o); }
var base = { kind: 'wgt', packageId: 'AprZAARz4r', names: ['tacplayer'], key: 'sfsdffesfsfg-cloud/tacplayer/tacplayer.wgt' };
function w(extra) { var o = {}; for (var k in base) o[k] = base[k]; for (k in extra) o[k] = extra[k]; return o; }
eq(d(w({ tvApps: null })), { keep: true }, 'the page did not say what the TV has');
eq(d(w({ tvApps: {} })), { keep: true }, 'nothing on the TV');
eq(d(w({ tvApps: { AprZAARz4r: ['TACPlayer '] } })), { keep: true }, 'same name, case and spaces aside: an update');
eq(d(w({ tvApps: { AprZAARz4r: ['Jellyfin'] } })), { rename: TAC, why: 'collision', other: 'Jellyfin' }, 'another app has the id');
eq(d(w({ tvApps: { AprZAARz4r: ['Jellyfin'] }, names: [] })), { keep: true }, 'a package without a name is not renamed');
eq(d(w({ tvApps: { AprZAARz4r: [] }, names: ['tacplayer'] })), { keep: true }, 'an app without a name on the TV is not renamed');
eq(d(w({ tvApps: { AprZAARz4r: ['Jellyfin'], foo: [] }, names: ['Tac', 'tacplayer'] })), { rename: TAC, why: 'collision', other: 'Jellyfin' }, 'any of the names');
eq(d(w({ tvApps: { AprZAARz4r: ['Jellyfin', 'tacplayer'] } })), { keep: true }, 'a name in common');
var upd = {}; upd[TAC] = ['tacplayer']; upd.AprZAARz4r = ['Jellyfin'];
eq(d(w({ tvApps: upd })), { rename: TAC, why: 'update' }, 'its renamed copy is on the TV');
var only = {}; only[TAC] = ['old name'];
eq(d(w({ tvApps: only })), { rename: TAC, why: 'update' }, 'its renamed copy, whatever it is called now, and the other app gone');
// Another build of the same app took a renamed id before: this one lands there when the names agree.
var rec = [{ originalPackageId: 'AprZAARz4r', newPackageId: 'Other00001' }];
eq(d(w({ key: 'k/other.wgt', tvApps: { AprZAARz4r: ['Jellyfin'], Other00001: ['tacplayer'] }, renames: rec })), { rename: 'Other00001', why: 'update' }, 'a sibling build\'s rename');
eq(d(w({ key: 'k/other.wgt', tvApps: { AprZAARz4r: ['Jellyfin'], Other00001: ['Something else'] }, renames: rec })).why, 'collision', 'not a rename that holds another app');
eq(d(w({ key: '', tvApps: { AprZAARz4r: ['Jellyfin'] } })), { taken: 'Jellyfin' }, 'no catalog entry to derive from');
eq(d(w({ kind: 'tpk', tvApps: { AprZAARz4r: ['Jellyfin'] } })), { taken: 'Jellyfin' }, 'a .tpk keeps its id');
eq(d(w({ kind: 'tpk', tvApps: { AprZAARz4r: ['tacplayer'] } })), { keep: true }, 'a .tpk update');

// ---- the replace ----
function r(s, a, b) { var o = pkgid.replaceToken(Buf.from(s, 'utf8'), a, b); return o ? o.toString('utf8') : null; }
eq(r('<tizen:application id="Pkg.App" package="Pkg"/>', 'Pkg', 'New0000001'), '<tizen:application id="New0000001.App" package="New0000001"/>', 'config.xml');
eq(r('launch("Pkg.svc"); PkgX Pkg1 xPkg _Pkg_', 'Pkg', 'N'), 'launch("N.svc"); PkgX Pkg1 xPkg _N_', 'whole tokens only');
eq(r('nothing here', 'Pkg', 'N'), null, 'no match is no change');
eq(r('éPkgé', 'Pkg', 'N'), 'éNé', 'non-ASCII neighbours');

// ---- the rewrite ----
var dir = path.join(os.tmpdir(), 'a2s-pkgid-' + process.pid + '-' + Date.now()); fs.mkdirSync(dir);
var CONFIG = '﻿<?xml version="1.0"?><widget xmlns="http://www.w3.org/ns/widgets" xmlns:tizen="http://tizen.org/ns/widgets" version="2.0.0"><name>tacplayer</name>'
    + '<tizen:application id="AprZAARz4r.Jellyfin" package="AprZAARz4r" required_version="3.0"/><tizen:service id="AprZAARz4r.bg" type="service"><tizen:content src="service.js"/></tizen:service></widget>';
var ICON = Buf.from([0x89, 0x50, 0x4e, 0x47, 0x41, 0x70, 0x72, 0x5a, 0x41, 0x41, 0x52, 0x7a, 0x34, 0x72]);   // the id's bytes inside a binary file
var inFile = path.join(dir, 'in.wgt'), outFile = path.join(dir, 'out.wgt');
fs.writeFileSync(inFile, zip.write([
    { name: 'config.xml', data: Buf.from(CONFIG, 'utf8') },
    { name: 'author-signature.xml', data: Buf.from('<Signature/>') },
    { name: 'signature1.xml', data: Buf.from('<Signature/>') },
    { name: 'js/main.js', data: Buf.from('tizen.application.launch("AprZAARz4r.bg"); var AprZAARz4rX = 1;') },
    { name: 'icon.png', data: ICON },
    { name: 'index.html', data: Buf.from('<html></html>') }
]));
pkgid.rewrite(inFile, outFile, 'AprZAARz4r', TAC, function (err, res) {
    if (err) fail('rewrite: ' + err.message);
    eq(res.files.sort(), ['config.xml', 'js/main.js'], 'the files that changed');
    var got = {}; zip.readEntries(fs.readFileSync(outFile)).forEach(function (e) { got[e.name] = e.data; });
    if (got['author-signature.xml'] || got['signature1.xml']) fail('signatures must be dropped');
    var cfg = got['config.xml'].toString('utf8');
    if (cfg.charCodeAt(0) !== 0xfeff) fail('the BOM must stay');
    if (cfg.indexOf('id="' + TAC + '.Jellyfin" package="' + TAC + '"') < 0 || cfg.indexOf('<tizen:service id="' + TAC + '.bg"') < 0 || cfg.indexOf('AprZAARz4r') >= 0) fail('config.xml: ' + cfg);
    eq(got['js/main.js'].toString('utf8'), 'tizen.application.launch("' + TAC + '.bg"); var AprZAARz4rX = 1;', 'app code that launches its service');
    if (!got['icon.png'].equals(ICON)) fail('a binary file must stay as it was');
    manifest.read(outFile, function (err, ids) {
        if (err) fail('the renamed package must read: ' + err.message);
        eq([ids.packageId, ids.appId, ids.names], [TAC, TAC + '.Jellyfin', ['tacplayer']], 'the renamed manifest');
        pkgid.rewrite(inFile, path.join(dir, 'x.wgt'), 'NotInIt001', TAC, function (err) {
            if (!err || !/config\.xml does not name/.test(err.message)) fail('a config.xml without the id must refuse: ' + (err && err.message));
            try { fs.readdirSync(dir).forEach(function (f) { fs.unlinkSync(path.join(dir, f)); }); fs.rmdirSync(dir); } catch (e) {}
            console.log('PASS: derived ids match the shared scheme, catalog keys, the decision, whole-token replace, rewrite with services and app code');
        });
    });
});
