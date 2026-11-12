/* Independent signed repositories (#82, spec: tizen-community-packages docs/repositories.md).
 *
 * A developer publishes repository.json.signed (the same envelope as the official
 * resolved.json.signed, catalog.js) and repository.pem next to it. The TV cannot validate HTTPS,
 * so it never trusts a key for where it came from: a source reaches the TV only from Apps2Samsung
 * (which can validate TLS, and where the user approved the key's fingerprint), and the TV checks
 * every manifest against that approved fingerprint. When Apps2Samsung hands over the public key
 * itself, that is the key; when it hands over only the fingerprint, the service fetches
 * repository.pem and keeps it only when its SHA-256 is that fingerprint, which a swapped file can
 * never be.
 *
 * verify() applies every rule of the spec in its order and throws an Error whose `reason` is the
 * spec's reason code (size, no-signature, key, fingerprint, signature, json, schema-version, schema,
 * url, future, expired, rollback, duplicate), plus repository-id when the manifest names another
 * repository than the one approved. test/repos.test.js runs the spec's test vectors through it.
 * Pure functions, ES5 for the TV's Node 4.4.3: RSA-SHA256 is all that Node verifies.
 */
'use strict';
var crypto = require('crypto');
var catalogTrust = require('./catalog.js');
var Buf = require('./compat.js');

var MAX_BYTES = 8 * 1024 * 1024;
var MAX_AGE_MS = 7 * 24 * 3600 * 1000;
var MAX_AHEAD_MS = 3600 * 1000;
var MIN_KEY_BITS = 3072;
var SCHEMA_VERSIONS = [1];
var FLAGS = ['root', 'closed-source', 'self-updating'];
var RSA_OID = '2a864886f70d010101';   // 1.2.840.113549.1.1.1, rsaEncryption

var RE = {
    repoId: /^[a-z0-9]+(?:-[a-z0-9]+)*(?:\.[a-z0-9]+(?:-[a-z0-9]+)*)+$/,
    line: /^[^\n\r|]+$/,
    lineOrEmpty: /^[^\n\r|]*$/,
    https: /^https:\/\/[^\s\/@:]+(?::\d+)?(?:\/\S*)?$/,
    sha256: /^sha256:[0-9a-f]{64}$/,
    date: /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d+)?(?:Z|[+-]\d{2}:\d{2})$/,
    providerId: /^[A-Za-z0-9][A-Za-z0-9_.-]{0,63}$/,
    // Any id the official catalog's categories may hold (tizen-community-packages data/categories.json),
    // not a fixed list: the store shows one it does not know under other.
    category: /^[a-z0-9][a-z0-9_-]{0,31}$/,
    asset: /^[^\/\\]+[.](?:wgt|tpk)$/,
    version: /^\d+(?:\.\d+)*$/,
    fingerprint: /^[0-9a-f]{64}$/
};

function fail(reason, message) { var e = new Error(message); e.reason = reason; return e; }

// ---- keys -----------------------------------------------------------------------------------------
// A DER TLV at pos: { tag, start, end } of its contents, or throws.
function tlv(der, pos) {
    if (pos + 2 > der.length) throw new Error('truncated');
    var tag = der[pos], len = der[pos + 1], hdr = 2;
    if (len & 0x80) {
        var n = len & 0x7f;
        if (n < 1 || n > 4 || pos + 2 + n > der.length) throw new Error('bad length');
        len = 0;
        for (var i = 0; i < n; i++) len = len * 256 + der[pos + 2 + i];
        hdr = 2 + n;
    }
    if (pos + hdr + len > der.length) throw new Error('truncated');
    return { tag: tag, start: pos + hdr, end: pos + hdr + len };
}

