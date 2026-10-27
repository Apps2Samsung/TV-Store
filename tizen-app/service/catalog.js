/* The signed catalog (#881): how TV-Store trusts what it downloads without trusting the connection.
 *
 * The Node runtime of a Tizen web service cannot validate today's HTTPS chains (a 2019 Tizen 5.0
 * set answers "unable to get local issuer certificate" for apps2samsung.com), and older sets are
 * worse. So the service fetches over HTTPS without certificate validation and checks the content
 * instead, the way apt does:
 *   - resolved.json.signed is line 1 a base64 RSA-SHA256 signature, then resolved.json byte for
 *     byte, signed by the Apps2Samsung catalog workflow; only the key in catalog-key.js verifies it;
 *   - every package file in it carries its SHA-256 (`digest`, "sha256:<hex>"), and a download is
 *     installed only when its bytes hash to that.
 * Pure functions, so test/catalog.test.js can run them with a throwaway key.
 */
'use strict';
var crypto = require('crypto');

var MAX_AGE_MS = 7 * 24 * 3600 * 1000;   // the workflow re-signs at least twice a day

var Buf = require('./compat.js');
function b64(s) { return Buf.from(s, 'base64'); }

// buf: the bytes of resolved.json.signed. Returns { catalog, payload, index } or throws.
function verify(buf, publicKeyPem, now) {
    var nl = -1;
    for (var i = 0; i < buf.length && i < 4096; i++) if (buf[i] === 0x0a) { nl = i; break; }
    if (nl < 0) throw new Error('the catalog is not signed (no signature line)');
    var sig = b64(buf.slice(0, nl).toString('ascii').trim());
    var payload = buf.slice(nl + 1);

    var v = crypto.createVerify('RSA-SHA256');
    v.update(payload);
    if (!v.verify(publicKeyPem, sig)) throw new Error('the catalog signature does not match: not installing from it');

    var catalog = JSON.parse(payload.toString('utf8'));
    var at = Date.parse(catalog.generatedAt || '');
    if (!at) throw new Error('the signed catalog has no date');
    if ((now || Date.now()) - at > MAX_AGE_MS) throw new Error('the signed catalog is from ' + catalog.generatedAt + ', more than 7 days old: check the TV’s clock, or the Apps2Samsung catalog workflow');

    return { catalog: catalog, payload: payload, index: index(catalog) };
}

// Download URL -> lower-case hex SHA-256, for every package file the catalog lists.
function index(catalog) {
    var out = {};
    (catalog.providers || []).forEach(function (p) {
        (p.releases || []).forEach(function (r) {
            (r.assets || []).forEach(function (a) {
                var m = /^sha256:([0-9a-fA-F]{64})$/.exec(a.digest || '');
                if (a.browser_download_url) out[a.browser_download_url] = m ? m[1].toLowerCase() : null;
            });
        });
    });
    return out;
}

function sha256(buf) { return crypto.createHash('sha256').update(buf).digest('hex'); }

module.exports = { verify: verify, index: index, sha256: sha256, MAX_AGE_MS: MAX_AGE_MS };
