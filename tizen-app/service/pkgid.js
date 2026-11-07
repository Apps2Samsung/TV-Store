/* One app under its own package id when another app already has that id on the TV (#84).
 *
 * Forks often keep upstream's package id: tacplayer ships the official Jellyfin id AprZAARz4r, so
 * installing it would replace the Jellyfin on the TV, data and all. When the TV has an app with
 * the package's id and a different name, a .wgt goes on under an id of its own instead, and a .tpk
 * (native code may hardcode its own paths) is refused with the name of the app it would replace.
 *
 * The new id is the same on every client, so an app renamed by TV-Store is found and updated by
 * Apps2Samsung and the other way round (Apps2Samsung#1028): the first 10 characters of
 * base62(sha256("a2s-pkgid-v1:" + key)), one character per byte (byte % 62, alphabet 0-9A-Za-z).
 * The key names the catalog entry, so it does not change between versions:
 *   - official catalog, community package: the entry's repo, "/", its file ("owner/name/App.wgt");
 *   - official catalog, a provider of its own: owner/name from its GitHub releases URL, "/", the
 *     release asset's name;
 *   - an independent repository (#82): the repository's URL (the repository.json.signed one it was
 *     added under), "/", the asset's name.
 *
 * The rewrite is what Apps2Samsung's PackageIdRewriter does: the old id is replaced as a whole
 * token (not inside a longer run of letters and digits) in config.xml and every text file of the
 * package, which covers the application id and package, the service components' ids, and an app
 * that launches its own service by id. Signatures are dropped; the package is signed afterwards
 * as every install is. Works on files, one entry at a time, like the signer. ES5 for Node 4.4.3. */
'use strict';
var crypto = require('crypto');
var zip = require('./zip.js');
var Buf = require('./compat.js');

var ALPHABET = '0123456789ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz';
var PREFIX = 'a2s-pkgid-v1:';

// The package id a rename gives the catalog entry `key`.
function derive(key) {
    var d = crypto.createHash('sha256').update(Buf.from(PREFIX + key, 'utf8')).digest(), out = '';
    for (var i = 0; i < 10; i++) out += ALPHABET.charAt(d[i] % 62);
    return out;
}

