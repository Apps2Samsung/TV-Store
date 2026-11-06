/* certs.js keeps every signing profile a head hands over (#44): the payload shapes, merging a
 * second hand-over, the order to try for a package, and reading a 0.3.x one-profile file. And
 * the level of each (#50): Public or Partner from the Samsung CA in the distributor chain, the
 * order narrowed to the level an install asks for. */
'use strict';
var fs = require('fs'), path = require('path');
var certs = require('../tizen-app/service/certs.js');
function fail(m) { console.error('FAIL: ' + m); process.exit(1); }
var F = path.join(__dirname, 'fixtures');
function pem(f) { return fs.readFileSync(path.join(F, f), 'utf8'); }
var A = { authorKeyPem: pem('author.key'), authorCertPem: pem('author.crt'), distributorKeyPem: pem('distributor.key'), distributorCertPem: pem('distributor.crt') };
// A second profile: the distributor pair as an author pair, different leaf, so a different id.
var B = { authorKeyPem: pem('distributor.key'), authorCertPem: pem('distributor.crt'), distributorKeyPem: pem('distributor.key'), distributorCertPem: pem('distributor.crt') };

var idA = certs.fingerprint(A.authorCertPem), idB = certs.fingerprint(B.authorCertPem);
if (!/^[0-9a-f]{64}$/.test(idA) || idA === idB) fail('fingerprint: ' + idA + ' ' + idB);
if (certs.fingerprint('not a pem') !== '') fail('fingerprint of junk must be empty');

// 0.2.0 to 0.3.12 heads send the four fields; 3.2+ heads add certificates[], first choice first.
var legacy = certs.normalize(A);
if (legacy.length !== 1 || legacy[0].id !== idA || legacy[0].name !== 'certificate 1') fail('legacy payload: ' + JSON.stringify(legacy.map(function (c) { return c.name; })));
var both = certs.normalize({ authorKeyPem: A.authorKeyPem, authorCertPem: A.authorCertPem, distributorKeyPem: A.distributorKeyPem, distributorCertPem: A.distributorCertPem,
    certificates: [ Object.assign({ name: 'Jelly2Sams - Public' }, A), Object.assign({ name: 'Jellyfin' }, B), Object.assign({ name: 'broken' }, A, { authorKeyPem: '' }) ] });
if (both.length !== 2 || both[0].id !== idA || both[0].name !== 'Jelly2Sams - Public' || both[1].id !== idB || both[1].name !== 'Jellyfin') fail('full payload: ' + JSON.stringify(both.map(function (c) { return c.name; })));
// A 3.2+ head whose top-level profile is not in its list (never the case, but cheap): it goes first.
var extra = certs.normalize(Object.assign({ certificates: [Object.assign({ name: 'Jellyfin' }, B)] }, A));
if (extra.length !== 2 || extra[0].id !== idA || extra[1].name !== 'Jellyfin') fail('top-level profile outside the list goes first');
if (certs.normalize({}).length !== 0 || certs.normalize(null).length !== 0) fail('an empty payload has no profiles');

// A store: the first hand-over, then a second phone adds B and keeps A.
var store = certs.merge(null, certs.normalize(Object.assign({ name: 'Jelly2Sams - Public' }, A)));
if (store.primary !== idA || store.certificates.length !== 1) fail('first store');
store = certs.merge(store, certs.normalize({ certificates: [Object.assign({ name: 'Phone - Public' }, B)] }));
if (store.primary !== idB || store.certificates.length !== 2 || store.certificates[1].name !== 'Jelly2Sams - Public') fail('merged store: ' + JSON.stringify(certs.names(store)));
// Handing A over again under a new name replaces the entry and makes it primary.
store = certs.merge(store, certs.normalize({ certificates: [Object.assign({ name: 'PC - Public' }, A)] }));
if (store.primary !== idA || store.certificates.length !== 2 || certs.names(store).join('|') !== 'PC - Public|Phone - Public') fail('re-handover: ' + JSON.stringify(certs.names(store)));

// Which to try for a package: the one it took before, then the primary, then the rest.
var o = certs.order(store, idB).map(function (c) { return c.id; });
if (o.join() !== [idB, idA].join()) fail('order with a remembered profile');
o = certs.order(store, 'gone').map(function (c) { return c.id; });
if (o.join() !== [idA, idB].join()) fail('order with a forgotten profile');
if (certs.order(null, idA).length !== 0) fail('order on no store');

