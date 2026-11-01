/* manifest.js reads the ids of a .wgt (config.xml) and a .tpk (tizen-manifest.xml) from the
 * package on disk, with the Tizen version each asks for (#47), and says what is wrong with
 * anything else. needsNewer is the version check the service gates an install on. */
'use strict';
var fs = require('fs'), os = require('os'), path = require('path');
var zip = require('../tizen-app/service/zip.js');
var manifest = require('../tizen-app/service/manifest.js');
var Buf = require('../tizen-app/service/compat.js');

function fail(m) { console.error('FAIL: ' + m); process.exit(1); }
var dir = path.join(os.tmpdir(), 'a2s-manifest-' + process.pid + '-' + Date.now()); fs.mkdirSync(dir);   // no mkdtempSync on the TV's Node 4
function pkg(name, entries) { var f = path.join(dir, name); fs.writeFileSync(f, zip.write(entries)); return f; }

var wgt = pkg('a.wgt', [
    { name: 'index.html', data: Buf.from('<html></html>') },
    { name: 'config.xml', data: Buf.from('<?xml version="1.0"?><widget xmlns="http://www.w3.org/ns/widgets" xmlns:tizen="http://tizen.org/ns/widgets" id="https://x" version="1.2.3"><name>VPN Probe</name>\n  <tizen:application id="A2SProbeV1.Probe" package="A2SProbeV1" required_version="4.0"/>\n  <tizen:privilege name="http://tizen.org/privilege/internet"/>\n  <tizen:privilege name="http://tizen.org/privilege/vpnservice"/>\n  <tizen:privilege name="http://tizen.org/privilege/internet"/></widget>') }
]);
var tpk = pkg('b.tpk', [
    { name: 'bin/app', data: Buf.from('x') },
    { name: 'tizen-manifest.xml', data: Buf.from('<?xml version="1.0" encoding="utf-8"?><manifest xmlns="http://tizen.org/ns/packages" api-version="4.0" package="org.apps2samsung.overscan" version="0.2.0"><ui-application appid="org.apps2samsung.overscan.app" exec="app" type="capp"><label>Overscan</label></ui-application><privileges><privilege>http://tizen.org/privilege/display</privilege></privileges></manifest>') }
]);
var noManifest = pkg('c.wgt', [{ name: 'index.html', data: Buf.from('<html></html>') }]);
var notZip = path.join(dir, 'd.wgt'); fs.writeFileSync(notZip, 'hello');

manifest.read(wgt, function (err, ids) {
    if (err) fail('wgt: ' + err.message);
    if (ids.kind !== 'wgt' || ids.appId !== 'A2SProbeV1.Probe' || ids.packageId !== 'A2SProbeV1' || ids.version !== '1.2.3' || ids.name !== 'VPN Probe' || ids.requiredVersion !== '4.0') fail('wgt ids ' + JSON.stringify(ids));
    // Privileges (#50): each once, and vpnservice is partner-level.
    if (ids.privileges.join() !== 'http://tizen.org/privilege/internet,http://tizen.org/privilege/vpnservice' || ids.partner !== true) fail('wgt privileges ' + JSON.stringify(ids));
    manifest.read(tpk, function (err, ids) {
        if (err) fail('tpk: ' + err.message);
        if (ids.kind !== 'tpk' || ids.appId !== 'org.apps2samsung.overscan.app' || ids.packageId !== 'org.apps2samsung.overscan' || ids.version !== '0.2.0' || ids.name !== 'Overscan' || ids.requiredVersion !== '4.0') fail('tpk ids ' + JSON.stringify(ids));
        if (ids.privileges.join() !== 'http://tizen.org/privilege/display' || ids.partner !== false) fail('tpk privileges ' + JSON.stringify(ids));
        var plain = manifest.parse('wgt', '<widget version="1"><tizen:application id="A.b" package="A"/><tizen:privilege name="http://tizen.org/privilege/internet"/></widget>');
        if (plain.partner !== false || plain.privileges.length !== 1) fail('a public-only manifest: ' + JSON.stringify(plain));
        // Only partner-level privileges flag (#50 follow-up): not Public-level ones that sound restricted
        // (drmplay, drminfo, externalstorage, datasharing), not Platform-level ones a Partner certificate
        // does not cover either (package management, system settings).
        ['http://tizen.org/privilege/vpnservice', 'http://tizen.org/privilege/appmanager.kill', 'http://developer.samsung.com/privilege/sso.partner'].forEach(function (p) {
            if (!manifest.needsPartner([p]) || !manifest.needsPartner(['http://tizen.org/privilege/internet', p])) fail('needsPartner must flag ' + p);
        });
        ['http://developer.samsung.com/privilege/network.public', 'http://developer.samsung.com/privilege/drmplay', 'http://developer.samsung.com/privilege/drminfo',
         'http://tizen.org/privilege/externalstorage', 'http://tizen.org/privilege/datasharing', 'http://tizen.org/privilege/packagemanager.admin', 'http://tizen.org/privilege/systemsettings.admin'].forEach(function (p) {
            if (manifest.needsPartner([p])) fail('needsPartner must not flag ' + p);
        });
        if (manifest.needsPartner([]) || manifest.needsPartner(null)) fail('needsPartner with nothing');
        var noReq = manifest.parse('wgt', '<widget version="1"><tizen:application id="A.b" package="A"/></widget>');
        if (noReq.requiredVersion !== '') fail('a manifest without required_version must give \'\', got ' + JSON.stringify(noReq.requiredVersion));
        // The gate: 6.0 on a 4.0 set is refused, 2.3 on 4.0 and 4.0 on 4.0 are not, unknown on either side is not (#44).
        [['6.0', '4.0', true], ['6.0', '4.0.0', true], ['5.5', '5.0', true], ['2.3', '4.0', false], ['4.0', '4.0', false], ['4.0', '10.0', false], ['', '4.0', false], ['6.0', '', false], ['6.0', 'x', false]].forEach(function (c) {
            if (manifest.needsNewer(c[0], c[1]) !== c[2]) fail('needsNewer(' + JSON.stringify(c[0]) + ', ' + JSON.stringify(c[1]) + ') must be ' + c[2]);
        });
        manifest.read(noManifest, function (err) {
            if (!err || err.message.indexOf('no config.xml') < 0) fail('a package without a manifest must be refused: ' + (err && err.message));
            manifest.read(notZip, function (err) {
                if (!err || err.message.indexOf('not a Tizen package') < 0) fail('a non-zip must be refused: ' + (err && err.message));
                try { fs.readdirSync(dir).forEach(function (f) { fs.unlinkSync(path.join(dir, f)); }); fs.rmdirSync(dir); } catch (e) {}
                console.log('PASS: manifest ids, required Tizen and privileges read from a .wgt and a .tpk; needsNewer gate; partner-level privileges; no manifest and not-a-zip refused');
            });
        });
    });
});
