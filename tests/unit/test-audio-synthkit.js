/* Unit tests for the shared synth kit (public/audio-synthkit.js):
 * FM, acid, swing timing, crackle and the dub echo bus.
 * Loads the real modules via tests/unit/audio-harness.js. */
'use strict';
const assert = require('assert');
const { FakeCtx, loadAudio, reaches } = require('./audio-harness');

let passed = 0, failed = 0;
function test(name, fn) {
  try { fn(); passed++; console.log(`  ✅ ${name}`); }
  catch (e) { failed++; console.log(`  ❌ ${name}: ${e.message}`); }
}

const ctx = loadAudio(['public/audio-synthkit.js']);
const kit = ctx.MeshAudio.synthkit;
const { midiToFreq } = ctx.MeshAudio.helpers;
const fresh = () => { const c = new FakeCtx(); const dest = c.createGain(); return { c, dest, before: c.nodes.length }; };

console.log('\n=== playFM ===');
const BELL = { ratio: 3.5, index: [2.5, 0.3], indexDecay: 1.2, attack: 0.01, decay: 2, sustain: 0.05, release: 1, level: 0.3 };
test('two oscillators per note: modulator drives the carrier pitch', () => {
  const { c, dest, before } = fresh();
  kit.playFM(c, dest, BELL, [60, 64], 0, 1);
  const oscs = c.nodes.slice(before).filter((n) => n.kind === 'osc');
  assert.strictEqual(oscs.length, 4);
  const carriers = oscs.filter((o) => reaches(o, dest));
  assert.strictEqual(carriers.length, 2);
  carriers.forEach((car) => assert.strictEqual(car.frequency.inputs.length, 1));
});
test('modulator runs at freq × ratio and its depth decays from peak to settled index', () => {
  const { c, dest, before } = fresh();
  kit.playFM(c, dest, BELL, [69], 0, 1);
  const f = midiToFreq(69);
  const mod = c.nodes.slice(before).filter((n) => n.kind === 'osc').find((o) => !reaches(o, dest));
  assert.ok(Math.abs(mod.frequency.events[0].v - f * 3.5) < 1e-9);
  const depth = mod.outputs[0];
  assert.ok(Math.abs(depth.gain.events[0].v - f * 2.5) < 1e-9);
  assert.ok(Math.abs(depth.gain.events[1].v - f * 0.3) < 1e-9);
});
test('pitchMod feeds both carrier and modulator detune', () => {
  const { c, dest, before } = fresh();
  const lfo = c.createGain();
  kit.playFM(c, dest, BELL, [60], 0, 1, { pitchMod: lfo });
  c.nodes.slice(before).filter((n) => n.kind === 'osc').forEach((o) => assert.ok(o.detune.inputs.includes(lfo)));
});

console.log('\n=== playAcid ===');
const ACID = { cutoff: 500, q: 15, envMod: 2.5, decay: 0.18, level: 0.35 };
const acidNodes = (ev) => { const { c, dest, before } = fresh(); kit.playAcid(c, dest, ev, 0, 0.1, ACID); return c.nodes.slice(before); };
test('filter envelope snaps open then closes to the cutoff; accent opens further', () => {
  const plain = acidNodes({ midi: 45 }).find((n) => n.kind === 'biquad');
  const accent = acidNodes({ midi: 45, accent: true }).find((n) => n.kind === 'biquad');
  assert.strictEqual(plain.Q.value, 15);
  assert.strictEqual(plain.frequency.events[1].v, 500);
  assert.ok(accent.frequency.events[0].v > plain.frequency.events[0].v);
});
test('slides glide in from the previous note; plain notes start on pitch', () => {
  const slide = acidNodes({ midi: 57, slide: true, prevMidi: 45 }).find((n) => n.kind === 'osc');
  assert.ok(Math.abs(slide.frequency.events[0].v - midiToFreq(45)) < 1e-9);
  assert.ok(Math.abs(slide.frequency.events[1].v - midiToFreq(57)) < 1e-9);
  const plain = acidNodes({ midi: 57 }).find((n) => n.kind === 'osc');
  assert.strictEqual(plain.frequency.events.length, 1);
});

console.log('\n=== stepTime (swing) ===');
test('even steps sit on the grid; odd steps are pushed late by swing × a 16th', () => {
  assert.strictEqual(kit.stepTime(1, 0, 0.125, 0.3), 1);
  assert.strictEqual(kit.stepTime(1, 2, 0.125, 0.3), 1.25);
  assert.ok(Math.abs(kit.stepTime(1, 1, 0.125, 0.3) - (1.125 + 0.0375)) < 1e-12);
  assert.strictEqual(kit.stepTime(1, 3, 0.125), 1.375);
});

console.log('\n=== buses ===');
test('dub echo: feedback loop is capped below 0.8 and darkened by a lowpass', () => {
  const { c, dest } = fresh();
  const echo = kit.bus(c, dest, 'dubecho');
  const delay = echo.delays[0];
  const fb = c.nodes.find((n) => n.kind === 'gain' && n.outputs.includes(delay));
  assert.ok(fb.gain.value < 0.8);
  assert.ok(c.nodes.some((n) => n.kind === 'biquad' && n.type === 'lowpass' && n.outputs.includes(fb)));
  assert.ok(reaches(echo.input, dest));
});
test('crackle buffer is built once and played looped for the packet', () => {
  const { c, dest, before } = fresh();
  const a = kit.bus(c, dest, 'crackle');
  assert.strictEqual(kit.bus(c, dest, 'crackle'), a);
  kit.playCrackle(c, dest, a.buffer, 0, 2, 0.08);
  const src = c.nodes.slice(before).find((n) => n.kind === 'bufsrc');
  assert.strictEqual(src.loop, true);
  assert.ok(reaches(src, dest));
});

console.log(`\n${passed} passed, ${failed} failed`);
process.exit(failed > 0 ? 1 : 0);