// "owner/name" from a GitHub API releases URL (https://api.github.com/repos/owner/name/releases...), else ''.
function githubRepo(u) {
    var m = /\/repos\/([^\/?#]+)\/([^\/?#]+)/.exec(String(u || ''));
    return m ? m[1] + '/' + m[2] : '';
}
// The key of one file: where its catalog entry lives, then the file's name; '' when either is missing.
function key(where, file) { return where && file ? where + '/' + file : ''; }

function isValidId(id) { return /^[A-Za-z0-9]+$/.test(String(id || '')); }
function norm(n) { return String(n || '').replace(/\s+/g, ' ').trim().toLowerCase(); }
// The same app: a name in common, case and spacing aside. No name on either side counts as the
// same, so a package or a TV that says nothing keeps the behaviour from before #84.
function sameName(a, b) {
    var x = (a || []).map(norm).filter(Boolean), y = (b || []).map(norm).filter(Boolean);
    if (!x.length || !y.length) return true;
    for (var i = 0; i < x.length; i++) if (y.indexOf(x[i]) >= 0) return true;
    return false;
}
function onTv(tv, id) { return !!id && Object.prototype.hasOwnProperty.call(tv, id); }

// Where a package goes on this TV. o: { kind: 'wgt' | 'tpk', packageId, names (the package's own),
// key (its catalog entry, '' when none), tvApps ({ packageId: [names] } of what the TV has; null
// when the page did not say), renames (the ones made on this TV, newest last) }. Returns
//   { keep: true }                           its own id: not on the TV, or the same app (an update);
//   { rename: id, why: 'update' }            a copy renamed before is on the TV: update that one;
//   { rename: id, why: 'collision', other }  another app has the id: install beside it;
//   { taken: otherName }                     another app has the id and the package cannot be renamed.
function decide(o) {
    var tv = o.tvApps, pkg = o.packageId;
    if (!tv || !isValidId(pkg)) return { keep: true };
    var newId = o.kind === 'wgt' && o.key ? derive(o.key) : '';
    if (newId === pkg) newId = '';
    if (o.kind === 'wgt') {
        // This entry's own renamed copy: whatever it is called now, it is this app.
        if (newId && onTv(tv, newId)) return { rename: newId, why: 'update' };
        // Another build of the same app (a variant in the same group, another file) went on under a
        // renamed id: this one lands on that tile when the names agree.
        var list = o.renames || [];
        for (var i = list.length - 1; i >= 0; i--) {
            var r = list[i];
            if (r.originalPackageId === pkg && r.newPackageId !== pkg && isValidId(r.newPackageId) && onTv(tv, r.newPackageId) && sameName(o.names, tv[r.newPackageId]))
                return { rename: r.newPackageId, why: 'update' };
        }
    }
    if (!onTv(tv, pkg) || sameName(o.names, tv[pkg])) return { keep: true };
    var other = (tv[pkg] || []).filter(Boolean)[0] || pkg;
    if (newId) return { rename: newId, why: 'collision', other: other };
    return { taken: other };
}

// ---- the rewrite ----------------------------------------------------------------------------------
// Files whose bytes can name the package id; media and fonts are left alone. Same list, same size
// limit as Apps2Samsung's PackageIdRewriter.
var TEXT = /\.(xml|js|cjs|mjs|json|html|htm|css|txt)$/i;
var MAX_TEXT = 32 * 1024 * 1024;
function isSignature(name) { return /^(author-signature|signature[0-9]*)\.xml$/i.test(name); }
function alnum(b) { return (b >= 48 && b <= 57) || (b >= 65 && b <= 90) || (b >= 97 && b <= 122); }

// buf with every whole-token `from` replaced by `to` (both ASCII), or null when there is none.
// On bytes, not on decoded text: a file that is not valid UTF-8 comes out unchanged but for the id.
function replaceToken(buf, from, to) {
    var f = Buf.from(from, 'ascii'), t = Buf.from(to, 'ascii'), parts = [], last = 0, at = 0, hit = false;
    while ((at = buf.indexOf(f, at)) >= 0) {
        var end = at + f.length;
        if ((at > 0 && alnum(buf[at - 1])) || (end < buf.length && alnum(buf[end]))) { at = end; continue; }
        parts.push(buf.slice(last, at), t);
        last = at = end; hit = true;
    }
    if (!hit) return null;
    parts.push(buf.slice(last));
    return Buffer.concat(parts);
}

function readEntry(file, e, cb) {
    var chunks = [], done = false, st = zip.entryStream(file, e);
    function fin(err, b) { if (done) return; done = true; cb(err, b); }
    st.on('data', function (d) { chunks.push(d); });
    st.on('error', fin);
    st.on('end', function () { fin(null, Buffer.concat(chunks)); });
}

// Writes the package at inFile to outFile under newId. cb(err, { from, to, files }) with files the
// entries that changed. Refused when config.xml does not name the old id: a package that would
// still declare it is no rename at all.
function rewrite(inFile, outFile, oldId, newId, cb) {
    if (!isValidId(oldId) || !isValidId(newId) || oldId === newId) return cb(new Error('cannot rename package ' + oldId + ' to ' + newId));
    var entries;
    try { entries = zip.readCentral(inFile); } catch (e) { return cb(e); }
    var items = [], changed = [], i = 0;
    (function next() {
        if (i === entries.length) {
            if (changed.indexOf('config.xml') < 0) return cb(new Error('config.xml does not name ' + oldId + ', so the package cannot be renamed'));
            try { zip.writeFile(outFile, items); } catch (e) { return cb(e); }
            return cb(null, { from: oldId, to: newId, files: changed });
        }
        var e = entries[i++];
        if (isSignature(e.name)) return next();
        if (e.dir || !TEXT.test(e.name) || !e.uncompSize || e.uncompSize > MAX_TEXT) { items.push({ name: e.name, from: inFile, entry: e }); return next(); }
        readEntry(inFile, e, function (err, buf) {
            if (err) return cb(new Error('cannot read ' + e.name + ' from the package: ' + err.message));
            var out = replaceToken(buf, oldId, newId);
            if (out) { items.push({ name: e.name, data: out }); changed.push(e.name); }
            else items.push({ name: e.name, from: inFile, entry: e });
            setImmediate(next);
        });
    })();
}

module.exports = { derive: derive, githubRepo: githubRepo, key: key, sameName: sameName, decide: decide, replaceToken: replaceToken, rewrite: rewrite, isValidId: isValidId };
