/* certs.js keeps every signing profile a head hands over (#44): the payload shapes, merging a
 * second hand-over, the order to try for a package, and reading a 0.3.x one-profile file. */
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

// Files on disk: a 0.3.x one-profile file and this version's.
var old = certs.fromStored(A);
if (!old || old.primary !== idA || old.certificates.length !== 1) fail('0.3.x file');
var fresh = certs.fromStored(JSON.parse(JSON.stringify(store)));
if (!fresh || fresh.primary !== idA || fresh.certificates.length !== 2) fail('this version\'s file');
if (certs.fromStored({ junk: 1 }) !== null || certs.fromStored(null) !== null) fail('junk file');
console.log('PASS: certificate store: payload shapes, merge of a second hand-over, order per package, 0.3.x file');
