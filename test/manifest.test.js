/* manifest.js reads the ids of a .wgt (config.xml) and a .tpk (tizen-manifest.xml) from the
 * package on disk, and says what is wrong with anything else. */
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
    { name: 'config.xml', data: Buf.from('<?xml version="1.0"?><widget xmlns="http://www.w3.org/ns/widgets" xmlns:tizen="http://tizen.org/ns/widgets" id="https://x" version="1.2.3"><name>Nuvio Legacy</name>\n  <tizen:application id="NuvioTV002.Nuvio" package="NuvioTV002" required_version="4.0"/></widget>') }
]);
var tpk = pkg('b.tpk', [
    { name: 'bin/app', data: Buf.from('x') },
    { name: 'tizen-manifest.xml', data: Buf.from('<?xml version="1.0" encoding="utf-8"?><manifest xmlns="http://tizen.org/ns/packages" api-version="4.0" package="org.apps2samsung.overscan" version="0.2.0"><ui-application appid="org.apps2samsung.overscan.app" exec="app" type="capp"><label>Overscan</label></ui-application></manifest>') }
]);
var noManifest = pkg('c.wgt', [{ name: 'index.html', data: Buf.from('<html></html>') }]);
var notZip = path.join(dir, 'd.wgt'); fs.writeFileSync(notZip, 'hello');

manifest.read(wgt, function (err, ids) {
    if (err) fail('wgt: ' + err.message);
    if (ids.kind !== 'wgt' || ids.appId !== 'NuvioTV002.Nuvio' || ids.packageId !== 'NuvioTV002' || ids.version !== '1.2.3' || ids.name !== 'Nuvio Legacy') fail('wgt ids ' + JSON.stringify(ids));
    manifest.read(tpk, function (err, ids) {
        if (err) fail('tpk: ' + err.message);
        if (ids.kind !== 'tpk' || ids.appId !== 'org.apps2samsung.overscan.app' || ids.packageId !== 'org.apps2samsung.overscan' || ids.version !== '0.2.0' || ids.name !== 'Overscan') fail('tpk ids ' + JSON.stringify(ids));
        manifest.read(noManifest, function (err) {
            if (!err || err.message.indexOf('no config.xml') < 0) fail('a package without a manifest must be refused: ' + (err && err.message));
            manifest.read(notZip, function (err) {
                if (!err || err.message.indexOf('not a Tizen package') < 0) fail('a non-zip must be refused: ' + (err && err.message));
                try { fs.readdirSync(dir).forEach(function (f) { fs.unlinkSync(path.join(dir, f)); }); fs.rmdirSync(dir); } catch (e) {}
                console.log('PASS: manifest ids read from a .wgt and a .tpk; no manifest and not-a-zip refused');
            });
        });
    });
});
