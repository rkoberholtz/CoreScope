// Synth kit — shared instruments and effects for the synth-based voices
// (synthmetal, technoir, ambient, dub, acid, lofi). Exposed as MeshAudio.synthkit.
// Effects buses are built lazily, once per AudioContext, and shared by every packet.

(function () {
  'use strict';

  const { midiToFreq } = MeshAudio.helpers;

  // === Shared effects buses ===

  const BUILDERS = {
    // White noise buffer for snares and hats
    noise(audioCtx) {
      const sr = audioCtx.sampleRate || 44100;
      const buffer = audioCtx.createBuffer(1, Math.floor(sr * 0.5), sr);
      const d = buffer.getChannelData(0);
      for (let i = 0; i < d.length; i++) d[i] = Math.random() * 2 - 1;
      return { buffer };
    },
    // 80s gated reverb: dense noise impulse that stops dead at 300ms
    gated(audioCtx, masterGain) {
      return convolverBus(audioCtx, masterGain, 0.3, 0.25, (i, n) => 1 - 0.5 * i / n);
    },
    // Long hall reverb for pads and drums
    hall(audioCtx, masterGain) {
      return convolverBus(audioCtx, masterGain, 2.4, 0.3, (i, n) => Math.pow(1 - i / n, 3));
    },
    // Ping-pong delay with darkening repeats; time set per packet via setDelayTime
    delay(audioCtx, masterGain) {
      const input = audioCtx.createGain();
      const left = audioCtx.createDelay(2);
      const right = audioCtx.createDelay(2);
      const damp = audioCtx.createBiquadFilter();
      damp.type = 'lowpass';
      damp.frequency.value = 2800;
      const fbLR = audioCtx.createGain();
      const fbRL = audioCtx.createGain();
      fbLR.gain.value = 0.4;
      fbRL.gain.value = 0.4;
      const panL = audioCtx.createStereoPanner();
      const panR = audioCtx.createStereoPanner();
      panL.pan.value = -0.7;
      panR.pan.value = 0.7;
      input.connect(left);
      left.connect(panL);
      left.connect(damp);
      damp.connect(fbLR);
      fbLR.connect(right);
      right.connect(panR);
      right.connect(fbRL);
      fbRL.connect(left);
      panL.connect(masterGain);
      panR.connect(masterGain);
      return { input, delays: [left, right] };
    },
    // Dub echo: one long delay with heavy, darkening, thinning feedback (capped
    // well below 1 so it can't run away). Time set per packet like 'delay'.
    dubecho(audioCtx, masterGain) {
      const input = audioCtx.createGain();
      const hp = audioCtx.createBiquadFilter();
      hp.type = 'highpass';
      hp.frequency.value = 250;
      const echo = audioCtx.createDelay(2);
      const lp = audioCtx.createBiquadFilter();
      lp.type = 'lowpass';
      lp.frequency.value = 1800;
      const fb = audioCtx.createGain();
      fb.gain.value = 0.65;
      const out = audioCtx.createGain();
      out.gain.value = 0.8;
      input.connect(hp);
      hp.connect(echo);
      echo.connect(out);
      echo.connect(lp);
      lp.connect(fb);
      fb.connect(echo);
      out.connect(masterGain);
      return { input, delays: [echo] };
    },
    // Vinyl crackle: faint hiss with sparse random clicks, looped per packet
    crackle(audioCtx) {
      const sr = audioCtx.sampleRate || 44100;
      const buffer = audioCtx.createBuffer(1, Math.floor(sr * 2), sr);
      const d = buffer.getChannelData(0);
      let click = 0;
      for (let i = 0; i < d.length; i++) {
        if (Math.random() < 20 / sr) click = 0.3 + Math.random() * 0.5; // ~20 clicks/s
        d[i] = (Math.random() * 2 - 1) * (0.02 + click);
        click *= 0.8;
      }
      return { buffer };
    },
    // Stereo chorus: two short delays swept by one slow LFO in opposite directions
    chorus(audioCtx, masterGain) {
      const input = audioCtx.createGain();
      const lfo = audioCtx.createOscillator();
      lfo.frequency.value = 0.6;
      [[-0.8, 0.012, 0.003], [0.8, 0.018, -0.003]].forEach(([pan, base, depth]) => {
        const d = audioCtx.createDelay(0.05);
        d.delayTime.value = base;
        const mod = audioCtx.createGain();
        mod.gain.value = depth;
        lfo.connect(mod);
        mod.connect(d.delayTime);
        const p = audioCtx.createStereoPanner();
        p.pan.value = pan;
        input.connect(d);
        d.connect(p);
        p.connect(masterGain);
      });
      lfo.start();
      return { input };
    },
  };

  function convolverBus(audioCtx, masterGain, seconds, wet, shape) {
    const sr = audioCtx.sampleRate || 44100;
    const n = Math.floor(sr * seconds);
    const ir = audioCtx.createBuffer(2, n, sr);
    for (let c = 0; c < 2; c++) {
      const d = ir.getChannelData(c);
      for (let i = 0; i < n; i++) d[i] = (Math.random() * 2 - 1) * shape(i, n);
    }
    const input = audioCtx.createGain();
    const verb = audioCtx.createConvolver();
    verb.buffer = ir;
    const out = audioCtx.createGain();
    out.gain.value = wet;
    input.connect(verb);
    verb.connect(out);
    out.connect(masterGain);
    return { input };
  }

  const _buses = new WeakMap();
  function bus(audioCtx, masterGain, name) {
    let m = _buses.get(audioCtx);
    if (!m) { m = {}; _buses.set(audioCtx, m); }
    return m[name] || (m[name] = BUILDERS[name](audioCtx, masterGain));
  }

  // === Timing / mixing ===

  // Next 16th on the shared grid, so concurrent packets lock together
  function gridStart(audioCtx, sixteenth) {
    return Math.ceil((audioCtx.currentTime + 0.02) / sixteenth) * sixteenth;
  }

  // Time of a grid step with swing: odd 16ths are pushed late by swing × a 16th.
  // Start swung riffs on an 8th boundary (gridStart(ctx, 2 * sixteenth)) so the
  // odd/even steps line up with every other packet.
  function stepTime(t0, step, sixteenth, swing) {
    return t0 + step * sixteenth + (step % 2 ? (swing || 0) * sixteenth : 0);
  }

  // Per-packet mix: gain → glue limiter → master
  function createMix(audioCtx, masterGain, level) {
    const mix = audioCtx.createGain();
    mix.gain.value = level;
    const limiter = audioCtx.createDynamicsCompressor();
    limiter.threshold.value = -8;
    limiter.knee.value = 6;
    limiter.ratio.value = 8;
    limiter.attack.value = 0.003;
    limiter.release.value = 0.1;
    mix.connect(limiter);
    limiter.connect(masterGain);
    return { mix, nodes: [mix, limiter] };
  }

  // Sidechain pump: dip a bus on each kick.
  function duck(param, t, recover, depth) {
    param.setValueAtTime(1, t);
    param.linearRampToValueAtTime(depth || 0.35, t + 0.01);
    param.linearRampToValueAtTime(1, t + recover);
  }

  function connectSends(audioCtx, from, sends) {
    return (sends || []).filter(([, amount]) => amount > 0).map(([input, amount]) => {
      const g = audioCtx.createGain();
      g.gain.value = amount;
      from.connect(g);
      g.connect(input);
      return g;
    });
  }

  // === Instruments ===

  // Detuned oscillator stack through a resonant, enveloped lowpass.
  // preset: { type?, detunes, cutoff: [start, peak, end], filterAttack?, q, attack, sustain, release, level }
  // opts: { glideFrom (midi), sends: [[busInput, amount], ...] }
  function playSynth(audioCtx, dest, preset, midis, start, dur, opts) {
    const p = preset;
    const o = opts || {};
    const end = Math.max(start + dur, start + 0.04);
    const filterPeak = Math.min(end, start + (p.filterAttack || 0.03));
    const filter = audioCtx.createBiquadFilter();
    filter.type = 'lowpass';
    filter.Q.value = p.q;
    filter.frequency.setValueAtTime(p.cutoff[0], start);
    filter.frequency.exponentialRampToValueAtTime(p.cutoff[1], filterPeak);
    filter.frequency.exponentialRampToValueAtTime(p.cutoff[2], Math.max(end, filterPeak + 0.01));

    const env = audioCtx.createGain();
    const peak = p.level / (midis.length * p.detunes.length);
    env.gain.setValueAtTime(0.0001, start);
    env.gain.exponentialRampToValueAtTime(peak, start + Math.min(p.attack, dur));
    env.gain.exponentialRampToValueAtTime(Math.max(peak * p.sustain, 0.0001), end);
    env.gain.setTargetAtTime(0.0001, end, p.release / 3);
    filter.connect(env);
    env.connect(dest);
    const sendNodes = connectSends(audioCtx, env, o.sends);

    const stopAt = end + p.release + 0.1;
    let live = 0;
    midis.forEach((midi) => {
      const freq = midiToFreq(midi);
      p.detunes.forEach((cents) => {
        const osc = audioCtx.createOscillator();
        osc.type = p.type || 'sawtooth';
        osc.detune.value = cents;
        if (o.glideFrom != null && o.glideFrom !== midi) {
          osc.frequency.setValueAtTime(midiToFreq(o.glideFrom), start);
          osc.frequency.exponentialRampToValueAtTime(freq, start + 0.05);
        } else {
          osc.frequency.setValueAtTime(freq, start);
        }
        osc.connect(filter);
        osc.start(start);
        osc.stop(stopAt);
        live++;
        osc.onended = () => {
          osc.disconnect();
          if (--live === 0) { filter.disconnect(); env.disconnect(); sendNodes.forEach((g) => g.disconnect()); }
        };
      });
    });
    return stopAt;
  }

  // Two-operator FM: a sine modulator at freq × ratio drives the carrier's pitch,
  // with its depth (index) decaying — bells (inharmonic ratio) or electric piano
  // (ratio 1). preset: { ratio, index: [peak, settled], indexDecay, attack, decay,
  // sustain, release, level }. opts: { sends, pitchMod (node → both detunes) }
  function playFM(audioCtx, dest, preset, midis, start, dur, opts) {
    const p = preset;
    const o = opts || {};
    const end = Math.max(start + dur, start + 0.04);
    const env = audioCtx.createGain();
    const peak = p.level / midis.length;
    const decayEnd = Math.min(end, start + p.attack + p.decay);
    env.gain.setValueAtTime(0.0001, start);
    env.gain.exponentialRampToValueAtTime(peak, start + Math.min(p.attack, dur));
    env.gain.exponentialRampToValueAtTime(Math.max(peak * p.sustain, 0.0001), Math.max(decayEnd, start + Math.min(p.attack, dur) + 0.01));
    env.gain.setTargetAtTime(0.0001, end, p.release / 3);
    env.connect(dest);
    const sendNodes = connectSends(audioCtx, env, o.sends);

    const stopAt = end + p.release + 0.1;
    let live = 0;
    midis.forEach((midi) => {
      const freq = midiToFreq(midi);
      const carrier = audioCtx.createOscillator();
      const mod = audioCtx.createOscillator();
      const depth = audioCtx.createGain();
      carrier.type = 'sine';
      mod.type = 'sine';
      carrier.frequency.setValueAtTime(freq, start);
      mod.frequency.setValueAtTime(freq * p.ratio, start);
      depth.gain.setValueAtTime(freq * p.index[0], start);
      depth.gain.exponentialRampToValueAtTime(Math.max(freq * p.index[1], 0.01), start + p.indexDecay);
      mod.connect(depth);
      depth.connect(carrier.frequency);
      carrier.connect(env);
      if (o.pitchMod) { o.pitchMod.connect(carrier.detune); o.pitchMod.connect(mod.detune); }
      [carrier, mod].forEach((osc) => {
        osc.start(start);
        osc.stop(stopAt);
        live++;
        osc.onended = () => {
          osc.disconnect();
          if (osc === mod) depth.disconnect();
          if (--live === 0) { env.disconnect(); sendNodes.forEach((g) => g.disconnect()); }
        };
      });
    });
    return stopAt;
  }

  // 303-style acid step: one saw through a very resonant lowpass whose envelope
  // snaps open on each note; accents open further and play louder, slides glide
  // in from the previous note. ev: { midi, accent, slide, prevMidi }
  // p: { cutoff, q, envMod, decay, level }
  function playAcid(audioCtx, dest, ev, start, dur, p) {
    const osc = audioCtx.createOscillator();
    const filter = audioCtx.createBiquadFilter();
    const env = audioCtx.createGain();
    const freq = midiToFreq(ev.midi);
    const end = Math.max(start + dur, start + 0.03);
    osc.type = 'sawtooth';
    if (ev.slide && ev.prevMidi != null) {
      osc.frequency.setValueAtTime(midiToFreq(ev.prevMidi), start);
      osc.frequency.exponentialRampToValueAtTime(freq, start + 0.06);
    } else {
      osc.frequency.setValueAtTime(freq, start);
    }
    filter.type = 'lowpass';
    filter.Q.value = p.q;
    const peakCut = p.cutoff * (1 + p.envMod * (ev.accent ? 1.6 : 1));
    filter.frequency.setValueAtTime(peakCut, start);
    filter.frequency.exponentialRampToValueAtTime(p.cutoff, start + p.decay * (ev.accent ? 0.6 : 1));
    const level = p.level * (ev.accent ? 1.4 : 1);
    env.gain.setValueAtTime(ev.slide ? level * 0.8 : 0.0001, start);
    env.gain.exponentialRampToValueAtTime(level, start + 0.003);
    env.gain.setValueAtTime(level, end);
    env.gain.exponentialRampToValueAtTime(0.0001, end + 0.02);
    osc.connect(filter);
    filter.connect(env);
    env.connect(dest);
    osc.start(start);
    osc.stop(end + 0.05);
    osc.onended = () => { osc.disconnect(); filter.disconnect(); env.disconnect(); };
    return end + 0.05;
  }

  // Looped vinyl crackle under a packet, from the shared 'crackle' buffer
  function playCrackle(audioCtx, dest, buffer, start, end, level) {
    const src = audioCtx.createBufferSource();
    src.buffer = buffer;
    src.loop = true;
    const bp = audioCtx.createBiquadFilter();
    bp.type = 'bandpass';
    bp.frequency.value = 2500;
    bp.Q.value = 0.7;
    const g = audioCtx.createGain();
    g.gain.value = level;
    src.connect(bp);
    bp.connect(g);
    g.connect(dest);
    src.start(start);
    src.stop(end);
    src.onended = () => { src.disconnect(); bp.disconnect(); g.disconnect(); };
    return end;
  }

  // Plucked saw bass. p: { cutoff: [open, closed], q, level, maxDecay }
  const BASS_DEFAULT = { cutoff: [1400, 220], q: 4, level: 0.35, maxDecay: 0.2 };
  function playBass(audioCtx, dest, midi, start, dur, params) {
    const p = Object.assign({}, BASS_DEFAULT, params);
    const osc = audioCtx.createOscillator();
    const filter = audioCtx.createBiquadFilter();
    const env = audioCtx.createGain();
    const decayEnd = start + Math.max(0.04, Math.min(dur, p.maxDecay));
    osc.type = 'sawtooth';
    osc.frequency.setValueAtTime(midiToFreq(midi), start);
    filter.type = 'lowpass';
    filter.Q.value = p.q;
    filter.frequency.setValueAtTime(p.cutoff[0], start);
    filter.frequency.exponentialRampToValueAtTime(p.cutoff[1], decayEnd);
    env.gain.setValueAtTime(0.0001, start);
    env.gain.exponentialRampToValueAtTime(p.level, start + 0.004);
    env.gain.exponentialRampToValueAtTime(0.0001, decayEnd);
    osc.connect(filter);
    filter.connect(env);
    env.connect(dest);
    osc.start(start);
    osc.stop(decayEnd + 0.05);
    osc.onended = () => { osc.disconnect(); filter.disconnect(); env.disconnect(); };
    return decayEnd + 0.05;
  }

  // Sine kick with a pitch drop. p: { from, to, sweep, decay, level }
  const KICK_DEFAULT = { from: 150, to: 42, sweep: 0.11, decay: 0.35, level: 0.9 };
  function playKick(audioCtx, dest, start, params) {
    const p = Object.assign({}, KICK_DEFAULT, params);
    const osc = audioCtx.createOscillator();
    const env = audioCtx.createGain();
    osc.type = 'sine';
    osc.frequency.setValueAtTime(p.from, start);
    osc.frequency.exponentialRampToValueAtTime(p.to, start + p.sweep);
    env.gain.setValueAtTime(p.level, start);
    env.gain.exponentialRampToValueAtTime(0.001, start + p.decay);
    osc.connect(env);
    env.connect(dest);
    osc.start(start);
    osc.stop(start + p.decay + 0.05);
    osc.onended = () => { osc.disconnect(); env.disconnect(); };
    return start + p.decay + 0.05;
  }

  // Noise snare with a tonal body. sends: [[busInput, amount], ...]
  const SNARE_DEFAULT = { level: 0.5, decay: 0.18, body: 185 };
  function playSnare(audioCtx, dest, noise, start, sends, params) {
    const p = Object.assign({}, SNARE_DEFAULT, params);
    const src = audioCtx.createBufferSource();
    src.buffer = noise;
    const hp = audioCtx.createBiquadFilter();
    hp.type = 'highpass';
    hp.frequency.value = 1200;
    const noiseEnv = audioCtx.createGain();
    noiseEnv.gain.setValueAtTime(p.level, start);
    noiseEnv.gain.exponentialRampToValueAtTime(0.001, start + p.decay);
    src.connect(hp);
    hp.connect(noiseEnv);
    noiseEnv.connect(dest);
    const sendNodes = connectSends(audioCtx, noiseEnv, sends);

    const body = audioCtx.createOscillator();
    const bodyEnv = audioCtx.createGain();
    body.type = 'triangle';
    body.frequency.value = p.body;
    bodyEnv.gain.setValueAtTime(p.level * 0.6, start);
    bodyEnv.gain.exponentialRampToValueAtTime(0.001, start + 0.08);
    body.connect(bodyEnv);
    bodyEnv.connect(dest);

    src.start(start);
    src.stop(start + p.decay + 0.02);
    body.start(start);
    body.stop(start + 0.1);
    src.onended = () => { src.disconnect(); hp.disconnect(); noiseEnv.disconnect(); sendNodes.forEach((g) => g.disconnect()); };
    body.onended = () => { body.disconnect(); bodyEnv.disconnect(); };
    return start + p.decay + 0.02;
  }

  // Closed hi-hat: short high-passed noise tick
  function playHat(audioCtx, dest, noise, start, level) {
    const src = audioCtx.createBufferSource();
    src.buffer = noise;
    const hp = audioCtx.createBiquadFilter();
    hp.type = 'highpass';
    hp.frequency.value = 7000;
    const env = audioCtx.createGain();
    env.gain.setValueAtTime(level, start);
    env.gain.exponentialRampToValueAtTime(0.001, start + 0.05);
    src.connect(hp);
    hp.connect(env);
    env.connect(dest);
    src.start(start);
    src.stop(start + 0.06);
    src.onended = () => { src.disconnect(); hp.disconnect(); env.disconnect(); };
    return start + 0.06;
  }

  MeshAudio.synthkit = {
    bus, gridStart, stepTime, createMix, duck,
    playSynth, playFM, playAcid, playBass, playKick, playSnare, playHat, playCrackle,
  };
})();