// A "PUBLIC KEY" PEM (SubjectPublicKeyInfo): { der, fingerprint, rsa, bits }, or null when it is
// not one. The fingerprint is the SHA-256 of the DER, lower-case hex: what Apps2Samsung shows.
function keyInfo(pem) {
    var m = /-----BEGIN PUBLIC KEY-----([A-Za-z0-9+\/=\s]+)-----END PUBLIC KEY-----/.exec(String(pem || ''));
    if (!m) return null;
    var der = Buf.from(m[1].replace(/\s+/g, ''), 'base64');
    var out = { der: der, fingerprint: crypto.createHash('sha256').update(der).digest('hex'), rsa: false, bits: 0 };
    try {
        var spki = tlv(der, 0); if (spki.tag !== 0x30) return out;
        var alg = tlv(der, spki.start); if (alg.tag !== 0x30) return out;
        var oid = tlv(der, alg.start); if (oid.tag !== 0x06) return out;
        out.rsa = der.slice(oid.start, oid.end).toString('hex') === RSA_OID;
        var bits = tlv(der, alg.end); if (bits.tag !== 0x03 || der[bits.start] !== 0) return out;
        var seq = tlv(der, bits.start + 1); if (seq.tag !== 0x30) return out;
        var n = tlv(der, seq.start); if (n.tag !== 0x02) return out;
        var s = n.start;
        while (s < n.end && der[s] === 0) s++;
        if (s < n.end) { var top = der[s], b = 0; while (top) { b++; top >>= 1; } out.bits = (n.end - s - 1) * 8 + b; }
    } catch (e) {}
    return out;
}

