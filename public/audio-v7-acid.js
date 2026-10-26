// Voice v7: "Acid" — TB-303 acid techno, A minor
// Packet bytes are a 303 sequencer pattern: each byte is one 16th step, and its
// bits pick the note, accent, slide or rest. A squelchy resonant filter sweeps
// across the pattern over four-on-the-floor drums.
//   ADVERT  → 16-step pattern, kick + offbeat hats + clap on 2 and 4
//   GRP_TXT → 8-step pattern, kick + hats (the most frequent type, kept short)
//   TXT_MSG → 16-step pattern, brighter filter, kick + hats + clap
//   TRACE   → 8-step pattern with the filter sweeping wide open, hats only
// Hops raise the filter resonance (more squelch); observers make it louder.
// Requires audio-synthkit.js.

(function () {
  'use strict';

  const { sampleBytes } = MeshAudio.helpers;
  const kit = MeshAudio.synthkit;

  const ROOT = 45; // A2
  // Semitone offsets over the root; the classic acid moves: root, octave jumps, minor third, fifth, seventh
  const OFFSETS = [0, 0, 12, 3, 7, 10, 0, 15];

  // Pure: packet → 303 pattern + drums on a 16th grid. No audio here.
  // { steps, notes: [{step, midi, accent, slide, prevMidi}], drums: [{step, kind}], sweep: [lo, hi] }
  function arrange(parsed) {
    const { payloadBytes, typeName } = parsed;
    const kind = ['GRP_TXT', 'TXT_MSG', 'TRACE'].includes(typeName) ? typeName : 'ADVERT';
    const len = kind === 'GRP_TXT' || kind === 'TRACE' ? 8 : 16;
    // Walk the payload evenly to get exactly `len` steps (repeating short payloads)
    const bytes = Array.from({ length: len }, (_, i) =>
      payloadBytes[Math.floor((i / len) * payloadBytes.length)] ^ (i * 29 & 0xff));

    const notes = [];
    let prev = null;
    bytes.forEach((b, step) => {
      const rest = step > 0 && (b >> 5 & 3) === 0; // ~1 in 4 steps rests (never the downbeat)
      if (rest) { prev = null; return; }
      const midi = ROOT + OFFSETS[b & 7];
      const slide = prev != null && (b & 16) !== 0;
      notes.push({ step, midi, accent: (b & 8) !== 0, slide, prevMidi: slide ? prev : null });
      prev = midi;
    });

    const drums = [];
    for (let s = 0; s < len; s++) {
      if (kind !== 'TRACE' && s % 4 === 0) drums.push({ step: s, kind: 'kick' });
      if (s % 4 === 2) drums.push({ step: s, kind: 'hat' });
      if ((kind === 'ADVERT' || kind === 'TXT_MSG') && s % 8 === 4) drums.push({ step: s, kind: 'clap' });
    }

    const sweep = { ADVERT: [350, 1400], GRP_TXT: [300, 900], TXT_MSG: [700, 2200], TRACE: [300, 3500] }[kind];
    return { steps: len, notes, drums, sweep };
  }

  const KICK = { from: 150, to: 45, sweep: 0.07, decay: 0.3, level: 1 };
  const CLAP = { level: 0.45, decay: 0.12, body: 900 };

  function play(audioCtx, masterGain, parsed, opts) {
    const { hopCount, obsCount } = parsed;
    const sixteenth = 0.125 * opts.tempoMultiplier;
    const noise = kit.bus(audioCtx, masterGain, 'noise').buffer;
    const delay = kit.bus(audioCtx, masterGain, 'delay');
    delay.delays.forEach((d) => { d.delayTime.value = 3 * sixteenth; });

    const arr = arrange(parsed);
    const q = Math.min(20, 9 + hopCount); // more hops → more squelch
    const { mix, nodes } = kit.createMix(audioCtx, masterGain, Math.min(0.6, 0.4 + (obsCount - 1) * 0.015));
    const bassline = audioCtx.createGain();
    bassline.connect(mix);
    const send = audioCtx.createGain();
    send.gain.value = 0.2;
    bassline.connect(send);
    send.connect(delay.input);

    const t0 = kit.gridStart(audioCtx, sixteenth);
    const at = (step) => t0 + step * sixteenth;
    let lastEnd = t0;
    const track = (t) => { if (t > lastEnd) lastEnd = t; };

    // Filter "knob" sweeps up and back down across the pattern
    const [lo, hi] = arr.sweep;
    arr.notes.forEach((n) => {
      const knob = Math.sin((Math.PI * n.step) / arr.steps);
      const cutoff = lo * Math.pow(hi / lo, knob);
      // Slid notes tie into the next step; plain notes gate at ~60% of a 16th
      const dur = sixteenth * (n.slide ? 1 : 0.6);
      track(kit.playAcid(audioCtx, bassline, n, at(n.step), dur, { cutoff, q, envMod: 2.5, decay: 0.18, level: 0.35 }));
    });
    const recover = Math.min(0.15, 3 * sixteenth);
    arr.drums.forEach((d) => {
      const t = at(d.step);
      if (d.kind === 'kick') {
        track(kit.playKick(audioCtx, mix, t, KICK));
        kit.duck(bassline.gain, t, recover, 0.5);
      } else if (d.kind === 'hat') {
        track(kit.playHat(audioCtx, mix, noise, t, 0.2));
      } else {
        track(kit.playSnare(audioCtx, mix, noise, t, [], CLAP));
      }
    });

    setTimeout(() => {
      nodes.concat(bassline, send).forEach((n) => { try { n.disconnect(); } catch (e) {} });
    }, (lastEnd - audioCtx.currentTime + 1) * 1000);
    return lastEnd - audioCtx.currentTime;
  }

  MeshAudio.registerVoice('acid', { name: 'acid', play, arrange });
})();
