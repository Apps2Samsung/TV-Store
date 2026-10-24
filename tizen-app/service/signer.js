/* Tizen .wgt signer — the remaining gate for native installs (#844).
 *
 * sdbd installs only a package whose author-signature.xml + signature1.xml validate and whose
 * distributor signature covers THIS TV's DUID. The desktop/phone/CLI do this in C#
 * (TizenSdb.Core TizenWgtSigner): full W3C XML Signature — SHA-512 digests over every package file,
 * exclusive-c14n over SignedInfo, c14n11 over the SignedProperties object, RSA-SHA512, with the
 * author/distributor cert chain embedded in KeyInfo.
 *
 * Porting that to the TV's Node needs a byte-exact canonicalizer; it is being built and verified
 * against the C# signer's output before it ships (no retail TV in the loop to fail silently). Until
 * then this throws, and the install flow surfaces it rather than pushing a package the TV will reject.
 */
'use strict';
function NotImplemented() {
    var e = new Error('On-TV signing is not implemented yet (#844). The package was prepared but not signed, so the install was not attempted.');
    e.code = 'SIGNER_NOT_READY';
    return e;
}
// sign(wgtBuffer, certs) -> Buffer (signed wgt). certs = { authorP12, distributorP12, password } bytes.
function sign(wgtBuffer, certs) { throw NotImplemented(); }
module.exports = { sign: sign, ready: false };
