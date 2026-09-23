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

function parsed(typeName, payloadBytes, extra) {
  return Object.assign({ payloadBytes, typeName, hopCount: 1, obsCount: 1, payload: {}, hops: [] }, extra);
}

module.exports = { FakeCtx, loadAudio, playOnce, reaches, parsed };
