/* The signed catalog (#881): how TV-Store trusts what it downloads without trusting the connection.
 *
 * The Node runtime of a Tizen web service cannot validate today's HTTPS chains (a 2019 Tizen 5.0
 * set answers "unable to get local issuer certificate" for apps2samsung.com), and older sets are
 * worse. So the service fetches over HTTPS without certificate validation and checks the content
 * instead, the way apt does:
 *   - resolved.json.signed is line 1 a base64 RSA-SHA256 signature, then resolved.json byte for
 *     byte, signed by the Apps2Samsung catalog workflow; only the key in catalog-key.js verifies it;
 *   - every package file in it carries its SHA-256 (`digest`, "sha256:<hex>"), and a download is
 *     installed only when its bytes hash to that;
 *   - a package file may name its icon (`icon`, a URL, and `icon_digest`, "sha256:<hex>", #66), and
 *     the icon is shown only when its bytes hash to that (icons.js).
 * Pure functions, so test/catalog.test.js can run them with a throwaway key.
 */
'use strict';
var crypto = require('crypto');

var MAX_AGE_MS = 7 * 24 * 3600 * 1000;   // the workflow re-signs at least twice a day

var Buf = require('./compat.js');
function b64(s) { return Buf.from(s, 'base64'); }

// The .signed envelope, shared with the independent repositories (repos.js): line 1 a base64
// signature, ending within the first 4096 bytes, then the payload. { sig, payload } or null.
function envelope(buf) {
    var nl = -1;
    for (var i = 0; i < buf.length && i < 4096; i++) if (buf[i] === 0x0a) { nl = i; break; }
    if (nl < 0) return null;
    var line = buf.slice(0, nl).toString('ascii').trim();
    if (!/^[A-Za-z0-9+\/]+={0,2}$/.test(line)) return null;
    return { sig: b64(line), payload: buf.slice(nl + 1) };
}
function signatureOk(payload, sig, publicKeyPem) {
    var v = crypto.createVerify('RSA-SHA256');
    v.update(payload);
    try { return v.verify(publicKeyPem, sig); } catch (e) { return false; }
}

// buf: the bytes of resolved.json.signed. Returns { catalog, payload, index } or throws.
function verify(buf, publicKeyPem, now) {
    var env = envelope(buf);
    if (!env) throw new Error('the catalog is not signed (no signature line)');
    var payload = env.payload;
    if (!signatureOk(payload, env.sig, publicKeyPem)) throw new Error('the catalog signature does not match: not installing from it');

    var catalog = JSON.parse(payload.toString('utf8'));
    var at = Date.parse(catalog.generatedAt || '');
    if (!at) throw new Error('the signed catalog has no date');
    if ((now || Date.now()) - at > MAX_AGE_MS) throw new Error('the signed catalog is from ' + catalog.generatedAt + ', more than 7 days old: check the TV’s clock, or the Apps2Samsung catalog workflow');

    var s = scan(catalog);
    return { catalog: catalog, payload: payload, index: s.index, levels: s.levels, icons: s.icons };
}

// One walk over providers -> releases -> assets for the lookups the install and the icons need:
//   index:  download URL -> lower-case hex SHA-256, for every package file the catalog lists;
//   levels: download URL -> 'partner' for every file the catalog says needs a Partner certificate
//           (#50): cert_level on a community package (copied onto each of its files in catalog.json,
//           matched to the release asset by file name) or on a provider (every file of it);
//   icons:  lower-case hex SHA-256 -> icon URL, for every file that names an icon with its hash
//           (#66); an icon without a hash is not listed, so it is never fetched.
function scan(catalog) {
    var index = {}, levels = {}, icons = {};
    (catalog.providers || []).forEach(function (p) {
        var byFile = {};
        ((p.catalog && p.catalog.apps) || []).forEach(function (e) { if (e.file && String(e.cert_level || '').toLowerCase() === 'partner') byFile[e.file] = true; });
        var all = String(p.cert_level || '').toLowerCase() === 'partner';
        (p.releases || []).forEach(function (r) {
            (r.assets || []).forEach(function (a) {
                if (!a.browser_download_url) return;
                var m = /^sha256:([0-9a-fA-F]{64})$/.exec(a.digest || '');
                index[a.browser_download_url] = m ? m[1].toLowerCase() : null;
                if (all || byFile[a.name]) levels[a.browser_download_url] = 'partner';
                var im = /^sha256:([0-9a-fA-F]{64})$/.exec(a.icon_digest || '');
                if (im && typeof a.icon === 'string' && /^https?:\/\//.test(a.icon)) icons[im[1].toLowerCase()] = a.icon;
            });
        });
    });
    return { index: index, levels: levels, icons: icons };
}
function index(catalog) { return scan(catalog).index; }
function levels(catalog) { return scan(catalog).levels; }
function icons(catalog) { return scan(catalog).icons; }

function sha256(buf) { return crypto.createHash('sha256').update(buf).digest('hex'); }

module.exports = { verify: verify, envelope: envelope, signatureOk: signatureOk, scan: scan, index: index, levels: levels, icons: icons, sha256: sha256, MAX_AGE_MS: MAX_AGE_MS };
