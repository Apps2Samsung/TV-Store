/* What a package calls itself (#30): the ids vd_appinstall and the screens need, read from the
 * package's own manifest. A .wgt carries config.xml at its root (<tizen:application id package/>),
 * a .tpk carries tizen-manifest.xml (<manifest package version> with <ui-application appid/>).
 * Also the Tizen version the package asks for (#47): required_version on <tizen:application>,
 * api-version on <manifest>. A TV below it refuses the package with install failed[118, -19]
 * (118019 on a 2018 set, #44), so the service checks before the push.
 * Also the privileges it asks for, and whether any of them needs a Partner certificate (#50).
 * The catalog gives these for its own files; an uploaded file has only itself. Pure, file-based,
 * on the zip reader the signer uses. ES5 for the TV's Node 4.4.3. */
'use strict';
var zip = require('./zip.js');

function attr(xml, tag, name) {
    var tagRe = new RegExp('<' + tag + '\\b([^>]*)>', 'i'), m = tagRe.exec(xml);
    if (!m) return '';
    var a = new RegExp('(?:^|\\s)' + name + '\\s*=\\s*"([^"]*)"', 'i').exec(m[1]);
    return a ? a[1] : '';
}
function text(xml, tag) {
    var m = new RegExp('<' + tag + '\\b[^>]*>([^<]*)<\\/' + tag + '>', 'i').exec(xml);
    return m ? m[1].trim() : '';
}

// Privileges a Partner certificate grants and a Public one does not (#50): Tizen's partner level,
// which on a TV is a VPN, killing other apps or reading their certificates, the system manager,
// Samsung partner sign-in and the TV input device admin. An app that asks for one of these installs
// fine signed Public (Tizen ignores a privilege the certificate does not cover) and then fails at
// the call. A match only makes Partner the first choice when the TV already holds one, never a
// block; the catalog (cert_level) is what says an app cannot do without it.
// The test is what a Partner certificate DOES cover, so two kinds stay out on purpose:
// - Public-level ones that sound restricted: drmplay and drminfo (Samsung lists AVPlay's setDrm as
//   Public), externalstorage, datasharing, bluetooth.admin. Every media app and emulator in the
//   catalog declares the first three and runs Public; flagging them pushed working apps onto Partner.
// - Platform-level ones (packagemanager.install/admin/clearcache, systemsettings.admin,
//   keymanager.admin, bluetoothmanager, telephony.admin, vpnservice.admin): neither certificate a
//   sideloading TV holds covers them, so preferring Partner would only bind the package to the
//   Partner author (a later Public update is then a certificate mismatch) for nothing.
var PARTNER_PRIVILEGES = [
    'http://developer.samsung.com/privilege/sso.partner', 'http://developer.samsung.com/privilege/tvinputdevice.admin',
    'http://tizen.org/privilege/vpnservice', 'http://tizen.org/privilege/appmanager.kill',
    'http://tizen.org/privilege/appmanager.certificate', 'http://tizen.org/privilege/systemmanager'
];
// Every privilege the manifest names: <tizen:privilege name="..."/> in a .wgt, <privilege>...</privilege> in a .tpk.
function privileges(kind, xml) {
    var out = [], re = kind === 'wgt' ? /<tizen:privilege\b[^>]*\bname\s*=\s*"([^"]*)"/gi : /<privilege\b[^>]*>([^<]*)<\/privilege>/gi, m;
    while ((m = re.exec(xml)) !== null) { var v = m[1].trim(); if (v && out.indexOf(v) < 0) out.push(v); }
    return out;
}
function needsPartner(privs) { return (privs || []).some(function (p) { return PARTNER_PRIVILEGES.indexOf(p) >= 0; }); }

// The ids in a manifest's XML: { kind, appId, packageId, version, name, requiredVersion,
// privileges, partner }. Missing ones are ''; partner: a privilege needs a Partner certificate.
function parse(kind, xml) {
    var privs = privileges(kind, xml), partner = needsPartner(privs);
    if (kind === 'wgt') {
        var pkg = attr(xml, 'tizen:application', 'package');
        return { kind: kind, appId: attr(xml, 'tizen:application', 'id'), packageId: pkg, version: attr(xml, 'widget', 'version'), name: text(xml, 'name'),
                 requiredVersion: attr(xml, 'tizen:application', 'required_version'), privileges: privs, partner: partner };
    }
    var p = attr(xml, 'manifest', 'package');
    var appId = attr(xml, 'ui-application', 'appid') || attr(xml, 'service-application', 'appid') || attr(xml, 'widget-application', 'appid') || attr(xml, 'watch-application', 'appid');
    return { kind: kind, appId: appId, packageId: p, version: attr(xml, 'manifest', 'version'), name: text(xml, 'label'),
             requiredVersion: attr(xml, 'manifest', 'api-version'), privileges: privs, partner: partner };
}

// True when a package that asks for Tizen `required` ("6.0") cannot run on a TV at `tv` ("4.0").
// Lenient like the heads: an unknown value on either side is no refusal, the TV has the last word.
function needsNewer(required, tv) {
    var x = String(required || '').match(/\d+/g), y = String(tv || '').match(/\d+/g);
    if (!x || !y) return false;
    for (var i = 0; i < Math.max(x.length, y.length); i++) {
        var p = parseInt(x[i] || '0', 10), q = parseInt(y[i] || '0', 10);
        if (p !== q) return p > q;
    }
    return false;
}

// cb(err, ids) for the package at `file`; err when it is not a zip or has no manifest at its root.
function read(file, cb) {
    var entries;
    try { entries = zip.readCentral(file); } catch (e) { return cb(new Error('not a Tizen package: ' + e.message)); }
    var e = null, kind = null;
    for (var i = 0; i < entries.length; i++) {
        if (entries[i].name === 'config.xml') { e = entries[i]; kind = 'wgt'; break; }
        if (entries[i].name === 'tizen-manifest.xml') { e = entries[i]; kind = 'tpk'; break; }
    }
    if (!e) return cb(new Error('not a Tizen package: no config.xml (web app) or tizen-manifest.xml (native app) at its root'));
    if (e.uncompSize > 1024 * 1024) return cb(new Error('the manifest is unreasonably large'));
    var chunks = [], done = false;
    function fin(err, r) { if (done) return; done = true; cb(err, r); }
    var st = zip.entryStream(file, e);
    st.on('data', function (d) { chunks.push(d); });
    st.on('error', function (err) { fin(new Error('could not read the manifest: ' + err.message)); });
    st.on('end', function () {
        var ids = parse(kind, Buffer.concat(chunks).toString('utf8'));
        if (!ids.appId && !ids.packageId) return fin(new Error('the manifest names no application'));
        fin(null, ids);
    });
}

module.exports = { read: read, parse: parse, needsNewer: needsNewer, needsPartner: needsPartner, PARTNER_PRIVILEGES: PARTNER_PRIVILEGES };
