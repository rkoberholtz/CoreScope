/* Shared harness for audio voice unit tests: a graph-recording fake
 * AudioContext and a loader that runs the real public/audio*.js files
 * in a vm context. Not a test suite itself. */
'use strict';
const vm = require('vm');
const fs = require('fs');

function makeParam(value) {
  const p = { value: value || 0, events: [], inputs: [] };
  ['setValueAtTime', 'linearRampToValueAtTime', 'exponentialRampToValueAtTime', 'setTargetAtTime']
    .forEach((m) => { p[m] = (v, t) => { p.events.push({ m, v, t }); return p; }; });
  return p;
}

class FakeCtx {
  constructor(currentTime) {
    this.state = 'running';
    this.currentTime = currentTime || 0;
    this.sampleRate = 8000;
    this.nodes = [];
    this.destination = this._node('destination');
  }
  _node(kind, extra) {
    const n = Object.assign({ kind, outputs: [], connect(t) { n.outputs.push(t); if (t.inputs) t.inputs.push(n); return t; }, disconnect() {} }, extra);
    this.nodes.push(n);
    return n;
  }
  createGain() { return this._node('gain', { gain: makeParam(1) }); }
  createOscillator() { return this._node('osc', { type: 'sine', frequency: makeParam(440), detune: makeParam(0), start() {}, stop() {} }); }
  createBiquadFilter() { return this._node('biquad', { type: 'lowpass', frequency: makeParam(350), Q: makeParam(1), gain: makeParam(0) }); }
  createWaveShaper() { return this._node('shaper', { curve: null, oversample: 'none' }); }
  createDynamicsCompressor() { return this._node('comp', { threshold: makeParam(), knee: makeParam(), ratio: makeParam(), attack: makeParam(), release: makeParam() }); }
  createStereoPanner() { return this._node('panner', { pan: makeParam() }); }
  createDelay() { return this._node('delay', { delayTime: makeParam() }); }
  createConvolver() { return this._node('convolver', { buffer: null }); }
  createBufferSource() { return this._node('bufsrc', { buffer: null, start() {}, stop() {} }); }
  createBuffer(channels, length) {
    const data = Array.from({ length: channels }, () => new Float32Array(length));
    return { numberOfChannels: channels, length, getChannelData: (c) => data[c] };
  }
  resume() {}
}

function loadAudio(files) {
  const store = {};
  const ctx = {
    console, Math, Float32Array, Object, Array, WeakMap,
    setTimeout: () => 0,
    localStorage: { getItem: (k) => (k in store ? store[k] : null), setItem: (k, v) => { store[k] = String(v); } },
    document: { createElement: () => ({}), body: { appendChild() {} } },
    AudioContext: FakeCtx,
  };
  ctx.window = ctx;
  vm.createContext(ctx);
  ['public/audio.js'].concat(files)
    .forEach((f) => vm.runInContext(fs.readFileSync(f, 'utf8'), ctx, { filename: f }));
  return ctx;
}

// Render one packet through a voice on a fresh fake context.
function playOnce(voice, parsed, opts, currentTime) {
  const audioCtx = new FakeCtx(currentTime);
  const master = audioCtx.createGain();
  master.connect(audioCtx.destination);
  const before = audioCtx.nodes.length;
  const dur = voice.play(audioCtx, master, parsed, Object.assign({ bpm: 120, tempoMultiplier: 1 }, opts));
  return { audioCtx, master, dur, nodes: audioCtx.nodes.slice(before) };
}

function reaches(node, target, seen) {
  if (node === target) return true;
  seen = seen || new Set();
  if (seen.has(node)) return false;
  seen.add(node);
  return (node.outputs || []).some((o) => reaches(o, target, seen));
}

// True if the node feeds an AudioParam (FM modulator, LFO), directly or via gains
function modulates(node, seen) {
  seen = seen || new Set();
  if (seen.has(node)) return false;
  seen.add(node);
  return (node.outputs || []).some((o) => Array.isArray(o.events) || modulates(o, seen));
}

function parsed(typeName, payloadBytes, extra) {
  return Object.assign({ payloadBytes, typeName, hopCount: 1, obsCount: 1, payload: {}, hops: [] }, extra);
}

const ALL_VOICE_FILES = [
  'public/audio-synthkit.js',
  'public/audio-v1-constellation.js',
  'public/audio-v2-metal.js',
  'public/audio-v3-synthmetal.js',
  'public/audio-v4-technoir.js',
  'public/audio-v5-ambient.js',
  'public/audio-v6-dub.js',
  'public/audio-v7-acid.js',
  'public/audio-v8-lofi.js',
];

// Checks every voice must pass: registration (constellation stays default), all
// pitched oscillators reach the master for every type, the per-packet oscillator
// budget on worst-case packets, a positive duration, and engine integration.
function voiceBasics(test, ctx, name, budget) {
  const assert = require('assert');
  const voice = ctx._meshAudioVoices[name];
  const types = ['ADVERT', 'GRP_TXT', 'TXT_MSG', 'TRACE', 'REQ'];
  const BYTES = [0x00, 0x11, 0x42, 0x77, 0x9a, 0xb0, 0xc3, 0xde, 0xf0, 0xff, 0x05, 0x60, 0x81, 0x33, 0xaa, 0x50];
  test(`${name} registers; constellation stays the default`, () => {
    assert.ok(voice && typeof voice.play === 'function');
    assert.strictEqual(ctx.MeshAudio.getVoiceName(), 'constellation');
  });
  test(`${name}: every type returns a positive duration and reaches the master`, () => {
    types.forEach((t) => {
      const r = playOnce(voice, parsed(t, BYTES, { obsCount: 4, hopCount: 3 }));
      assert.ok(r.dur > 0, t);
      // Every oscillator is heard (reaches the master) or modulates another node (ends in an AudioParam)
      r.nodes.filter((n) => n.kind === 'osc').forEach((o) => assert.ok(reaches(o, r.master) || modulates(o), t));
      r.nodes.filter((n) => n.kind === 'bufsrc').forEach((b) => assert.ok(reaches(b, r.master), t));
    });
  });
  test(`${name}: oscillator count per packet stays within budget (≤${budget})`, () => {
    types.forEach((t) => {
      [new Array(400).fill(0xef), new Array(400).fill(0x11), BYTES, [7]].forEach((bytes) => {
        const n = playOnce(voice, parsed(t, bytes, { obsCount: 50, hopCount: 10 })).nodes.filter((x) => x.kind === 'osc').length;
        assert.ok(n <= budget, `${t}: ${n} oscillators`);
      });
    });
  });
  test(`${name}: same packet always gives the same arrangement`, () => {
    types.forEach((t) => assert.strictEqual(JSON.stringify(voice.arrange(parsed(t, BYTES))), JSON.stringify(voice.arrange(parsed(t, BYTES)))));
  });
  test(`${name}: sonifyPacket handles every type without throwing`, () => {
    ctx.MeshAudio.setVoice(name);
    ctx.MeshAudio.setEnabled(true);
    types.concat('UNKNOWN').forEach((t) => ctx.MeshAudio.sonifyPacket({ raw: 'a1b2c3' + '00112233445566778899aabbccddeeff',
      observation_count: 2, decoded: { header: { payloadTypeName: t }, payload: {}, path: { hops: [] } } }));
    assert.strictEqual(ctx.MeshAudio.getVoiceName(), name);
    ctx.MeshAudio.setVoice('constellation');
  });
}

module.exports = { FakeCtx, loadAudio, playOnce, reaches, parsed, ALL_VOICE_FILES, voiceBasics };