// Levels (#50): the fixtures' Public and Partner chains carry the Samsung CA names, the old test
// chain carries neither and is unknown, which serves as public.
if (certs.level(pem('public-distributor.crt')) !== 'public' || certs.level(pem('partner-distributor.crt')) !== 'partner') fail('level from the CA name');
if (certs.level(pem('distributor.crt')) !== 'unknown' || certs.level('junk') !== 'unknown') fail('a chain from elsewhere is unknown');
var PUB = { name: 'Jelly2Sams - Public', authorKeyPem: pem('author.key'), authorCertPem: pem('author.crt'), distributorKeyPem: pem('public-distributor.key'), distributorCertPem: pem('public-distributor.crt') };
var PAR = { name: 'Jelly2Sams - Partner', authorKeyPem: pem('partner-author.key'), authorCertPem: pem('partner-author.crt'), distributorKeyPem: pem('partner-distributor.key'), distributorCertPem: pem('partner-distributor.crt') };
var idPub = certs.fingerprint(PUB.authorCertPem), idPar = certs.fingerprint(PAR.authorCertPem);
if (idPub === idPar) fail('the two level profiles must have their own author');
var two = certs.merge(null, certs.normalize({ certificates: [PUB, PAR] }));
if (two.certificates[0].level !== 'public' || two.certificates[1].level !== 'partner') fail('levels on the entries: ' + JSON.stringify(certs.summary(two)));
var sum = certs.summary(two);
if (sum.map(function (c) { return c.name + '/' + c.level + '/' + c.primary; }).join() !== 'Jelly2Sams - Public/public/true,Jelly2Sams - Partner/partner/false' || sum[0].id !== idPub) fail('summary: ' + JSON.stringify(sum));
if (JSON.stringify(sum).indexOf('PRIVATE KEY') >= 0 || JSON.stringify(sum).indexOf('BEGIN CERTIFICATE') >= 0) fail('the summary must carry no keys or certificates');
if (!certs.has(two, 'partner') || !certs.has(two, 'public') || certs.has(certs.merge(null, certs.normalize({ certificates: [PUB] })), 'partner')) fail('has(level)');
// No wish: both, the primary first. A wish: only that level, so a Partner app is never signed
// Public on the way, and a remembered profile of the other level is left out.
var ids = function (l) { return l.map(function (c) { return c.id; }).join(); };
if (ids(certs.order(two, null)) !== [idPub, idPar].join()) fail('no wish: all, primary first');
if (ids(certs.order(two, null, 'partner')) !== idPar || ids(certs.order(two, idPub, 'partner')) !== idPar) fail('partner wished: only the Partner profile');
if (ids(certs.order(two, idPar, 'public')) !== idPub) fail('public wished: only the Public profile');
if (ids(certs.order(two, idPar)) !== [idPar, idPub].join()) fail('remembered Partner first without a wish');
// A preference (the manifest's partner privilege) puts Partner first and keeps Public behind it; a wish filters.
if (ids(certs.order(two, null, null, 'partner')) !== [idPar, idPub].join()) fail('partner preferred: Partner first, Public still tried');
if (ids(certs.order(two, idPub, null, 'partner')) !== [idPar, idPub].join()) fail('partner preferred beats the remembered Public');
var one = certs.merge(null, certs.normalize({ certificates: [PUB] }));
if (certs.order(one, null, 'partner').length !== 0) fail('partner wished on a Public-only TV: nothing to try');
if (ids(certs.order(one, null, null, 'partner')) !== idPub) fail('partner preferred on a Public-only TV: the Public profile is still tried');
// An unknown chain (the old test chain) counts as public: taken for public, never for partner.
var unk = certs.merge(null, certs.normalize(Object.assign({ name: 'Studio' }, A)));
if (certs.order(unk, null, 'public').length !== 1 || certs.order(unk, null, 'partner').length !== 0) fail('unknown level serves as public');
// A file written before levels existed gets them when read.
var reread = certs.fromStored(JSON.parse(JSON.stringify(two).replace(/"level":"[a-z]+",/g, '')));
if (reread.certificates[1].level !== 'partner') fail('levels are read back onto an older file');

// Files on disk: a 0.3.x one-profile file and this version's.
var old = certs.fromStored(A);
if (!old || old.primary !== idA || old.certificates.length !== 1) fail('0.3.x file');
var fresh = certs.fromStored(JSON.parse(JSON.stringify(store)));
if (!fresh || fresh.primary !== idA || fresh.certificates.length !== 2) fail('this version\'s file');
if (certs.fromStored({ junk: 1 }) !== null || certs.fromStored(null) !== null) fail('junk file');