// ---- URLs -----------------------------------------------------------------------------------------
// Why a URL may not appear in a repository, or null: an IP address, localhost, *.local, or a user
// name or password in it.
function urlProblem(u) {
    var m = /^[a-z][a-z0-9+.-]*:\/\/([^\/?#]*)/i.exec(String(u || ''));
    if (!m) return 'is not a URL';
    var auth = m[1];
    if (auth.indexOf('@') >= 0) return 'has a user name or password in it';
    var host = auth.replace(/:\d*$/, '').toLowerCase().replace(/\.$/, '');
    if (!host) return 'has no host';
    if (host.charAt(0) === '[' || host.indexOf(':') >= 0) return 'points at an IP address';
    if (/^\d+(?:\.\d+){0,3}$/.test(host) || /^0x[0-9a-f]+$/.test(host)) return 'points at an IP address';
    if (host === 'localhost' || /\.localhost$/.test(host)) return 'points at localhost';
    if (host === 'local' || /\.local$/.test(host)) return 'points at a .local name';
    return null;
}
function hostOf(u) { var m = /^[a-z][a-z0-9+.-]*:\/\/(?:[^\/?#@]*@)?([^\/?#:]*)/i.exec(String(u || '')); return m ? m[1].toLowerCase() : ''; }

// ---- the schema (spec/repository.schema.json, by hand: no JSON Schema library on Node 4) ----------
function isObj(v) { return !!v && typeof v === 'object' && !Array.isArray(v); }
function isInt(v) { return typeof v === 'number' && isFinite(v) && Math.floor(v) === v; }
function str(v, re, max, min) { return typeof v === 'string' && (!re || re.test(v)) && (max == null || v.length <= max) && v.length >= (min || 0); }

// The first way the manifest breaks the schema, as words, or null. Every URL it holds is pushed
// onto urls for the url rule.
function schemaProblem(m, urls) {
    function url(v, where) { if (!str(v, RE.https, 2048)) return where + ' must be an https:// URL'; urls.push({ where: where, url: v }); return null; }
    if (!isObj(m)) return 'the manifest is not an object';
    var r = m.repository, why;
    if (!isObj(r)) return 'repository is missing';
    if (!str(r.id, RE.repoId, 128)) return 'repository.id must be a reverse-DNS id like io.github.owner.tizen';
    if (!str(r.name, RE.line, 80, 1)) return 'repository.name must be one line of at most 80 characters';
    if (!str(r.maintainer, RE.line, 80, 1)) return 'repository.maintainer must be one line of at most 80 characters';
    if (r.description !== undefined && !str(r.description, RE.line, 300, 1)) return 'repository.description must be one line of at most 300 characters';
    if (r.homepage !== undefined && (why = url(r.homepage, 'repository.homepage'))) return why;
    if (!str(m.generatedAt, RE.date) || isNaN(Date.parse(m.generatedAt))) return 'generatedAt must be an ISO 8601 time with a time zone';
    if (!Array.isArray(m.providers) || m.providers.length < 1 || m.providers.length > 500) return 'providers must list 1 to 500 apps';
    for (var i = 0; i < m.providers.length; i++) {
        var p = m.providers[i], at = 'providers[' + i + ']';
        if (!isObj(p)) return at + ' is not an object';
        if (!str(p.id, RE.providerId)) return at + '.id is not a valid id';
        if (!str(p.category, RE.category)) return at + '.category must be a category id: lower-case letters, digits, - or _';
        if ((why = url(p.url, at + '.url'))) return why;
        if (p.displayName !== undefined && !str(p.displayName, RE.lineOrEmpty, 80)) return at + '.displayName must be one line of at most 80 characters';
        if (p.prefix !== undefined && !str(p.prefix, null, 80)) return at + '.prefix must be text of at most 80 characters';
        if (p.take !== undefined && !(isInt(p.take) && p.take >= 1 && p.take <= 20)) return at + '.take must be 1 to 20';
        if (p.buildInfo !== undefined) {
            if (!isObj(p.buildInfo)) return at + '.buildInfo is not an object';
            if (p.buildInfo.name !== undefined && !str(p.buildInfo.name, RE.line, 80, 1)) return at + '.buildInfo.name must be one line';
            if (p.buildInfo.description !== undefined && !str(p.buildInfo.description, RE.line, 300, 1)) return at + '.buildInfo.description must be one line';
            if (p.buildInfo.previewImage !== undefined && (why = url(p.buildInfo.previewImage, at + '.buildInfo.previewImage'))) return why;
        }
        if (p.source_url !== undefined && (why = url(p.source_url, at + '.source_url'))) return why;
        if (p.adult !== undefined && typeof p.adult !== 'boolean') return at + '.adult must be true or false';
        if (p.flags !== undefined) {
            if (!Array.isArray(p.flags)) return at + '.flags must be a list';
            for (var f = 0; f < p.flags.length; f++) if (FLAGS.indexOf(p.flags[f]) < 0 || p.flags.indexOf(p.flags[f]) !== f) return at + '.flags may hold ' + FLAGS.join(', ') + ', each once';
        }
        if (p.cert_level !== undefined && p.cert_level !== 'public' && p.cert_level !== 'partner') return at + '.cert_level must be public or partner';
        if (p.ok !== undefined && typeof p.ok !== 'boolean') return at + '.ok must be true or false';
        if (p.latestTag !== undefined && typeof p.latestTag !== 'string') return at + '.latestTag must be text';
        if (!Array.isArray(p.releases) || p.releases.length > 20) return at + '.releases must list at most 20 releases';
        for (var j = 0; j < p.releases.length; j++) {
            var rel = p.releases[j], rat = at + '.releases[' + j + ']';
            if (!isObj(rel)) return rat + ' is not an object';
            if (rel.url !== undefined && (why = url(rel.url, rat + '.url'))) return why;
            if (rel.name !== undefined && !str(rel.name, null, 200)) return rat + '.name must be text of at most 200 characters';
            if (!str(rel.tag_name, null, 200, 1)) return rat + '.tag_name is missing';
            if (rel.published_at !== undefined && (typeof rel.published_at !== 'string' || isNaN(Date.parse(rel.published_at)))) return rat + '.published_at must be a time';
            if (rel.draft !== undefined && rel.draft !== false) return rat + ' is a draft';
            if (!Array.isArray(rel.assets) || rel.assets.length < 1 || rel.assets.length > 50) return rat + '.assets must list 1 to 50 files';
            for (var k = 0; k < rel.assets.length; k++) {
                var a = rel.assets[k], aat = rat + '.assets[' + k + ']';
                if (!isObj(a)) return aat + ' is not an object';
                if (!str(a.name, RE.asset, 200)) return aat + '.name must be a .wgt or .tpk file name';
                if ((why = url(a.browser_download_url, aat + '.browser_download_url'))) return why;
                if (!(isInt(a.size) && a.size >= 1 && a.size <= 536870912)) return aat + '.size must be 1 byte to 512 MiB';
                if (!str(a.digest, RE.sha256)) return aat + '.digest must be sha256:<64 lowercase hex>';
                if (a.package_version !== undefined && !str(a.package_version, null, 64)) return aat + '.package_version must be text';
                if (a.app_id !== undefined && !str(a.app_id, null, 128)) return aat + '.app_id must be text';
                if (a.package_id !== undefined && !str(a.package_id, null, 128)) return aat + '.package_id must be text';
                if (a.required_version !== undefined && !str(a.required_version, RE.version)) return aat + '.required_version must be a version like 5.0';
                if ((a.icon === undefined) !== (a.icon_digest === undefined)) return aat + ' must have both icon and icon_digest, or neither';
                if (a.icon !== undefined && (why = url(a.icon, aat + '.icon'))) return why;
                if (a.icon_digest !== undefined && !str(a.icon_digest, RE.sha256)) return aat + '.icon_digest must be sha256:<64 lowercase hex>';
            }
        }
    }
    return null;
}

// Provider ids are unique, and no package_id + package_version comes from two providers.
function duplicateProblem(m) {
    var ids = {}, pkgs = {};
    for (var i = 0; i < m.providers.length; i++) {
        var p = m.providers[i];
        if (ids.hasOwnProperty(p.id)) return 'two providers are called ' + p.id;
        ids[p.id] = true;
        for (var j = 0; j < p.releases.length; j++) for (var k = 0; k < p.releases[j].assets.length; k++) {
            var a = p.releases[j].assets[k];
            if (!a.package_id) continue;
            var key = a.package_id + '\n' + (a.package_version || '');
            if (pkgs.hasOwnProperty(key) && pkgs[key] !== p.id) return a.package_id + (a.package_version ? ' v' + a.package_version : '') + ' is offered by both ' + pkgs[key] + ' and ' + p.id;
            pkgs[key] = p.id;
        }
    }
    return null;
}

// ---- the check ------------------------------------------------------------------------------------
// buf: the bytes of repository.json.signed. o: { publicKeyPem, fingerprint (approved, required),
// repositoryId (approved, optional), notBefore (the last accepted generatedAt, optional), now }.
// Returns { manifest, payload, repository, generatedAt, index, levels, icons, files } or throws with .reason.
function verify(buf, o) {
    o = o || {};
    var now = o.now || Date.now();
    if (!buf || buf.length > MAX_BYTES) throw fail('size', 'the repository is larger than 8 MiB');
    var env = catalogTrust.envelope(buf);
    if (!env) throw fail('no-signature', 'the repository is not signed (no signature line)');
    var key = keyInfo(o.publicKeyPem);
    if (!key || !key.rsa) throw fail('key', 'the repository key is not an RSA public key');
    if (key.bits < MIN_KEY_BITS) throw fail('key', 'the repository key has ' + key.bits + ' bits; at least ' + MIN_KEY_BITS + ' are required');
    if (!o.fingerprint || key.fingerprint !== String(o.fingerprint).toLowerCase()) throw fail('fingerprint', 'the repository key is not the one approved in Apps2Samsung (fingerprint ' + key.fingerprint.slice(0, 16) + '…)');
    if (!catalogTrust.signatureOk(env.payload, env.sig, o.publicKeyPem)) throw fail('signature', 'the repository signature does not match: not installing from it');
    var m;
    try { m = JSON.parse(env.payload.toString('utf8')); } catch (e) { throw fail('json', 'the repository is not JSON: ' + e.message); }
    if (!isObj(m) || SCHEMA_VERSIONS.indexOf(m.schemaVersion) < 0) throw fail('schema-version', 'the repository uses schema version ' + (isObj(m) ? JSON.stringify(m.schemaVersion) : '?') + ', which this TV-Store does not know; update TV-Store');
    var urls = [], why = schemaProblem(m, urls);
    if (why) throw fail('schema', 'the repository is not valid: ' + why);
    for (var i = 0; i < urls.length; i++) {
        var bad = urlProblem(urls[i].url);
        if (bad) throw fail('url', 'the repository is not valid: ' + urls[i].where + ' ' + bad);
    }
    if (o.repositoryId && m.repository.id !== o.repositoryId) throw fail('repository-id', 'the repository calls itself ' + m.repository.id + ', not ' + o.repositoryId + ' as approved');
    var at = Date.parse(m.generatedAt);
    if (at - now > MAX_AHEAD_MS) throw fail('future', 'the repository is dated ' + m.generatedAt + ', more than an hour ahead of this TV’s clock: check the TV’s clock');
    if (now - at > MAX_AGE_MS) throw fail('expired', 'the repository is from ' + m.generatedAt + ', more than 7 days old: its publisher has not re-signed it, or the TV’s clock is wrong');
    if (o.notBefore && at < Date.parse(o.notBefore)) throw fail('rollback', 'the repository is from ' + m.generatedAt + ', older than the one already accepted (' + o.notBefore + '): refused as a rollback');
    if ((why = duplicateProblem(m))) throw fail('duplicate', 'the repository is not valid: ' + why);
    var s = catalogTrust.scan(m);
    return { manifest: m, payload: env.payload, repository: m.repository, generatedAt: m.generatedAt, index: s.index, levels: s.levels, icons: s.icons, files: s.files };
}

// ---- sources as Apps2Samsung hands them over ------------------------------------------------------
// { url, repositoryId, fingerprint, name?, publicKeyPem? } checked and cleaned up: { source } or
// { error }. The URL is the one of repository.json.signed, over HTTPS, at a public name. With
// o.idFromManifest (a source the official catalog names in moved_to, which carries no id) the
// repositoryId may be left out: the caller reads it from the verified manifest.
function normalizeSource(s, o) {
    if (!isObj(s)) return { error: 'a source must be { url, repositoryId, fingerprint }' };
    var u = String(s.url || '').trim();
    if (!/^https:\/\//i.test(u)) return { error: 'the source URL must start with https://' };
    var bad = urlProblem(u);
    if (bad) return { error: 'the source URL ' + bad };
    var id = String(s.repositoryId || s.id || '').trim();
    if (!(id === '' && o && o.idFromManifest) && !str(id, RE.repoId, 128)) return { error: 'repositoryId must be a reverse-DNS id like io.github.owner.tizen' };
    if (id === 'official') return { error: 'repositoryId official is taken' };
    var fp = String(s.fingerprint || '').trim().toLowerCase().replace(/^sha256:/, '').replace(/:/g, '');
    if (!RE.fingerprint.test(fp)) return { error: 'fingerprint must be 64 hex characters (SHA-256 of the public key)' };
    var out = { url: u, repositoryId: id, fingerprint: fp, name: typeof s.name === 'string' ? s.name.replace(/[\r\n|]/g, ' ').trim().slice(0, 80) : '' };
    if (s.publicKeyPem !== undefined && s.publicKeyPem !== null && s.publicKeyPem !== '') {
        var k = keyInfo(s.publicKeyPem);
        if (!k) return { error: 'publicKeyPem is not a PEM public key' };
        if (k.fingerprint !== fp) return { error: 'publicKeyPem does not match the fingerprint' };
        out.publicKeyPem = String(s.publicKeyPem);
    }
    return { source: out };
}

module.exports = {
    verify: verify, keyInfo: keyInfo, urlProblem: urlProblem, hostOf: hostOf, normalizeSource: normalizeSource,
    schemaProblem: schemaProblem, duplicateProblem: duplicateProblem,
    MAX_BYTES: MAX_BYTES, MAX_AGE_MS: MAX_AGE_MS, MIN_KEY_BITS: MIN_KEY_BITS
};
