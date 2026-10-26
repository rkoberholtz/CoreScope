// Voice v8: "Lofi" — lo-fi hip hop, F major jazz chords (ii–V–I–vi–IV)
// Swung boom-bap drums, electric-piano 7th/9th chords, a soft bass and vinyl
// crackle, with a tape-style wobble and muffle.
//   ADVERT  → two chords with drums and bass
//   GRP_TXT → one chord with drums (the most frequent type, kept short)
//   TXT_MSG → two chords with a little electric-piano melody on top, no drums
//   TRACE   → a swung electric-piano arpeggio with hats
// Hops add tape wobble and muffle (longer routes sound like older tape);
// observers make it louder. Requires audio-synthkit.js.

(function () {
  'use strict';

  const { sampleBytes, mapRange } = MeshAudio.helpers;
  const kit = MeshAudio.synthkit;

  // ii–V–I–vi–IV colours in F, rootless-ish voicings around C4 (the bass plays roots)
  const CHORDS = [
    { bass: 43, midis: [55, 58, 62, 65, 69] }, // Gm9:    G Bb D F A
    { bass: 36, midis: [52, 55, 58, 62, 67] }, // C9:     E G Bb D G
    { bass: 41, midis: [57, 60, 64, 67, 69] }, // Fmaj9:  A C E G A
    { bass: 38, midis: [53, 57, 60, 62, 64] }, // Dm9:    F A C D E
    { bass: 46, midis: [58, 62, 65, 69, 72] }, // Bbmaj9: Bb D F A C
  ];
  const SWING = 0.3; // odd 16ths pushed late by 30% of a 16th

  const chordOf = (b) => CHORDS[Math.min(CHORDS.length - 1, Math.floor((b / 256) * CHORDS.length))];

  // Pure: packet → arrangement on a swung 16th grid (8 steps per chord). No audio here.
  // { steps, chords: [{step,len,midis}], melody|arp: [{step,len,midi}],
  //   bass: [{step,len,midi}], drums: [{step,kind:'kick'|'snare'|'hat',soft?}] }
  function arrange(parsed) {
    const { payloadBytes, typeName } = parsed;
    const kind = ['GRP_TXT', 'TXT_MSG', 'TRACE'].includes(typeName) ? typeName : 'ADVERT';
    const bytes = sampleBytes(payloadBytes, kind === 'GRP_TXT' ? 1 : 2, kind === 'GRP_TXT' ? 1 : 2);
    const out = { steps: bytes.length * 8, chords: [], melody: [], arp: [], bass: [], drums: [] };

    bytes.forEach((b, i) => {
      const c = chordOf(b);
      const s0 = i * 8;
      if (kind === 'TRACE') {
        const up = c.midis.concat(c.midis[0] + 12, c.midis[2] + 12, c.midis[4] + 12);
        for (let k = 0; k < 8; k++) out.arp.push({ step: s0 + k, len: 2, midi: up[k] });
        return;
      }
      out.chords.push({ step: s0, len: 8, midis: c.midis });
      if (kind !== 'GRP_TXT') {
        out.bass.push({ step: s0, len: 3, midi: c.bass });
        out.bass.push({ step: s0 + 6, len: 2, midi: c.bass + (b & 1 ? 7 : 12) });
      }
      if (kind === 'TXT_MSG') {
        // A little melody from the chord's upper tones, an octave up
        [1, 3, 6].forEach((s, k) => out.melody.push({ step: s0 + s, len: 2, midi: c.midis[(b >> k) % 3 + 2] + 12 }));
      }
    });

    if (kind !== 'TXT_MSG') {
      for (let s = 0; s < out.steps; s++) {
        const inBar = s % 16;
        if (kind !== 'TRACE') {
          if (inBar === 0 || inBar === 10) out.drums.push({ step: s, kind: 'kick' });
          if (inBar === 4 || inBar === 12) out.drums.push({ step: s, kind: 'snare' });
        }
        if (s % 2 === 0 || inBar === 7 || inBar === 15) out.drums.push({ step: s, kind: 'hat', soft: s % 4 !== 0 });
      }
    }
    return out;
  }

  const EP = { ratio: 1, index: [1.8, 0.4], indexDecay: 0.4, attack: 0.005, decay: 1.2, sustain: 0.35, release: 0.5, level: 0.6 };
  const EP_LEAD = Object.assign({}, EP, { index: [2.4, 0.5], level: 0.25 });
  const BASS = { type: 'sine', detunes: [0], cutoff: [900, 900, 700], q: 0.5, attack: 0.01, sustain: 0.8, release: 0.1, level: 0.4 };
  const KICK = { from: 110, to: 48, sweep: 0.09, decay: 0.28, level: 0.8 };
  const SNARE = { level: 0.3, decay: 0.14, body: 180 };

  function play(audioCtx, masterGain, parsed, opts) {
    const { hopCount, obsCount } = parsed;
    const sixteenth = 0.125 * opts.tempoMultiplier;
    const noise = kit.bus(audioCtx, masterGain, 'noise').buffer;
    const crackle = kit.bus(audioCtx, masterGain, 'crackle').buffer;
    const hall = kit.bus(audioCtx, masterGain, 'hall').input;

    const arr = arrange(parsed);
    const distance = Math.min(1, (hopCount - 1) / 9);
    const { mix, nodes } = kit.createMix(audioCtx, masterGain, Math.min(0.7, 0.5 + (obsCount - 1) * 0.015));

    // Tape: everything goes through a muffling lowpass; hops darken it
    const tape = audioCtx.createBiquadFilter();
    tape.type = 'lowpass';
    tape.frequency.value = mapRange(distance, 0, 1, 5000, 1600);
    tape.Q.value = 0.5;
    tape.connect(mix);

    // One slow wobble LFO per packet into every electric-piano oscillator's pitch
    const wobble = audioCtx.createOscillator();
    const wobbleDepth = audioCtx.createGain();
    wobble.frequency.value = 0.8;
    wobbleDepth.gain.value = 4 + 12 * distance; // cents
    wobble.connect(wobbleDepth);

    // Swung riffs start on an 8th boundary so odd steps line up across packets
    const t0 = kit.gridStart(audioCtx, 2 * sixteenth);
    const at = (step) => kit.stepTime(t0, step, sixteenth, SWING);
    let lastEnd = t0;
    const track = (t) => { if (t > lastEnd) lastEnd = t; };
    const epOpts = { sends: [[hall, 0.2]], pitchMod: wobbleDepth };

    arr.chords.forEach((c) => track(kit.playFM(audioCtx, tape, EP, c.midis, at(c.step), c.len * sixteenth, epOpts)));
    arr.melody.concat(arr.arp).forEach((n) => track(kit.playFM(audioCtx, tape, EP_LEAD, [n.midi], at(n.step), n.len * sixteenth, epOpts)));
    arr.bass.forEach((n) => track(kit.playSynth(audioCtx, tape, BASS, [n.midi], at(n.step), n.len * sixteenth - 0.02)));
    arr.drums.forEach((d) => {
      const t = at(d.step);
      if (d.kind === 'kick') track(kit.playKick(audioCtx, tape, t, KICK));
      else if (d.kind === 'snare') track(kit.playSnare(audioCtx, tape, noise, t, [[hall, 0.15]], SNARE));
      else track(kit.playHat(audioCtx, tape, noise, t, d.soft ? 0.06 : 0.1));
    });
    kit.playCrackle(audioCtx, mix, crackle, t0, lastEnd, 0.08);
    wobble.start(t0);
    wobble.stop(lastEnd);

    setTimeout(() => {
      nodes.concat(tape, wobble, wobbleDepth).forEach((n) => { try { n.disconnect(); } catch (e) {} });
    }, (lastEnd - audioCtx.currentTime + 1) * 1000);
    return lastEnd - audioCtx.currentTime;
  }

  MeshAudio.registerVoice('lofi', { name: 'lofi', play, arrange });
})();
