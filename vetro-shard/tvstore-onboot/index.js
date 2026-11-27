'use strict';
// TV-Store start at boot (Apps2Samsung/TV-Store#159). Plain ES5: older TVs run Node 4.4.
//
// TV-Store's package asks the TV to start its service when the TV starts, so that updates can land
// without anyone opening TV-Store. Some firmware drops that at install and registers the service
// with the flag off. This Shard turns the flag on again: after every start of Vetro (which starts
// with the TV), and once an hour after that, because every update of TV-Store registers the service
// again and the flag is off again. It changes that one value and nothing else: it downloads,
// signs and installs nothing. The commands are in tv.sh (README: Commands it runs).

var fs = require('fs');
var path = require('path');

// How long to wait; the test of this Shard makes them short.
var TIMES = {
    first: 20000,          // Vetro has just started: give the root agent a moment
    retry: 20000,          // the agent is not connected yet
    again: 60 * 60 * 1000, // TV-Store may have been updated meanwhile
    command: 20000
};
var MAX_RETRIES = 30;      // ten minutes without an agent: leave it until the next look
var MAX_FAILED = 3;        // per start of Vetro: a flag that will not turn on is not tried without end

module.exports = function (ctx) {
    var timer = null, stopped = true, busy = false, retries = 0, failed = 0;
    var last = { result: 'starting', at: null, setAt: null, error: null };

    function script() { return fs.readFileSync(path.join(ctx.dir, 'tv.sh'), 'utf8'); }
    function b64(text) {
        var hasFrom = typeof Buffer.from === 'function' && Buffer.from !== Uint8Array.from;   // Node 4.4 has only the TypedArray one
        return (hasFrom ? Buffer.from(text, 'utf8') : new Buffer(text, 'utf8')).toString('base64');
    }
    function command(mode) { return 'sh -c "$(echo ' + b64(script()) + ' | base64 -d)" tvstore-onboot ' + mode; }

    function later(ms) {
        if (stopped) return;
        clearTimeout(timer);
        timer = setTimeout(tick, ms);
    }

    // Everything in here is caught: an error in a timer or a promise of a Shard can stop all of Vetro.
    function tick() {
        if (stopped || busy) return;
        busy = true;
        var next = TIMES.again;
        var asked;
        try { asked = ctx.execute(command(failed >= MAX_FAILED ? 'check' : 'set'), TIMES.command); }
        catch (e) { asked = Promise.reject(e); }
        Promise.resolve(asked).then(function (r) {
            var m = /^result=(kept|set|off|absent|failed)$/m.exec(String((r && r.stdout) || ''));
            if (!m) throw new Error('No answer from the TV');
            retries = 0;
            last.result = m[1]; last.at = Date.now(); last.error = null;
            if (m[1] === 'set') last.setAt = last.at;
            if (m[1] === 'failed') failed++;
        }).catch(function (e) {
            last.error = String((e && e.message) || e).slice(0, 200);
            if (++retries <= MAX_RETRIES) next = TIMES.retry; else retries = 0;
        }).then(function () {
            busy = false;
            later(next);
        });
    }

    var TEXT = {
        starting: 'Waiting for the TV agent.',
        kept: 'The flag is on. TV-Store’s service starts with the TV.',
        set: 'The flag was off and is on now. It counts from the next start of the TV.',
        off: 'The flag is off and could not be turned on.',
        failed: 'The flag is off and could not be turned on.',
        absent: 'TV-Store is not on this TV.'
    };

    return {
        start: function () { stopped = false; busy = false; retries = 0; failed = 0; later(TIMES.first); },
        stop: function () { stopped = true; clearTimeout(timer); timer = null; },
        status: function () { return { result: last.result, text: TEXT[last.result] || '', checkedAt: last.at, setAt: last.setAt, error: last.error }; }
    };
};
module.exports.TIMES = TIMES;
