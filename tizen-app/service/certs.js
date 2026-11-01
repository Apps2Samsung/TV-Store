/* The signing certificates a head hands over (#844), all of them (#44): a phone or PC holds more
 * than one profile (Public and Partner, a bundled one for older sets, imported ones), and an app
 * installed from it was signed with one of them. A Samsung TV only updates an app with the author
 * certificate it was installed with, so TV-Store keeps every profile it is given, remembers which
 * one each package took, and on a mismatch tries the next before it ever offers to remove the app.
 *
 * Each profile also has a privilege level (#50): a Samsung distributor certificate is issued by
 * "VD DEVELOPER Public CA Class" or "VD DEVELOPER Partner CA Class", and an app that uses
 * partner-level rights (drmplay, sso.partner, a vpnservice) only works when it was signed with a
 * Partner one. The level is read from the chain the head sends, so a TV armed before this
 * version knows it too, and an install asks for the level the app needs (certs.order).
 *
 * Stored shape (CERT_NAME in the data folder):
 *   { primary: <id>, certificates: [ { id, name, level, authorKeyPem, authorCertPem, distributorKeyPem, distributorCertPem } ] }
 * id is the SHA-256 of the author leaf certificate (DER), so the same profile handed over twice,
 * or by two heads, is one entry. A 0.3.x file holding one bare profile is read as a one-entry store.
 * Pure, ES5, Node 4: test/certs.test.js. */
'use strict';
var crypto = require('crypto');
var Buf = require('./compat.js');

var FIELDS = ['authorKeyPem', 'authorCertPem', 'distributorKeyPem', 'distributorCertPem'];

function complete(c) { return !!c && FIELDS.every(function (f) { return typeof c[f] === 'string' && c[f].length > 0; }); }

// The author leaf's SHA-256 (hex), the id a profile is known by; '' when the PEM holds no certificate.
function fingerprint(authorCertPem) {
    var m = /-----BEGIN CERTIFICATE-----([\s\S]*?)-----END CERTIFICATE-----/.exec(String(authorCertPem || ''));
    if (!m) return '';
    return crypto.createHash('sha256').update(Buf.from(m[1].replace(/\s+/g, ''), 'base64')).digest('hex');
}

// The privilege level of a distributor chain: 'public' | 'partner' | 'unknown'. Samsung's CA
// names sit as plain text inside the DER (the leaf's issuer, the intermediate's subject), so no
// X.509 parser is needed, which the TV's Node has none of. 'unknown' for a chain from elsewhere
// (a Tizen Studio certificate, the test fixtures), which is treated as public: that is what
// nearly every profile is, and the TV has the last word on the package anyway.
var LEVEL_MARKS = [['partner', 'VD DEVELOPER Partner CA'], ['public', 'VD DEVELOPER Public CA']];
function level(distributorCertPem) {
    var re = /-----BEGIN CERTIFICATE-----([\s\S]*?)-----END CERTIFICATE-----/g, m, text = '';
    while ((m = re.exec(String(distributorCertPem || ''))) !== null) text += Buf.from(m[1].replace(/\s+/g, ''), 'base64').toString('binary');
    for (var i = 0; i < LEVEL_MARKS.length; i++) if (text.indexOf(LEVEL_MARKS[i][1]) >= 0) return LEVEL_MARKS[i][0];
    return 'unknown';
}
// Whether a profile is what `want` ('public' | 'partner') asks for. 'public' is only ever asked
// for by hand (Sign with: Public on the TV), so it means exactly that; an unknown chain counts as
// public. Without a wish, order() takes any profile.
function serves(c, want) { return want === 'partner' ? c.level === 'partner' : c.level !== 'partner'; }

function entry(c, i) {
    var id = fingerprint(c.authorCertPem);
    if (!id) return null;
    return { id: id, name: String(c.name || ('certificate ' + (i + 1))).slice(0, 80), level: level(c.distributorCertPem),
             authorKeyPem: c.authorKeyPem, authorCertPem: c.authorCertPem, distributorKeyPem: c.distributorKeyPem, distributorCertPem: c.distributorCertPem };
}

// What POST /cert carries, as a list, the head's first choice first: `certificates: [...]` (3.2+),
// and / or the four fields at the top level (every head since 0.2.0; a 3.2+ head sends both, and
// the named entry in the list is the one kept). [] when nothing is usable.
function normalize(body) {
    var out = [], seen = {};
    function add(c, i) { var e = complete(c) ? entry(c, i) : null; if (e && !seen[e.id]) { seen[e.id] = true; out.push(e); } }
    if (body && Array.isArray(body.certificates)) body.certificates.forEach(add);
    if (body && complete(body)) { var top = entry(body, out.length); if (top && !seen[top.id]) out.unshift(top); }
    return out;
}

// The store after a hand-over: incoming profiles replace the stored ones with the same id and
// come first, the rest stays (a second phone or PC adds its profiles instead of wiping the first's).
function merge(stored, incoming) {
    var list = incoming.slice(), seen = {};
    list.forEach(function (c) { seen[c.id] = true; });
    ((stored && stored.certificates) || []).forEach(function (c) { if (c && c.id && !seen[c.id]) { seen[c.id] = true; list.push(c); } });
    return { primary: list.length ? list[0].id : null, certificates: list };
}

// A file written by 0.3.x (one bare profile) or by this version.
function fromStored(obj) {
    if (!obj) return null;
    if (Array.isArray(obj.certificates)) return merge(null, normalize(obj));
    return complete(obj) ? merge(null, normalize(obj)) : null;
}

// The profiles to try for a package, in order: the one it took last time (when still here), the
// head's first choice, then the rest. [] when the TV has none.
// With `want` ('public' | 'partner', #50) only the profiles of that level, in the same order; a
// package that needs Partner rights is never signed Public just because Public was tried first,
// and a package installed Public that now wants Partner is a certificate mismatch on the TV (the
// Partner profile has its own author), which the page answers with "remove the old copy first".
// [] when none serves, which the caller turns into NEEDS_PARTNER.
function order(store, preferredId, want) {
    var list = (store && store.certificates) || [], out = [];
    if (want) list = list.filter(function (c) { return serves(c, want); });
    function push(id) { list.forEach(function (c) { if (c.id === id && out.indexOf(c) < 0) out.push(c); }); }
    if (preferredId) push(preferredId);
    if (store && store.primary) push(store.primary);
    list.forEach(function (c) { if (out.indexOf(c) < 0) out.push(c); });
    return out;
}
// Whether the TV holds a profile that serves `want`.
function has(store, want) { return ((store && store.certificates) || []).some(function (c) { return serves(c, want); }); }

function names(store) { return ((store && store.certificates) || []).map(function (c) { return c.name; }); }
// What the page shows and the log says per profile: [{ name, level }], without the keys.
function summary(store) { return ((store && store.certificates) || []).map(function (c) { return { name: c.name, level: c.level }; }); }

module.exports = { normalize: normalize, merge: merge, fromStored: fromStored, order: order, has: has, names: names, summary: summary, level: level, serves: serves, fingerprint: fingerprint, complete: complete };
