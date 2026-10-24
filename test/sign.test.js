/* Self-contained signer test: sign a fixture .wgt and prove the result without a TV.
 * Checks: every file's DigestValue equals a fresh SHA-512; the SignatureValue validates (RSA-SHA512)
 * over the reconstructed canonical SignedInfo; signature1 covers author-signature.xml; the zip reads.
 * The byte-for-byte equality with TizenSdb.Core's C# signer was confirmed separately during the port. */
'use strict';
var fs = require('fs'), crypto = require('crypto'), path = require('path');
var signer = require('../tizen-app/service/signer.js');
var zip = require('../tizen-app/service/zip.js');
var F = path.join(__dirname, 'fixtures');

function fail(m) { console.error('FAIL: ' + m); process.exit(1); }

// A small fixture package.
var pkg = zip.write([
    { name: 'config.xml', data: Buffer.from('<?xml version="1.0"?>\n<widget id="http://x/t" version="1.0.0"><name>T</name></widget>\n') },
    { name: 'index.html', data: Buffer.from('<!doctype html><title>t</title>\n') },
    { name: 'js/app.js', data: Buffer.from('console.log(1);\n') },
]);
var certs = {
    authorKeyPem: fs.readFileSync(path.join(F, 'author.key'), 'utf8'), authorCertPem: fs.readFileSync(path.join(F, 'author.crt'), 'utf8'),
    distributorKeyPem: fs.readFileSync(path.join(F, 'distributor.key'), 'utf8'), distributorCertPem: fs.readFileSync(path.join(F, 'distributor.crt'), 'utf8'),
};

var signed = signer.sign(pkg, certs);
var entries = zip.readEntries(signed);
function get(n) { for (var i = 0; i < entries.length; i++) if (entries[i].name === n) return entries[i].data; }

// 1) both signature files present, author first
if (entries[0].name !== 'author-signature.xml' || entries[1].name !== 'signature1.xml') fail('signature files not first / missing');

// 2) each package-file DigestValue in author-signature.xml equals a fresh SHA-512
var authorXml = get('author-signature.xml').toString('utf8');
['config.xml', 'index.html', 'js/app.js'].forEach(function (name) {
    var want = crypto.createHash('sha512').update(get(name)).digest('base64');
    if (authorXml.indexOf('<Reference URI="' + name + '">') < 0 || authorXml.indexOf(want) < 0) fail('digest for ' + name + ' missing/wrong');
});

// 3) signature1 references author-signature.xml with its real digest
var distXml = get('signature1.xml').toString('utf8');
var authDigest = crypto.createHash('sha512').update(get('author-signature.xml')).digest('base64');
if (distXml.indexOf('<Reference URI="author-signature.xml">') < 0 || distXml.indexOf(authDigest) < 0) fail('signature1 does not cover author-signature.xml');

// 4) SignatureValue validates over the reconstructed canonical SignedInfo (proves the signing input)
function verify(xml, certPem) {
    var m = xml.match(/<SignedInfo>([\s\S]*?)<\/SignedInfo>/); var inner = m[1];
    // Rebuild canonical form: add xmlns, expand self-closed empties to explicit close.
    var canonInner = inner.replace(/<([A-Za-z]+)([^>]*?) \/>/g, '<$1$2></$1>');
    var si = '<SignedInfo xmlns="http://www.w3.org/2000/09/xmldsig#">' + canonInner + '</SignedInfo>';
    var sig = xml.match(/<SignatureValue>([^<]+)<\/SignatureValue>/)[1];
    return crypto.verify('RSA-SHA512', Buffer.from(si, 'utf8'), crypto.createPublicKey(certPem), Buffer.from(sig, 'base64'));
}
if (!verify(authorXml, certs.authorCertPem)) fail('author SignatureValue does not validate');
if (!verify(distXml, certs.distributorCertPem)) fail('distributor SignatureValue does not validate');

console.log('PASS: signer produces a valid, self-consistent signed package');
console.log('  entries:', entries.map(function (e) { return e.name; }).join(', '));
process.exit(0);
