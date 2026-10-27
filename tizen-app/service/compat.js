/* Buffers for the Node of a Tizen web service: v4.4.3 on a 2019 Tizen 5.0 set (#881).
 * Buffer.from and Buffer.alloc arrived in Node 4.5.0. On 4.4.3, Buffer.from is the inherited
 * Uint8Array.from, which reads the encoding argument as a map function: Buffer.from(s, 'utf8')
 * throws "utf8 is not a function". Every service module and test builds buffers through here.
 * Run the tests with that exact Node (CI does) before using anything newer than ES5 / Node 4.
 */
'use strict';
var NATIVE = typeof Buffer.alloc === 'function' && Buffer.from !== Uint8Array.from;

exports.from = function (value, encoding) { return NATIVE ? Buffer.from(value, encoding) : new Buffer(value, encoding); };
exports.alloc = function (size) {
    if (NATIVE) return Buffer.alloc(size);
    var b = new Buffer(size); b.fill(0); return b;
};
