// Voice v3: "Synthmetal" — distorted guitar + 80s synths, D harmonic minor
// Layers the metal voice's guitar rig with supersaw synths, a pulsing octave bass,
// kick + gated-reverb snare (sidechain-ducking the synths) and a ping-pong delay.
//   ADVERT  → guitar power chords + supersaw triad stabs, 8th bass, rock beat
//   GRP_TXT → palm-muted chugs + 16th octave bass, four-on-the-floor
//   TXT_MSG → supersaw lead with glide into the delay over a bass pedal
//   TRACE   → 16th arpeggios ending in a guitar pinch-harmonic squeal
// Riffs start on a shared 16th-note grid so overlapping packets stay in time.
// Requires audio-synthkit.js and audio-v2-metal.js (guitar rig) to be loaded first.

(function () {
  'use strict';

  const { buildScale, mapRange, quantizeToScale, panFor, sampleBytes } = MeshAudio.helpers;
  const kit = MeshAudio.synthkit;
  const guitar = window._meshAudioVoices.metal;

  const SCALE = [0, 2, 3, 5, 7, 8, 11];              // D harmonic minor
  const LEAD_SCALE = buildScale(SCALE, 62).slice(0, 15); // from D4, ~2 octaves
  const GTR_ROOT = 38;   // D2, drop-D open string (guitar + bass register)
  const SYNTH_ROOT = 62; // D4
  const LENGTHS = [2, 2, 3, 4]; // in 16ths

  const degree = (b) => Math.min(6, Math.floor((b / 256) * 7));
  const noteAt = (base, d) => base + 12 * Math.floor(d / 7) + SCALE[d % 7];
  const triad = (base, d) => [noteAt(base, d), noteAt(base, d + 2), noteAt(base, d + 4)];

  // Pure: packet → layered arrangement on a 16th-note grid. No audio here.
  // { steps, guitar: [{step,len,midis,tech}], synth: [{step,len,midis,kind}],
  //   bass: [{step,len,midi}], drums: [{step,kind}] }
  function arrange(parsed) {
    const { payloadBytes, typeName, obsCount } = parsed;
    const bytes = sampleBytes(payloadBytes, 3, 6);
    const powerChord = (root) => obsCount >= 3 ? [root, root + 7, root + 12] : [root, root + 7];
    const out = { steps: 0, guitar: [], synth: [], bass: [], drums: [] };
    let step = 0;

    // Octave-bouncing bass under [from, from + len) every `every` 16ths.
    // Root vs octave follows the global pulse, so the bounce runs across chord changes.
    const bassline = (root, from, len, every) => {
      for (let s = from; s < from + len; s += every) {
        out.bass.push({ step: s, len: Math.min(every, from + len - s), midi: Math.floor(s / every) % 2 ? root + 12 : root });
      }
    };

    bytes.forEach((b, i) => {
      const last = i === bytes.length - 1;
      const d = degree(b);
      switch (typeName) {
        case 'GRP_TXT':
          if (b < 176) {
            out.guitar.push({ step, len: 1, midis: [GTR_ROOT, GTR_ROOT + 7], tech: 'mute' });
            bassline(GTR_ROOT, step, 1, 1);
            step += 1;
          } else {
            const root = noteAt(GTR_ROOT, d);
            out.guitar.push({ step, len: 2, midis: powerChord(root), tech: 'chord' });
            out.synth.push({ step, len: 2, midis: triad(SYNTH_ROOT, d), kind: 'stab' });
            bassline(root, step, 2, 1);
            step += 2;
          }
          break;
        case 'TXT_MSG': {
          const len = last ? 6 : LENGTHS[b & 3];
          out.synth.push({ step, len, midis: [quantizeToScale(b, LEAD_SCALE)], kind: 'lead' });
          bassline(GTR_ROOT, step, len, 2);
          step += len;
          break;
        }
        case 'TRACE': {
          if (last) {
            let squeal = noteAt(SYNTH_ROOT, d) + 19; // pinch harmonic: octave + fifth up
            while (squeal > 93) squeal -= 12;
            out.guitar.push({ step, len: 6, midis: [squeal], tech: 'pinch' });
            step += 6;
          } else {
            const len = LENGTHS[b & 3];
            const tones = triad(SYNTH_ROOT, d).concat(noteAt(SYNTH_ROOT, d + 7));
            for (let k = 0; k < len; k++) {
              out.synth.push({ step: step + k, len: 1, midis: [tones[k % tones.length]], kind: 'arp' });
            }
            bassline(noteAt(GTR_ROOT, d), step, len, 2);
            step += len;
          }
          break;
        }
        default: { // ADVERT and everything else
          const len = last ? 4 : LENGTHS[b & 3];
          const root = noteAt(GTR_ROOT, d);
          out.guitar.push({ step, len, midis: powerChord(root), tech: 'chord' });
          out.synth.push({ step, len, midis: triad(SYNTH_ROOT, d), kind: 'stab' });
          bassline(root, step, len, 2);
          step += len;
        }
      }
    });
    out.steps = step;

    // Drums only under the riff types; leads and arps stay melodic.
    const fourOnFloor = typeName === 'GRP_TXT';
    if (typeName !== 'TXT_MSG' && typeName !== 'TRACE') {
      for (let s = 0; s < step; s += 4) {
        const backbeat = (s / 4) % 2 === 1; // beats 2 and 4
        if (fourOnFloor || !backbeat) out.drums.push({ step: s, kind: 'kick' });
        if (backbeat) out.drums.push({ step: s, kind: 'snare' });
      }
    }
    return out;
  }

  const SYNTHS = {
    stab: { detunes: [-14, 0, 14], cutoff: [600, 5000, 1500], q: 5, attack: 0.005, sustain: 0.6, release: 0.08, send: 0, level: 0.5 },
    lead: { detunes: [-20, -10, 0, 10, 20], cutoff: [1500, 4000, 3000], q: 2, attack: 0.01, sustain: 0.8, release: 0.15, send: 0.35, level: 1.6 },
    arp: { detunes: [-10, 0, 10], cutoff: [800, 3500, 1200], q: 4, attack: 0.003, sustain: 0.2, release: 0.05, send: 0.3, level: 0.65 },
  };

  function play(audioCtx, masterGain, parsed, opts) {
    const { hopCount, obsCount } = parsed;
    const sixteenth = 0.125 * opts.tempoMultiplier;
    const noise = kit.bus(audioCtx, masterGain, 'noise').buffer;
    const gated = kit.bus(audioCtx, masterGain, 'gated');
    const delay = kit.bus(audioCtx, masterGain, 'delay');
    delay.delays.forEach((d) => { d.delayTime.value = 3 * sixteenth; }); // dotted 8th

    const arr = arrange(parsed);

    // Per-packet mix: guitar amp + ducked synth bus + drums → glue limiter → master
    const { mix, nodes } = kit.createMix(audioCtx, masterGain, Math.min(0.45, 0.25 + (obsCount - 1) * 0.015));
    const synthBus = audioCtx.createGain();
    synthBus.connect(mix);

    const amp = arr.guitar.length
      ? guitar.buildAmp(audioCtx, mix, mapRange(Math.min(hopCount, 10), 1, 10, 5500, 1800), 0.3, panFor(parsed))
      : null;

    const t0 = kit.gridStart(audioCtx, sixteenth);
    const at = (step) => t0 + step * sixteenth;
    const durOf = (len) => Math.max(0.03, len * sixteenth - 0.02);
    let lastEnd = t0;
    const track = (t) => { if (t > lastEnd) lastEnd = t; };

    arr.guitar.forEach((ev) => track(guitar.playNote(audioCtx, amp.input, ev, at(ev.step), durOf(ev.len))));
    let prevLead = null;
    arr.synth.forEach((ev) => {
      const p = SYNTHS[ev.kind];
      track(kit.playSynth(audioCtx, synthBus, p, ev.midis, at(ev.step), durOf(ev.len), {
        glideFrom: ev.kind === 'lead' ? prevLead : null,
        sends: [[delay.input, p.send]],
      }));
      if (ev.kind === 'lead') prevLead = ev.midis[0];
    });
    arr.bass.forEach((ev) => track(kit.playBass(audioCtx, synthBus, ev.midi, at(ev.step), durOf(ev.len))));
    const recover = Math.min(0.18, 3.2 * sixteenth);
    arr.drums.forEach((ev) => {
      if (ev.kind === 'kick') {
        track(kit.playKick(audioCtx, mix, at(ev.step)));
        kit.duck(synthBus.gain, at(ev.step), recover);
      } else {
        track(kit.playSnare(audioCtx, mix, noise, at(ev.step), [[gated.input, 1]]));
      }
    });

    // Echo/reverb tails ring in the shared effect buses, so the voice slot frees when the notes end.
    const cleanupMs = (lastEnd - audioCtx.currentTime + 1) * 1000;
    setTimeout(() => {
      nodes.concat(synthBus, amp ? amp.nodes : []).forEach((n) => { try { n.disconnect(); } catch (e) {} });
    }, cleanupMs);

    return lastEnd - audioCtx.currentTime;
  }

  MeshAudio.registerVoice('synthmetal', { name: 'synthmetal', play, arrange });
})();
