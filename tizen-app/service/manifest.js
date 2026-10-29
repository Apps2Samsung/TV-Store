/* What a package calls itself (#30): the ids vd_appinstall and the screens need, read from the
 * package's own manifest. A .wgt carries config.xml at its root (<tizen:application id package/>),
 * a .tpk carries tizen-manifest.xml (<manifest package version> with <ui-application appid/>).
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

// The ids in a manifest's XML: { kind, appId, packageId, version, name }. Missing ones are ''.
function parse(kind, xml) {
    if (kind === 'wgt') {
        var pkg = attr(xml, 'tizen:application', 'package');
        return { kind: kind, appId: attr(xml, 'tizen:application', 'id'), packageId: pkg, version: attr(xml, 'widget', 'version'), name: text(xml, 'name') };
    }
    var p = attr(xml, 'manifest', 'package');
    var appId = attr(xml, 'ui-application', 'appid') || attr(xml, 'service-application', 'appid') || attr(xml, 'widget-application', 'appid') || attr(xml, 'watch-application', 'appid');
    return { kind: kind, appId: appId, packageId: p, version: attr(xml, 'manifest', 'version'), name: text(xml, 'label') };
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

module.exports = { read: read, parse: parse };
