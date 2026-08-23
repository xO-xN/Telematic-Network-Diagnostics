// PNDS Template — External debug bridge (创作期调试工具).
//
// Run this file in the SuperCollider IDE (boot the local server first), then
// start the score server from a terminal:
//   node server.js --audio-mode external --osc-target 127.0.0.1:57120
//
// It listens for the template's external OSC protocol and plays one sine
// voice per client:
//   /c<id>/amp  [0..1]
//   /c<id>/freq [100..3000]
//   /c<id>/out  [1..16]
//
// Requires the 'template-sine' SynthDef: first run supercollider/source/
// template-sine.scd in this IDE session.
//
// The bridge is not part of the PNDS runtime: Internal mode only loads the
// compiled .scsyndef and never starts sclang.

(
s.waitForBoot {
    var maxClients = 16;
    var synths = Array.fill(maxClients, { nil });
    var ensureSynth = { |id|
        if (synths[id - 1].isNil) {
            synths[id - 1] = Synth('template-sine', [\out, id - 1]);
        };
    };
    var idFromAddress = { |address|
        address.split($/)[1].drop(1).asInteger; // "/c3/amp" -> 3
    };

    OSCFunc({ |msg|
        var id = idFromAddress.(msg[0]);
        ensureSynth.(id);
        synths[id - 1].set(\amp, msg[1]);
        "/c%/amp -> %".format(id, msg[1]).postln;
    }, "/c*/amp");

    OSCFunc({ |msg|
        var id = idFromAddress.(msg[0]);
        ensureSynth.(id);
        synths[id - 1].set(\freq, msg[1]);
        "/c%/freq -> %".format(id, msg[1]).postln;
    }, "/c*/freq");

    OSCFunc({ |msg|
        var id = idFromAddress.(msg[0]);
        ensureSynth.(id);
        synths[id - 1].set(\out, msg[1] - 1);
        "/c%/out -> %".format(id, msg[1]).postln;
    }, "/c*/out");

    "PNDS Template debug bridge listening on 57120 (external mode).".postln;
};
)