// #78: what Settings shows per profile, read from the DER: expiry of both certificates and the
// DUIDs the distributor certificate covers.
var info = certs.certInfo(pem('author.crt'));
if (info.validUntil !== '2046-10-19T18:09:47.000Z' || info.deviceIds.length !== 0) fail('certInfo of the author fixture: ' + JSON.stringify(info));
var dinfo = certs.certInfo(pem('duid-distributor.crt'));
if (dinfo.deviceIds.join() !== 'TESTDUID0001,TESTDUID0002' || !/^20\d\d-/.test(dinfo.validUntil)) fail('certInfo of the DUID fixture: ' + JSON.stringify(dinfo));
// The chain's first certificate is the leaf; the Samsung CA after it is not read.
if (certs.certInfo(pem('public-distributor.crt')).validUntil !== '2036-10-29T14:37:33.000Z') fail('certInfo reads the leaf of a chain');
var junkInfo = certs.certInfo('-----BEGIN CERTIFICATE-----\nMIIBAAAA\n-----END CERTIFICATE-----');
if (junkInfo.validUntil !== '' || junkInfo.deviceIds.length !== 0 || certs.certInfo('').validUntil !== '') fail('certInfo of junk: ' + JSON.stringify(junkInfo));
var DU = { name: 'With DUIDs', authorKeyPem: pem('author.key'), authorCertPem: pem('author.crt'), distributorKeyPem: pem('duid-distributor.key'), distributorCertPem: pem('duid-distributor.crt') };
var ds = certs.summary(certs.merge(null, certs.normalize({ certificates: [DU] })))[0];
if (ds.deviceIds.join() !== 'TESTDUID0001,TESTDUID0002' || ds.validUntil !== '2046-10-19T18:09:47.000Z' || ds.distributorValidUntil !== dinfo.validUntil) fail('summary carries expiry and DUIDs: ' + JSON.stringify(ds));

// #78: a default picked on the TV. It survives a re-arm that would make the head's first choice primary.
if (certs.setDefault(two, 'gone') !== null || certs.setDefault(null, idPub) !== null) fail('setDefault of an unknown id');
var picked = certs.setDefault(two, idPar);
if (picked.primary !== idPar || picked.tvDefault !== idPar || ids(picked.certificates) !== [idPub, idPar].join()) fail('setDefault keeps the order, sets primary');
if (ids(certs.order(picked, null)) !== [idPar, idPub].join()) fail('the TV-side default is tried first');
if (ids(certs.order(picked, idPub)) !== [idPub, idPar].join()) fail('the profile a package took still comes before the default');
if (ids(certs.order(picked, null, 'public')) !== idPub) fail('a level wish still filters past the default');
var rearmed = certs.merge(picked, certs.normalize({ certificates: [PUB, PAR] }));
if (rearmed.primary !== idPar || rearmed.tvDefault !== idPar) fail('a re-arm keeps the default chosen on the TV: ' + rearmed.primary);
var s2 = certs.summary(rearmed);
if (!s2[1].primary || !s2[1].chosenOnTv || s2[0].primary || s2[0].chosenOnTv) fail('summary marks the default chosen on the TV');
var back = certs.fromStored(JSON.parse(JSON.stringify(rearmed)));
if (back.primary !== idPar || back.tvDefault !== idPar) fail('the TV-side default is read back from the file');
// Without a TV-side default a stored primary is read back too (it was always the first entry before #78).
var plain = certs.fromStored({ primary: idPar, certificates: JSON.parse(JSON.stringify(two.certificates)) });
if (plain.primary !== idPar || plain.tvDefault !== null) fail('a stored primary is read back');
if (certs.fromStored({ primary: 'gone', tvDefault: 'gone', certificates: JSON.parse(JSON.stringify(two.certificates)) }).primary !== idPub) fail('a stale primary falls back to the first');

// #78: removing a profile on the TV.
if (certs.remove(two, 'gone') !== null) fail('remove of an unknown id');
var less = certs.remove(rearmed, idPar);
if (less.certificates.length !== 1 || less.primary !== idPub || less.tvDefault !== null) fail('removing the TV-side default: the first left is primary, the pick is gone');
var keep = certs.remove(certs.merge(picked, certs.normalize(Object.assign({ name: 'Studio' }, B))), idB);
if (keep.primary !== idPar || keep.tvDefault !== idPar || keep.certificates.length !== 2) fail('removing another profile keeps the TV-side default');
var none = certs.remove(one, idPub);
if (none.certificates.length !== 0 || none.primary !== null || certs.order(none).length !== 0) fail('removing the last profile leaves an empty store');
if (certs.merge(none, certs.normalize({ certificates: [PAR] })).primary !== idPar) fail('arming an emptied store');
console.log('PASS: certificate store: payload shapes, merge of a second hand-over, order per package, Public and Partner levels, 0.3.x file, expiry and DUIDs, default and remove on the TV');
