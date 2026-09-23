// Voice v4: "Technoir" — dark 80s synthwave, D natural minor
// Driving 8th-note bass with a slow filter sweep, drum-machine kick, big gated
// snare, 8th hats, and lush chorused pads moving through minor-key progressions
// (i–VI–III–VII–iv). Kicks pump the pads and bass; traces end on a guitar squeal.
//   ADVERT  → full groove: pads + brass stabs + bass + drums
//   GRP_TXT → bass + drums only (the most frequent type, kept light)
//   TXT_MSG → slow pad swells over the bass, no drums
//   TRACE   → pluck arpeggios + bass + hats, ending in a guitar pinch-harmonic squeal
// Requires audio-synthkit.js and audio-v2-metal.js (guitar rig) to be loaded first.

(function () {
  'use strict';

  const { mapRange, panFor, sampleBytes } = MeshAudio.helpers;
  const kit = MeshAudio.synthkit;
  const guitar = window._meshAudioVoices.metal;

  const SCALE = [0, 2, 3, 5, 7, 8, 10]; // D natural minor
  const PROGRESSION = [0, 5, 2, 6, 3];  // i, VI, III, VII, iv
  const BASS_ROOT = 38;  // D2
  const PAD_ROOT = 50;   // D3
  const HIGH_ROOT = 62;  // D4
  const BASS_PATTERN = [0, 0, 12, 0, 7, 0, 12, 0]; // semitones over the chord root, per 8th
  const SWEEP_STEPS = 32; // bass filter opens and closes over two bars

  const noteAt = (base, d) => base + 12 * Math.floor(d / 7) + SCALE[d % 7];
  const triad = (base, d) => [noteAt(base, d), noteAt(base, d + 2), noteAt(base, d + 4)];
  const chordOf = (b) => PROGRESSION[Math.min(PROGRESSION.length - 1, Math.floor((b / 256) * PROGRESSION.length))];

  // Pure: packet → layered arrangement on a 16th-note grid. No audio here.
  // { steps, pads, stabs, arps: [{step,len,midis}], bass: [{step,len,midi,bright}],
  //   drums: [{step,kind:'kick'|'snare'|'hat',accent?}], guitar: [{step,len,midis,tech}] }
  function arrange(parsed) {
    const { payloadBytes, typeName } = parsed;
    const kind = ['GRP_TXT', 'TXT_MSG', 'TRACE'].includes(typeName) ? typeName : 'ADVERT';
    const bytes = sampleBytes(payloadBytes, 2, kind === 'GRP_TXT' ? 3 : 4);
    const out = { steps: 0, pads: [], stabs: [], arps: [], bass: [], drums: [], guitar: [] };
    let step = 0;

    bytes.forEach((b) => {
      const d = chordOf(b);
      const len = kind === 'TXT_MSG' || (b & 1) ? 8 : 4;
      const root = noteAt(BASS_ROOT, d);

      for (let s = step; s < step + len; s += 2) {
        const bright = 0.5 - 0.5 * Math.cos((2 * Math.PI * s) / SWEEP_STEPS);
        out.bass.push({ step: s, len: 2, midi: root + BASS_PATTERN[(s / 2) % BASS_PATTERN.length], bright });
      }
      if (kind === 'ADVERT' || kind === 'TXT_MSG') {
        out.pads.push({ step, len, midis: triad(PAD_ROOT, d).concat(noteAt(PAD_ROOT, d) + 12) });
      }
      if (kind === 'ADVERT') out.stabs.push({ step, len: 2, midis: triad(HIGH_ROOT, d) });
      if (kind === 'TRACE') {
        const tones = triad(HIGH_ROOT, d).concat(noteAt(HIGH_ROOT, d) + 12);
        for (let k = 0; k < len; k++) out.arps.push({ step: step + k, len: 1, midis: [tones[k % tones.length]] });
      }
      step += len;
    });

    if (kind === 'TRACE') {
      let squeal = noteAt(HIGH_ROOT, chordOf(bytes[bytes.length - 1])) + 19; // pinch harmonic: octave + fifth
      while (squeal > 93) squeal -= 12;
      out.guitar.push({ step, len: 6, midis: [squeal], tech: 'pinch' });
      step += 6;
    }
    out.steps = step;

    // Kick on 1 and 3 (plus the "and" of 3 on adverts), snare on 2 and 4, 8th hats.
    const drumEnd = kind === 'TRACE' ? step - 6 : step;
    for (let s = 0; kind !== 'TXT_MSG' && s < drumEnd; s += 2) {
      if (kind !== 'TRACE') {
        if (s % 8 === 0 || (kind === 'ADVERT' && s % 16 === 10)) out.drums.push({ step: s, kind: 'kick' });
        if (s % 8 === 4) out.drums.push({ step: s, kind: 'snare' });
      }
      out.drums.push({ step: s, kind: 'hat', accent: s % 4 === 2 });
    }
    return out;
  }

  const PAD = { detunes: [-12, 0, 12], cutoff: [500, 1800, 1300], filterAttack: 0.6, q: 1, attack: 0.35, sustain: 0.85, release: 0.9, level: 0.9 };
  const SWELL = Object.assign({}, PAD, { attack: 0.8, filterAttack: 1.2 });
  const STAB = { detunes: [-8, 0, 8], cutoff: [300, 3500, 900], filterAttack: 0.06, q: 1.5, attack: 0.015, sustain: 0.3, release: 0.2, level: 0.45 };
  const PLUCK = { type: 'square', detunes: [-6, 6], cutoff: [3000, 3500, 700], q: 3, attack: 0.003, sustain: 0.1, release: 0.12, level: 0.3 };
  const KICK = { from: 130, to: 48, sweep: 0.08, decay: 0.3, level: 1 };
  const SNARE = { level: 0.55, decay: 0.22, body: 200 };

  function play(audioCtx, masterGain, parsed, opts) {
    const { hopCount, obsCount, typeName } = parsed;
    const sixteenth = 0.125 * opts.tempoMultiplier;
    const bus = (name) => kit.bus(audioCtx, masterGain, name);
    const noise = bus('noise').buffer;
    const hall = bus('hall').input;
    const chorus = bus('chorus').input;
    const delay = bus('delay');
    delay.delays.forEach((d) => { d.delayTime.value = 3 * sixteenth; }); // dotted 8th

    const arr = arrange(parsed);

    // Per-packet mix; pads/stabs/bass share a bus that the kick pumps
    const { mix, nodes } = kit.createMix(audioCtx, masterGain, Math.min(0.7, 0.45 + (obsCount - 1) * 0.02));
    const padBus = audioCtx.createGain();
    padBus.connect(mix);
    const amp = arr.guitar.length
      ? guitar.buildAmp(audioCtx, mix, mapRange(Math.min(hopCount, 10), 1, 10, 5500, 1800), 0.3, panFor(parsed))
      : null;

    const t0 = kit.gridStart(audioCtx, sixteenth);
    const at = (step) => t0 + step * sixteenth;
    const durOf = (len) => Math.max(0.03, len * sixteenth - 0.02);
    let lastEnd = t0;
    const track = (t) => { if (t > lastEnd) lastEnd = t; };

    const padPreset = typeName === 'TXT_MSG' ? SWELL : PAD;
    arr.pads.forEach((ev) => track(kit.playSynth(audioCtx, padBus, padPreset, ev.midis, at(ev.step), durOf(ev.len),
      { sends: [[chorus, 0.7], [hall, 0.35]] })));
    arr.stabs.forEach((ev) => track(kit.playSynth(audioCtx, padBus, STAB, ev.midis, at(ev.step), durOf(ev.len),
      { sends: [[hall, 0.25], [chorus, 0.3]] })));
    arr.arps.forEach((ev) => track(kit.playSynth(audioCtx, padBus, PLUCK, ev.midis, at(ev.step), durOf(ev.len),
      { sends: [[delay.input, 0.3], [hall, 0.2]] })));
    arr.bass.forEach((ev) => track(kit.playBass(audioCtx, padBus, ev.midi, at(ev.step), durOf(ev.len),
      { cutoff: [300 + ev.bright * 1700, 180], q: 6, level: 0.4, maxDecay: 0.22 })));
    arr.guitar.forEach((ev) => track(guitar.playNote(audioCtx, amp.input, ev, at(ev.step), durOf(ev.len))));

    const recover = Math.min(0.25, 3.2 * sixteenth);
    arr.drums.forEach((ev) => {
      const t = at(ev.step);
      if (ev.kind === 'kick') {
        track(kit.playKick(audioCtx, mix, t, KICK));
        kit.duck(padBus.gain, t, recover, 0.55);
      } else if (ev.kind === 'snare') {
        track(kit.playSnare(audioCtx, mix, noise, t, [[bus('gated').input, 1.2], [hall, 0.35]], SNARE));
      } else {
        track(kit.playHat(audioCtx, mix, noise, t, ev.accent ? 0.18 : 0.12));
      }
    });

    // Echo/reverb tails ring in the shared effect buses, so the voice slot frees when the notes end.
    const cleanupMs = (lastEnd - audioCtx.currentTime + 1) * 1000;
    setTimeout(() => {
      nodes.concat(padBus, amp ? amp.nodes : []).forEach((n) => { try { n.disconnect(); } catch (e) {} });
    }, cleanupMs);

    return lastEnd - audioCtx.currentTime;
  }

  MeshAudio.registerVoice('technoir', { name: 'technoir', play, arrange });
})();
