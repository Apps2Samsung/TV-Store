/* Tizen .wgt signer, ported from TizenSdb.Core TizenWgtSigner and verified byte-for-byte against its
 * output (test/sign.test.js). Produces author-signature.xml + signature1.xml: W3C XML Signature with a
 * SHA-512 digest per package file, a SignedProperties object digested under c14n11, SignedInfo signed
 * under exclusive-c14n with RSA-SHA512, and the signing cert embedded in KeyInfo.
 *
 * Certs arrive as PEM (key + cert chain) from a head, not as a .p12: Node has no PKCS#12 parser and the
 * TV's Node is old, so the head (which already holds the decrypted material) hands over PEM. A cert PEM
 * may hold several blocks (leaf, then intermediates); every one of them goes into KeyInfo, as from a PC. The canonical
 * byte sequences here are the exact ones C#'s canonicalizers produce — proven equal, not reimplemented
 * as a general c14n — so the output installs identically.
 */
'use strict';
var crypto = require('crypto');
var zip = require('./zip.js');

var DSIG = 'http://www.w3.org/2000/09/xmldsig#';
var SHA512 = 'http://www.w3.org/2001/04/xmlenc#sha512';
var EXC_C14N = 'http://www.w3.org/2001/10/xml-exc-c14n#';
var C14N11 = 'http://www.w3.org/2006/12/xml-c14n11';
var RSA_SHA512 = 'http://www.w3.org/2001/04/xmldsig-more#rsa-sha512';

function sha512b64(buf) { return crypto.createHash('sha512').update(buf).digest('base64'); }
function wrap76(s) { var out = []; for (var i = 0; i < s.length; i += 76) out.push(s.slice(i, i + 76)); return out.join('\n'); }
// The certificates in a PEM string, base64 DER each, in the order they appear. A head sends the
// chain the C# signer embeds (TizenSdb.Core GetKeyInfoChain): leaf first, then intermediates, never
// the root, so KeyInfo below comes out the same as a package signed from a PC.
function pemCerts(certPem) {
    var out = [], re = /-----BEGIN CERTIFICATE-----([\s\S]*?)-----END CERTIFICATE-----/g, m;
    while ((m = re.exec(certPem)) !== null) out.push(m[1].replace(/\s+/g, ''));
    if (!out.length) throw new Error('certificate PEM holds no CERTIFICATE block');
    return out;
}

// The #prop SignatureProperties object, in c14n11 canonical form (for the #prop digest) — proven to
// match C#. targetId = "AuthorSignature" | "DistributorSignature"; role = "author" | "distributor".
function propCanonical(targetId, role) {
    return '<Object xmlns="' + DSIG + '" Id="prop"><SignatureProperties xmlns:dsp="http://www.w3.org/2009/xmldsig-properties">'
        + '<SignatureProperty Id="profile" Target="#' + targetId + '"><dsp:Profile URI="http://www.w3.org/ns/widgets-digsig#profile"></dsp:Profile></SignatureProperty>'
        + '<SignatureProperty Id="role" Target="#' + targetId + '"><dsp:Role URI="http://www.w3.org/ns/widgets-digsig#role-' + role + '"></dsp:Role></SignatureProperty>'
        + '<SignatureProperty Id="identifier" Target="#' + targetId + '"><dsp:Identifier></dsp:Identifier></SignatureProperty>'
        + '</SignatureProperties></Object>';
}
// The object as STORED in the signature file: it inherits the default xmldsig namespace from
// <Signature>, so (unlike the canonical form used for the digest) it carries no xmlns on <Object>.
function propStored(targetId, role) { return propCanonical(targetId, role).replace(' xmlns="' + DSIG + '"', ''); }

// A <Reference> as it appears in SignedInfo (both canonical and stored forms are identical here).
function reference(uri, digestB64, withTransform) {
    var t = withTransform ? '<Transforms><Transform Algorithm="' + C14N11 + '"></Transform></Transforms>' : '';
    var tStored = withTransform ? '<Transforms><Transform Algorithm="' + C14N11 + '" /></Transforms>' : '';
    return { canon: '<Reference URI="' + uri + '">' + t + '<DigestMethod Algorithm="' + SHA512 + '"></DigestMethod><DigestValue>' + digestB64 + '</DigestValue></Reference>',
             stored: '<Reference URI="' + uri + '">' + tStored + '<DigestMethod Algorithm="' + SHA512 + '" /><DigestValue>' + digestB64 + '</DigestValue></Reference>' };
}

