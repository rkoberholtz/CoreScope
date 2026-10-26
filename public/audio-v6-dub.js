// Voice v6: "Dub" — reggae/dub, A natural minor
// One-drop drums (kick + rimshot on beat 3), offbeat chord skanks and rims thrown
// into a long feedback echo, a deep bass line, and a dub siren on traces.
//   ADVERT  → two bars: skanks + bass + one-drop
//   GRP_TXT → one bar of skanks + rimshot (light, it's the most frequent type)
//   TXT_MSG → one bar: bass line + skanks, no drums
//   TRACE   → a dub siren sweep + rimshots into the echo
// More hops send more into the echo, so long routes trail away; observers
// widen the skanks' stereo spread. Requires audio-synthkit.js.

(function () {
  'use strict';

  const { sampleBytes, midiToFreq } = MeshAudio.helpers;
  const kit = MeshAudio.synthkit;

  const SCALE = [0, 2, 3, 5, 7, 8, 10]; // A natural minor
  const ROOT = 45;                        // A2
  const CHORDS = [0, 3, 6, 4];            // i, iv, VII, v
  const noteAt = (base, d) => base + 12 * Math.floor(d / 7) + SCALE[d % 7];
  const triad = (base, d) => [noteAt(base, d), noteAt(base, d + 2), noteAt(base, d + 4)];
  const chordOf = (b) => CHORDS[Math.min(CHORDS.length - 1, Math.floor((b / 256) * CHORDS.length))];

  // Pure: packet → one-bar-per-chord arrangement on a 16th grid. No audio here.
  // { steps, skanks: [{step,midis,side}], bass: [{step,len,midi}],
  //   drums: [{step,kind:'kick'|'rim'}], sirens: [{step,len,midi}] }
  function arrange(parsed) {
    const { payloadBytes, typeName } = parsed;
    const kind = ['GRP_TXT', 'TXT_MSG', 'TRACE'].includes(typeName) ? typeName : 'ADVERT';
    const out = { steps: 0, skanks: [], bass: [], drums: [], sirens: [] };

    if (kind === 'TRACE') {
      const bytes = sampleBytes(payloadBytes, 2, 3);
      bytes.forEach((b, i) => {
        out.sirens.push({ step: i * 8, len: 8, midi: noteAt(69, b % 5) }); // from A4..E5
        out.drums.push({ step: i * 8 + 6, kind: 'rim' });
      });
      out.steps = bytes.length * 8;
      return out;
    }

    const bars = kind === 'ADVERT' ? sampleBytes(payloadBytes, 2, 2) : sampleBytes(payloadBytes, 1, 1);
    bars.forEach((b, bar) => {
      const d = chordOf(b);
      const s0 = bar * 16;
      // Skanks on the offbeat 8ths ("and" of each beat), alternating sides
      [2, 6, 10, 14].forEach((s, k) => out.skanks.push({ step: s0 + s, midis: triad(ROOT + 12, d), side: k % 2 ? 1 : -1 }));
      if (kind !== 'GRP_TXT') {
        // Bass: root and fifth on the beats; the byte picks a passing tone before beat 3 and the last note's octave
        const root = noteAt(ROOT, d);
        out.bass.push({ step: s0, len: 3, midi: root });
        out.bass.push({ step: s0 + 4, len: 2, midi: root });
        out.bass.push({ step: s0 + 7, len: 1, midi: noteAt(ROOT, d + 1 + (b & 1)) });
        out.bass.push({ step: s0 + 8, len: 3, midi: noteAt(ROOT, d + 4) });
        out.bass.push({ step: s0 + 12, len: 2, midi: root + (b & 2 ? 12 : 0) });
      }
      if (kind !== 'TXT_MSG') {
        // One drop: kick and rimshot together on beat 3
        if (kind === 'ADVERT') out.drums.push({ step: s0 + 8, kind: 'kick' });
        out.drums.push({ step: s0 + 8, kind: 'rim' });
      }
    });
    out.steps = bars.length * 16;
    return out;
  }

  const SKANK = { type: 'square', detunes: [-5, 5], cutoff: [2600, 2200, 1400], q: 1, attack: 0.003, sustain: 0.15, release: 0.05, level: 0.6 };
  const BASS = { type: 'triangle', detunes: [0], cutoff: [700, 700, 500], q: 0.5, attack: 0.01, sustain: 0.9, release: 0.08, level: 0.5 };
  const RIM = { level: 0.35, decay: 0.07, body: 420 };
  const KICK = { from: 110, to: 45, sweep: 0.1, decay: 0.4, level: 0.9 };

  // Dub siren: a sine sweeping up and back down, straight into the echo
  function playSiren(audioCtx, dest, echoIn, midi, start, dur) {
    const osc = audioCtx.createOscillator();
    const env = audioCtx.createGain();
    const send = audioCtx.createGain();
    const f = midiToFreq(midi);
    osc.type = 'sine';
    osc.frequency.setValueAtTime(f, start);
    osc.frequency.exponentialRampToValueAtTime(f * 2, start + dur * 0.5);
    osc.frequency.exponentialRampToValueAtTime(f, start + dur);
    env.gain.setValueAtTime(0.0001, start);
    env.gain.exponentialRampToValueAtTime(0.12, start + 0.05);
    env.gain.setValueAtTime(0.12, start + dur * 0.8);
    env.gain.exponentialRampToValueAtTime(0.0001, start + dur);
    send.gain.value = 0.8;
    osc.connect(env);
    env.connect(dest);
    env.connect(send);
    send.connect(echoIn);
    osc.start(start);
    osc.stop(start + dur + 0.05);
    osc.onended = () => { osc.disconnect(); env.disconnect(); send.disconnect(); };
    return start + dur + 0.05;
  }

  function play(audioCtx, masterGain, parsed, opts) {
    const { hopCount, obsCount } = parsed;
    const sixteenth = 0.125 * opts.tempoMultiplier;
    const noise = kit.bus(audioCtx, masterGain, 'noise').buffer;
    const hall = kit.bus(audioCtx, masterGain, 'hall').input;
    const echo = kit.bus(audioCtx, masterGain, 'dubecho');
    echo.delays[0].delayTime.value = 3 * sixteenth; // dotted 8th

    const arr = arrange(parsed);
    const distance = Math.min(1, (hopCount - 1) / 9);
    const throwAmount = 0.25 + 0.55 * distance; // more hops → more echo
    const width = Math.min(0.8, 0.2 + 0.1 * (obsCount - 1));

    const { mix, nodes } = kit.createMix(audioCtx, masterGain, Math.min(0.7, 0.5 + (obsCount - 1) * 0.015));
    const sides = [-1, 1].map((side) => {
      const p = audioCtx.createStereoPanner();
      p.pan.value = side * width;
      p.connect(mix);
      return p;
    });

    const t0 = kit.gridStart(audioCtx, sixteenth);
    const at = (step) => t0 + step * sixteenth;
    let lastEnd = t0;
    const track = (t) => { if (t > lastEnd) lastEnd = t; };

    arr.skanks.forEach((ev) => track(kit.playSynth(audioCtx, sides[ev.side > 0 ? 1 : 0], SKANK, ev.midis, at(ev.step), sixteenth * 0.9,
      { sends: [[echo.input, throwAmount]] })));
    arr.bass.forEach((ev) => track(kit.playSynth(audioCtx, mix, BASS, [ev.midi], at(ev.step), ev.len * sixteenth - 0.02)));
    arr.sirens.forEach((ev) => track(playSiren(audioCtx, mix, echo.input, ev.midi, at(ev.step), ev.len * sixteenth)));
    arr.drums.forEach((ev) => {
      if (ev.kind === 'kick') track(kit.playKick(audioCtx, mix, at(ev.step), KICK));
      else track(kit.playSnare(audioCtx, mix, noise, at(ev.step), [[echo.input, throwAmount + 0.2], [hall, 0.15]], RIM));
    });

    // Echo tails ring in the shared bus, so the voice slot frees when the notes end.
    setTimeout(() => {
      nodes.concat(sides).forEach((n) => { try { n.disconnect(); } catch (e) {} });
    }, (lastEnd - audioCtx.currentTime + 1) * 1000);
    return lastEnd - audioCtx.currentTime;
  }

  MeshAudio.registerVoice('dub', { name: 'dub', play, arrange });
})();
