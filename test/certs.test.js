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
if (JSON.stringify(certs.summary(two)) !== JSON.stringify([{ name: 'Jelly2Sams - Public', level: 'public' }, { name: 'Jelly2Sams - Partner', level: 'partner' }])) fail('summary: ' + JSON.stringify(certs.summary(two)));
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
console.log('PASS: certificate store: payload shapes, merge of a second hand-over, order per package, Public and Partner levels, 0.3.x file');