// Build one signature file (author or distributor). refs: [{uri,digest,withTransform}]. Returns Buffer.
function buildSignature(which, refs, propDigestB64, keyPem, certPem) {
    var id = which === 'author' ? 'AuthorSignature' : 'DistributorSignature';
    var role = which === 'author' ? 'author' : 'distributor';
    var refObjs = refs.map(function (r) { return reference(r.uri, r.digest, r.withTransform); });
    var propRef = reference('#prop', propDigestB64, true);

    // Canonical SignedInfo (exclusive-c14n: namespace first, explicit close tags) — this is what we sign.
    var siCanon = '<SignedInfo xmlns="' + DSIG + '">'
        + '<CanonicalizationMethod Algorithm="' + EXC_C14N + '"></CanonicalizationMethod>'
        + '<SignatureMethod Algorithm="' + RSA_SHA512 + '"></SignatureMethod>'
        + refObjs.map(function (r) { return r.canon; }).join('') + propRef.canon + '</SignedInfo>';
    var sigVal = crypto.sign('RSA-SHA512', Buffer.from(siCanon, 'utf8'), crypto.createPrivateKey(keyPem)).toString('base64');

    // Stored SignedInfo (self-closed empties, no xmlns on SignedInfo — it inherits from Signature).
    var siStored = '<SignedInfo>'
        + '<CanonicalizationMethod Algorithm="' + EXC_C14N + '" />'
        + '<SignatureMethod Algorithm="' + RSA_SHA512 + '" />'
        + refObjs.map(function (r) { return r.stored; }).join('') + propRef.stored + '</SignedInfo>';
    // One <X509Certificate> per cert in the chain, each wrapped at 76 with a newline either side.
    var x509 = pemCerts(certPem).map(function (b64) { return '<X509Certificate>\n' + wrap76(b64) + '\n</X509Certificate>'; }).join('');
    var xml = '<Signature Id="' + id + '" xmlns="' + DSIG + '">'
        + siStored
        + '<SignatureValue>' + sigVal + '</SignatureValue>'
        + '<KeyInfo><X509Data>' + x509 + '</X509Data></KeyInfo>'
        + propStored(id, role) + '</Signature>';
    return Buffer.from(xml, 'utf8');
}

// certs = { authorKeyPem, authorCertPem, distributorKeyPem, distributorCertPem }
function sign(wgtBuffer, certs) {
    if (!certs || !certs.authorKeyPem || !certs.distributorKeyPem) { var e = new Error('No signing certificate available on this TV yet (#844 cert hand-over).'); e.code = 'NO_CERT'; throw e; }
    var entries = zip.readEntries(wgtBuffer).filter(function (e) {
        return !e.dir && e.name !== 'author-signature.xml' && e.name !== 'signature1.xml';
    });

    // author-signature.xml: references every package file + #prop
    var authorRefs = entries.map(function (e) { return { uri: e.name, digest: sha512b64(e.data), withTransform: false }; });
    var authorProp = sha512b64(Buffer.from(propCanonical('AuthorSignature', 'author'), 'utf8'));
    var authorXml = buildSignature('author', authorRefs, authorProp, certs.authorKeyPem, certs.authorCertPem);

    // signature1.xml: references author-signature.xml (its stored bytes) + every package file + #prop
    var distRefs = [{ uri: 'author-signature.xml', digest: sha512b64(authorXml), withTransform: false }]
        .concat(entries.map(function (e) { return { uri: e.name, digest: sha512b64(e.data), withTransform: false }; }));
    var distProp = sha512b64(Buffer.from(propCanonical('DistributorSignature', 'distributor'), 'utf8'));
    var distXml = buildSignature('distributor', distRefs, distProp, certs.distributorKeyPem, certs.distributorCertPem);

    // Repackage: both signatures first, then the files (STORED).
    var out = [{ name: 'author-signature.xml', data: authorXml }, { name: 'signature1.xml', data: distXml }]
        .concat(entries.map(function (e) { return { name: e.name, data: e.data }; }));
    return zip.write(out);
}

module.exports = { sign: sign, ready: true };
