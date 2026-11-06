/* The signing certificates a head hands over (#844), all of them (#44): a phone or PC holds more
 * than one profile (Public and Partner, a bundled one for older sets, imported ones), and an app
 * installed from it was signed with one of them. A Samsung TV only updates an app with the author
 * certificate it was installed with, so TV-Store keeps every profile it is given, remembers which
 * one each package took, and on a mismatch tries the next before it ever offers to remove the app.
 *
 * Each profile also has a privilege level (#50): a Samsung distributor certificate is issued by
 * "VD DEVELOPER Public CA Class" or "VD DEVELOPER Partner CA Class", and an app that uses
 * partner-level rights (a VPN, Samsung partner sign-in, killing other apps; manifest.js has the
 * list) only works when it was signed with a Partner one. The level is read from the chain the head sends, so a TV armed before this
 * version knows it too, and an install asks for the level the app needs (certs.order).
 *
 * Stored shape (CERT_NAME in the data folder):
 *   { primary: <id>, tvDefault: <id> | null, certificates: [ { id, name, level, validUntil, distributorValidUntil, deviceIds,
 *     authorKeyPem, authorCertPem, distributorKeyPem, distributorCertPem } ] }
 * id is the SHA-256 of the author leaf certificate (DER), so the same profile handed over twice,
 * or by two heads, is one entry. A 0.3.x file holding one bare profile is read as a one-entry store.
 * primary is the profile tried first when a package has none of its own. A hand-over makes the
 * head's first choice primary, unless the user picked one in Settings on the TV (#78): that pick is
 * kept as tvDefault and wins every later hand-over until it is changed or removed on the TV.
 * validUntil, distributorValidUntil and deviceIds are read from the certificates (certInfo) and
 * only shown; the TV is what refuses an expired profile or one that does not list its DUID.
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

// A minimal DER walk (#78): Node 4 on the TV has no X.509 parser, and the two things Settings
// shows besides the level sit at fixed places in a certificate: the validity's notAfter, and the
// subjectAltName extension, where a Samsung distributor certificate lists the DUIDs it covers as
// URIs "URN:tizen:deviceid=<DUID>". Every read is bounds-checked; a certificate it cannot walk
// gives { validUntil: '', deviceIds: [] }, which the page shows as not known.
function tlv(b, off, end) {
    if (off + 2 > end) throw new Error('short DER');
    var tag = b[off], len = b[off + 1], hdr = 2;
    if (len & 0x80) {
        var n = len & 0x7f; if (n < 1 || n > 4 || off + 2 + n > end) throw new Error('bad DER length');
        len = 0; for (var i = 0; i < n; i++) len = len * 256 + b[off + 2 + i];
        hdr += n;
    }
    if (off + hdr + len > end) throw new Error('DER past its end');
    return { tag: tag, start: off + hdr, end: off + hdr + len };
}
function kids(b, node) { var out = [], off = node.start; while (off < node.end) { var k = tlv(b, off, node.end); out.push(k); off = k.end; } return out; }
// UTCTime (YYMMDDHHMMSSZ, 50 and up is 19xx) or GeneralizedTime (YYYYMMDDHHMMSSZ) as an ISO string.
function derTime(b, node) {
    var s = b.slice(node.start, node.end).toString('binary');
    var m = node.tag === 0x17 ? /^(\d\d)(\d\d)(\d\d)(\d\d)(\d\d)(\d\d)Z$/.exec(s) : /^(\d{4})(\d\d)(\d\d)(\d\d)(\d\d)(\d\d)Z$/.exec(s);
    if (!m) return '';
    var y = parseInt(m[1], 10); if (node.tag === 0x17) y += y < 50 ? 2000 : 1900;
    return new Date(Date.UTC(y, parseInt(m[2], 10) - 1, parseInt(m[3], 10), parseInt(m[4], 10), parseInt(m[5], 10), parseInt(m[6], 10))).toISOString();
}
var SAN_OID = '551d11';   // 2.5.29.17, subjectAltName
function certInfo(pem) {
    var out = { validUntil: '', deviceIds: [] };
    var m = /-----BEGIN CERTIFICATE-----([\s\S]*?)-----END CERTIFICATE-----/.exec(String(pem || ''));
    if (!m) return out;
    try {
        var b = Buf.from(m[1].replace(/\s+/g, ''), 'base64');
        var tbs = kids(b, kids(b, tlv(b, 0, b.length))[0]);
        var i = tbs[0].tag === 0xa0 ? 1 : 0;   // [0] version, absent in a v1 certificate
        var validity = tbs[i + 3];
        if (validity && validity.tag === 0x30) { var t = kids(b, validity)[1]; if (t) out.validUntil = derTime(b, t); }
        tbs.forEach(function (n) {
            if (n.tag !== 0xa3) return;
            kids(b, kids(b, n)[0]).forEach(function (ext) {
                var f = kids(b, ext);
                if (!f.length || b.slice(f[0].start, f[0].end).toString('hex') !== SAN_OID) return;
                var names = f[f.length - 1], seq = tlv(b, names.start, names.end);
                kids(b, seq).forEach(function (g) {
                    if (g.tag !== 0x86) return;   // [6] uniformResourceIdentifier
                    var d = /^URN:tizen:deviceid=(.+)$/i.exec(b.slice(g.start, g.end).toString('binary'));
                    if (d && out.deviceIds.indexOf(d[1].trim()) < 0) out.deviceIds.push(d[1].trim());
                });
            });
        });
    } catch (e) {}
    return out;
}

function entry(c, i) {
    var id = fingerprint(c.authorCertPem);
    if (!id) return null;
    var author = certInfo(c.authorCertPem), dist = certInfo(c.distributorCertPem);
    return { id: id, name: String(c.name || ('certificate ' + (i + 1))).slice(0, 80), level: level(c.distributorCertPem),
             validUntil: author.validUntil, distributorValidUntil: dist.validUntil, deviceIds: dist.deviceIds,
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

function holds(list, id) { return !!id && list.some(function (c) { return c.id === id; }); }
// The store after a hand-over: incoming profiles replace the stored ones with the same id and
// come first, the rest stays (a second phone or PC adds its profiles instead of wiping the first's).
// The head's first choice becomes primary, unless a default picked on the TV is still here (#78).
function merge(stored, incoming) {
    var list = incoming.slice(), seen = {};
    list.forEach(function (c) { seen[c.id] = true; });
    ((stored && stored.certificates) || []).forEach(function (c) { if (c && c.id && !seen[c.id]) { seen[c.id] = true; list.push(c); } });
    var tvDefault = stored && holds(list, stored.tvDefault) ? stored.tvDefault : null;
    return { primary: tvDefault || (list.length ? list[0].id : null), tvDefault: tvDefault, certificates: list };
}

// A file written by 0.3.x (one bare profile) or by this version. The stored primary and TV-side
// default stay when their profile is still in the file.
function fromStored(obj) {
    if (!obj) return null;
    if (!Array.isArray(obj.certificates) && !complete(obj)) return null;
    var list = normalize(obj);
    var tvDefault = holds(list, obj.tvDefault) ? obj.tvDefault : null;
    return { primary: tvDefault || (holds(list, obj.primary) ? obj.primary : list.length ? list[0].id : null), tvDefault: tvDefault, certificates: list };
}

// Settings on the TV (#78): make a profile the default, which every later hand-over keeps; null
// when the store has no profile with that id.
function setDefault(store, id) {
    var list = (store && store.certificates) || [];
    if (!holds(list, id)) return null;
    return { primary: id, tvDefault: id, certificates: list.slice() };
}
// Settings on the TV (#78): drop a profile. A default picked on the TV goes with it, and the first
// that is left becomes primary when the removed one was. null when there is no such profile.
function remove(store, id) {
    var list = (store && store.certificates) || [];
    if (!holds(list, id)) return null;
    var rest = list.filter(function (c) { return c.id !== id; });
    var tvDefault = store.tvDefault !== id && holds(rest, store.tvDefault) ? store.tvDefault : null;
    return { primary: tvDefault || (holds(rest, store.primary) ? store.primary : rest.length ? rest[0].id : null), tvDefault: tvDefault, certificates: rest };
}

// The profiles to try for a package, in order: the one it took last time (when still here), the
// head's first choice, then the rest. [] when the TV has none.
// With `want` ('public' | 'partner', #50) only the profiles of that level, in the same order; a
// package that needs Partner rights is never signed Public just because Public was tried first,
// and a package installed Public that now wants Partner is a certificate mismatch on the TV (the
// Partner profile has its own author), which the page answers with "remove the old copy first".
// [] when none serves, which the caller turns into NEEDS_PARTNER.
// want ('public' | 'partner') keeps only the profiles that serve that level: the level is firm.
// prefer moves the profiles that serve it to the front and keeps the rest behind them: the first
// choice, with every other profile still tried after it (#50; a manifest's partner privilege is a
// preference, not a demand, so a copy installed Public from a phone still updates).
function order(store, preferredId, want, prefer) {
    var list = (store && store.certificates) || [], out = [];
    if (want) list = list.filter(function (c) { return serves(c, want); });
    function push(id) { list.forEach(function (c) { if (c.id === id && out.indexOf(c) < 0) out.push(c); }); }
    if (preferredId) push(preferredId);
    if (store && store.primary) push(store.primary);
    list.forEach(function (c) { if (out.indexOf(c) < 0) out.push(c); });
    if (prefer) out = out.filter(function (c) { return serves(c, prefer); }).concat(out.filter(function (c) { return !serves(c, prefer); }));
    return out;
}
// Whether the TV holds a profile that serves `want`.
function has(store, want) { return ((store && store.certificates) || []).some(function (c) { return serves(c, want); }); }

function names(store) { return ((store && store.certificates) || []).map(function (c) { return c.name; }); }
// What the page shows and the log says per profile, never the keys (#78): the id (the head's debug
// log prints its first 12 characters), whether it is the default and whether that was picked on
// the TV, when the author and the distributor certificate run out, and the DUIDs the distributor
// certificate covers.
function summary(store) {
    return ((store && store.certificates) || []).map(function (c) {
        return { id: c.id, name: c.name, level: c.level, primary: c.id === store.primary, chosenOnTv: c.id === store.tvDefault,
                 validUntil: c.validUntil || '', distributorValidUntil: c.distributorValidUntil || '', deviceIds: c.deviceIds || [] };
    });
}

module.exports = { normalize: normalize, merge: merge, fromStored: fromStored, setDefault: setDefault, remove: remove, certInfo: certInfo, order: order, has: has, names: names, summary: summary, level: level, serves: serves, fingerprint: fingerprint, complete: complete };
