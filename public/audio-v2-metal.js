// Voice v2: "Metal" — distorted electric guitar packet sonification
// Drop-D tuning. Each payload type gets a playing technique:
//   ADVERT  → power-chord riff          GRP_TXT → palm-muted chugs + accents
//   TXT_MSG → lead line with vibrato     TRACE   → bends ending in a pinch-harmonic squeal
// Payload bytes pick notes and rhythm on a 16th-note grid, hops darken the amp,
// observations thicken the chord (added octave) and raise the level.

(function () {
  'use strict';

  const { buildScale, midiToFreq, mapRange, quantizeToScale, panFor, sampleBytes } = MeshAudio.helpers;

  const LOW_D = 38; // D2 — open low string in drop-D
  const RIFF_SCALE = buildScale([0, 1, 3, 5, 7, 8, 10], LOW_D).slice(0, 10); // D Phrygian, ~1.5 octaves
  const LEAD_SCALE = buildScale([0, 3, 5, 7, 10], 62).slice(0, 11);         // D minor pentatonic from D4
  const LENGTHS = [2, 2, 3, 4]; // in 16ths: 8th, 8th, dotted 8th, quarter
  const DRIVE = 14;             // saturation amount inside the waveshaper curve

  // Pure: packet → list of note events on a 16th-note grid. No audio here.
  // event = { step, len, midis: [..], tech: 'chord' | 'mute' | 'lead' | 'bend' | 'pinch' }
  function buildRiff(parsed) {
    const { payloadBytes, typeName, obsCount } = parsed;
    const bytes = sampleBytes(payloadBytes, 3, 8);
    const withOctave = obsCount >= 3;
    const powerChord = (root) => withOctave ? [root, root + 7, root + 12] : [root, root + 7];

    const events = [];
    let step = 0;
    const push = (len, midis, tech) => { events.push({ step, len, midis, tech }); step += len; };

    bytes.forEach((b, i) => {
      const last = i === bytes.length - 1;
      switch (typeName) {
        case 'GRP_TXT':
          if (b < 176) push(1, [LOW_D, LOW_D + 7], 'mute');
          else push(2, powerChord(quantizeToScale(b, RIFF_SCALE)), 'chord');
          break;
        case 'TXT_MSG':
          push(last ? 6 : LENGTHS[b & 3], [quantizeToScale(b, LEAD_SCALE)], 'lead');
          break;
        case 'TRACE': {
          const midi = quantizeToScale(b, LEAD_SCALE);
          if (last) {
            // Pinch harmonic: third partial of the fretted note (octave + fifth up)
            let squeal = midi + 19;
            while (squeal > 93) squeal -= 12;
            push(6, [squeal], 'pinch');
          } else {
            push(LENGTHS[b & 3], [midi], 'bend');
          }
          break;
        }
        default: // ADVERT and everything else
          push(last ? 4 : LENGTHS[b & 3], powerChord(quantizeToScale(b, RIFF_SCALE)), 'chord');
      }
    });
    return events;
  }

  // Soft-clip transfer curve, built once and shared by every packet.
  let _curve = null;
  function distortionCurve() {
    if (_curve) return _curve;
    const n = 2048;
    const norm = Math.tanh(DRIVE);
    _curve = new Float32Array(n);
    for (let i = 0; i < n; i++) {
      const x = (i / (n - 1)) * 2 - 1;
      _curve[i] = Math.tanh(DRIVE * x) / norm;
    }
    return _curve;
  }

  function biquad(audioCtx, type, freq, q, gainDb) {
    const f = audioCtx.createBiquadFilter();
    f.type = type;
    f.frequency.value = freq;
    f.Q.value = q;
    if (gainDb !== undefined) f.gain.value = gainDb;
    return f;
  }

  // Amp chain shared by all notes of one packet:
  // tighten HP → distortion → cab (thump, mid scoop, presence, hop-driven LP) → level → limiter → pan → master
  function buildAmp(audioCtx, masterGain, cabLowpass, level, pan) {
    const shaper = audioCtx.createWaveShaper();
    shaper.curve = distortionCurve();
    shaper.oversample = '4x';

    const stages = [
      biquad(audioCtx, 'highpass', 110, 0.5),
      shaper,
      biquad(audioCtx, 'highpass', 70, 0.7),
      biquad(audioCtx, 'peaking', 120, 0.8, 3),
      biquad(audioCtx, 'peaking', 500, 0.8, -5),
      biquad(audioCtx, 'peaking', 2800, 1, 4),
      biquad(audioCtx, 'lowpass', cabLowpass, 0.9),
    ];

    const out = audioCtx.createGain();
    out.gain.value = level;

    const limiter = audioCtx.createDynamicsCompressor();
    limiter.threshold.value = -6;
    limiter.knee.value = 6;
    limiter.ratio.value = 12;
    limiter.attack.value = 0.001;
    limiter.release.value = 0.05;

    const panner = audioCtx.createStereoPanner();
    panner.pan.value = pan;

    const chain = stages.concat([out, limiter, panner]);
    for (let i = 0; i < chain.length - 1; i++) chain[i].connect(chain[i + 1]);
    panner.connect(masterGain);
    return { input: stages[0], nodes: chain };
  }

  // Delayed vibrato on an oscillator's pitch (lead / bend / pinch).
  function addVibrato(audioCtx, osc, freq, start, end, depth) {
    const lfo = audioCtx.createOscillator();
    const lfoGain = audioCtx.createGain();
    lfo.frequency.value = 5.5;
    lfoGain.gain.setValueAtTime(0, start);
    lfoGain.gain.linearRampToValueAtTime(freq * depth, Math.min(end, start + 0.2));
    lfo.connect(lfoGain);
    lfoGain.connect(osc.frequency);
    lfo.start(start);
    lfo.stop(end + 0.2);
    lfo.onended = () => { lfo.disconnect(); lfoGain.disconnect(); };
  }

  function playNote(audioCtx, ampInput, ev, start, dur) {
    const end = start + dur;
    const muted = ev.tech === 'mute';
    const lead = ev.tech === 'lead' || ev.tech === 'bend' || ev.tech === 'pinch';

    // Note envelope sits before the distortion, like a string into an amp.
    const env = audioCtx.createGain();
    const oscCount = ev.midis.length * 2;
    const peak = (ev.tech === 'pinch' ? 0.35 : 0.6) / oscCount;
    env.gain.setValueAtTime(0.0001, start);
    env.gain.exponentialRampToValueAtTime(peak, start + 0.004);
    if (muted) {
      env.gain.exponentialRampToValueAtTime(0.0001, start + Math.min(dur, 0.11));
    } else {
      env.gain.exponentialRampToValueAtTime(peak * 0.4, end);
      env.gain.setTargetAtTime(0.0001, end, 0.03);
    }

    // Palm mute: a closing lowpass before the amp makes the chug.
    let noteOut = env;
    let muteFilter = null;
    if (muted) {
      muteFilter = biquad(audioCtx, 'lowpass', 900, 1);
      muteFilter.frequency.setValueAtTime(900, start);
      muteFilter.frequency.exponentialRampToValueAtTime(250, start + 0.06);
      env.connect(muteFilter);
      noteOut = muteFilter;
    }
    noteOut.connect(ampInput);

    const stopAt = end + 0.2;
    let live = 0;
    ev.midis.forEach((midi) => {
      const freq = midiToFreq(midi);
      [-6, 6].forEach((cents) => {
        const osc = audioCtx.createOscillator();
        osc.type = 'sawtooth';
        osc.detune.value = cents;
        if (ev.tech === 'bend') {
          // Whole-step bend up into the target note
          osc.frequency.setValueAtTime(freq * Math.pow(2, -2 / 12), start);
          osc.frequency.exponentialRampToValueAtTime(freq, start + Math.min(0.12, dur * 0.4));
        } else {
          osc.frequency.setValueAtTime(freq, start);
        }
        if (lead) addVibrato(audioCtx, osc, freq, start + 0.1, end, ev.tech === 'pinch' ? 0.025 : 0.012);
        osc.connect(env);
        osc.start(start);
        osc.stop(stopAt);
        live++;
        osc.onended = () => {
          osc.disconnect();
          if (--live === 0) {
            env.disconnect();
            if (muteFilter) muteFilter.disconnect();
          }
        };
      });
    });
    return stopAt;
  }

  function play(audioCtx, masterGain, parsed, opts) {
    const { hopCount, obsCount } = parsed;
    const sixteenth = 0.125 * opts.tempoMultiplier; // 16th note at the engine BPM

    const cabLowpass = mapRange(Math.min(hopCount, 10), 1, 10, 5500, 1800);
    const level = Math.min(0.2, 0.1 + (obsCount - 1) * 0.01);
    const amp = buildAmp(audioCtx, masterGain, cabLowpass, level, panFor(parsed));

    const t0 = audioCtx.currentTime + 0.02;
    let lastEnd = t0;
    buildRiff(parsed).forEach((ev) => {
      // Slight gap between notes keeps the riff articulated
      const dur = Math.max(0.05, ev.len * sixteenth - 0.02);
      lastEnd = Math.max(lastEnd, playNote(audioCtx, amp.input, ev, t0 + ev.step * sixteenth, dur));
    });

    const cleanupMs = (lastEnd - audioCtx.currentTime + 1) * 1000;
    setTimeout(() => {
      amp.nodes.forEach((n) => { try { n.disconnect(); } catch (e) {} });
    }, cleanupMs);

    return lastEnd - audioCtx.currentTime;
  }

  // buildAmp / playNote are the guitar rig, reused by the synthmetal voice.
  MeshAudio.registerVoice('metal', { name: 'metal', play, buildRiff, distortionCurve, buildAmp, playNote });
})();
