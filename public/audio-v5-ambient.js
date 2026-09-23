// Voice v5: "Ambient" — slow generative bells and pads, C major pentatonic
// Sparse notes with long attacks and a big hall, in a scale with no clashing
// intervals so overlapping packets always blend. Not tied to the beat grid:
// random arrival times are part of the texture.
//   ADVERT  → low drone pad (root + fifth; + octave with 3+ observers)
//   GRP_TXT → one or two mid bells
//   TXT_MSG → a short, gentle bell phrase
//   TRACE   → quick high glints into the echo
// Hops push notes into the distance (wetter, darker, quieter); observers add
// FM brightness to the bells. Requires audio-synthkit.js.

(function () {
  'use strict';

  const { buildScale, quantizeToScale, sampleBytes } = MeshAudio.helpers;
  const kit = MeshAudio.synthkit;

  const PENTA = [0, 2, 4, 7, 9]; // C major pentatonic
  const DRONE_ROOTS = [36, 38, 43, 45];                   // C2 D2 G2 A2: roots whose fifth stays in the scale
  const BELL_SCALE = buildScale(PENTA, 60).slice(0, 10);  // C4..A5
  const GLINT_SCALE = buildScale(PENTA, 84).slice(0, 6);  // C6..C7

  // Pure: packet → notes in 16th-note steps from the packet's start. No audio here.
  // [{ step, len, midis, kind: 'pad' | 'bell' | 'glint' }]
  function arrange(parsed) {
    const { payloadBytes, typeName, obsCount } = parsed;
    const notes = [];
    switch (typeName) {
      case 'GRP_TXT':
        sampleBytes(payloadBytes, 1, 2).forEach((b, i) => {
          notes.push({ step: i * (4 + (b & 3)), len: 12, midis: [quantizeToScale(b, BELL_SCALE)], kind: 'bell' });
        });
        break;
      case 'TXT_MSG': {
        let step = 0;
        sampleBytes(payloadBytes, 2, 3).forEach((b) => {
          notes.push({ step, len: 12, midis: [quantizeToScale(b, BELL_SCALE)], kind: 'bell' });
          step += 4 + (b & 1) * 2;
        });
        break;
      }
      case 'TRACE': {
        let step = 0;
        sampleBytes(payloadBytes, 3, 5).forEach((b) => {
          notes.push({ step, len: 3, midis: [quantizeToScale(b, GLINT_SCALE)], kind: 'glint' });
          step += 1 + (b & 1);
        });
        break;
      }
      default: { // ADVERT and everything else: a drone
        const root = quantizeToScale(payloadBytes[0], DRONE_ROOTS);
        const midis = obsCount >= 3 ? [root, root + 7, root + 12] : [root, root + 7];
        notes.push({ step: 0, len: 24, midis, kind: 'pad' });
      }
    }
    return notes;
  }

  const PAD = { type: 'triangle', detunes: [-7, 7], cutoff: [300, 900, 600], filterAttack: 2, q: 0.7, attack: 1.5, sustain: 0.9, release: 2.5, level: 0.5 };
  const BELL = { ratio: 3.5, index: [2.5, 0.3], indexDecay: 1.2, attack: 0.01, decay: 2.5, sustain: 0.05, release: 1.5, level: 0.3 };
  const GLINT = { ratio: 4.2, index: [1.5, 0.2], indexDecay: 0.3, attack: 0.005, decay: 0.6, sustain: 0.02, release: 0.5, level: 0.3 };

  function play(audioCtx, masterGain, parsed, opts) {
    const { hopCount, obsCount } = parsed;
    const sixteenth = 0.125 * opts.tempoMultiplier;
    const hall = kit.bus(audioCtx, masterGain, 'hall').input;
    const delay = kit.bus(audioCtx, masterGain, 'delay');
    delay.delays.forEach((d) => { d.delayTime.value = 3 * sixteenth; });

    // Distance: more hops → quieter dry signal, more reverb, darker bells
    const distance = Math.min(1, (hopCount - 1) / 9);
    const dry = audioCtx.createGain();
    dry.gain.value = Math.min(1, 0.8 + (obsCount - 1) * 0.02) * (1 - 0.5 * distance);
    dry.connect(masterGain);
    const wet = 0.35 + 0.5 * distance;
    const brightness = (1 - 0.6 * distance) * Math.min(2, 1 + (obsCount - 1) * 0.1);

    const t0 = audioCtx.currentTime + 0.05;
    let lastEnd = t0;
    arrange(parsed).forEach((n) => {
      const start = t0 + n.step * sixteenth;
      const dur = n.len * sixteenth;
      let end;
      if (n.kind === 'pad') {
        end = kit.playSynth(audioCtx, dry, PAD, n.midis, start, dur, { sends: [[hall, wet]] });
      } else {
        const base = n.kind === 'bell' ? BELL : GLINT;
        const preset = Object.assign({}, base, { index: [base.index[0] * brightness, base.index[1]] });
        const sends = n.kind === 'glint' ? [[hall, wet], [delay.input, 0.4]] : [[hall, wet]];
        end = kit.playFM(audioCtx, dry, preset, n.midis, start, dur, { sends });
      }
      if (end > lastEnd) lastEnd = end;
    });

    // Reverb/echo tails ring in the shared buses, so the voice slot frees when the notes end.
    setTimeout(() => { try { dry.disconnect(); } catch (e) {} }, (lastEnd - audioCtx.currentTime + 1) * 1000);
    return lastEnd - audioCtx.currentTime;
  }

  MeshAudio.registerVoice('ambient', { name: 'ambient', play, arrange });
})();
