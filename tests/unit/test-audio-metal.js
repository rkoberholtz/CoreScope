/* Unit tests for the "metal" audio voice (public/audio-v2-metal.js)
 * and the shared MeshAudio.helpers.panFor it uses.
 * Loads the real audio.js + voice modules via tests/unit/audio-harness.js. */
'use strict';
const assert = require('assert');
const { loadAudio, playOnce: play, reaches, parsed } = require('./audio-harness');

let passed = 0, failed = 0;
function test(name, fn) {
  try { fn(); passed++; console.log(`  ✅ ${name}`); }
  catch (e) { failed++; console.log(`  ❌ ${name}: ${e.message}`); }
}

const ctx = loadAudio(['public/audio-v1-constellation.js', 'public/audio-v2-metal.js']);
const MeshAudio = ctx.MeshAudio;
const metal = ctx._meshAudioVoices.metal;
const { midiToFreq } = MeshAudio.helpers;
const BYTES = [0x00, 0x11, 0x42, 0x77, 0x9a, 0xb0, 0xc3, 0xde, 0xf0, 0xff, 0x05, 0x60, 0x81, 0x33, 0xaa, 0x50];
const playOnce = (p, opts) => play(metal, p, opts);
function pathHasShaper(node, target) {
  if (node === target) return false;
  return (node.outputs || []).some((o) => (o.kind === 'shaper' ? reaches(o, target) : pathHasShaper(o, target)));
}

console.log('\n=== registration ===');
test('metal voice registers', () => assert.ok(metal && typeof metal.play === 'function'));
test('constellation stays the default voice', () => assert.strictEqual(MeshAudio.getVoiceName(), 'constellation'));
test('voice list offers both', () => assert.deepStrictEqual([...MeshAudio.getVoiceNames()], ['constellation', 'metal']));
test('setVoice("metal") switches and persists', () => {
  assert.strictEqual(MeshAudio.setVoice('metal'), true);
  assert.strictEqual(MeshAudio.getVoiceName(), 'metal');
  assert.strictEqual(ctx.localStorage.getItem('live-audio-voice'), 'metal');
});

console.log('\n=== buildRiff ===');
test('note count is bounded to 3..8', () => {
  assert.strictEqual(metal.buildRiff(parsed('ADVERT', [1])).length, 3);
  assert.strictEqual(metal.buildRiff(parsed('ADVERT', new Array(400).fill(7))).length, 8);
});
test('events are back-to-back on the 16th grid', () => {
  ['ADVERT', 'GRP_TXT', 'TXT_MSG', 'TRACE', 'ACK'].forEach((t) => {
    const ev = metal.buildRiff(parsed(t, BYTES));
    assert.strictEqual(ev[0].step, 0);
    for (let i = 1; i < ev.length; i++) assert.strictEqual(ev[i].step, ev[i - 1].step + ev[i - 1].len, t);
  });
});
test('ADVERT plays power chords (root + perfect fifth)', () => {
  metal.buildRiff(parsed('ADVERT', BYTES)).forEach((e) => {
    assert.strictEqual(e.tech, 'chord');
    assert.deepStrictEqual([...e.midis], [e.midis[0], e.midis[0] + 7]);
  });
});
test('3+ observations add the octave to power chords', () => {
  metal.buildRiff(parsed('ADVERT', BYTES, { obsCount: 3 })).forEach((e) => {
    assert.deepStrictEqual([...e.midis], [e.midis[0], e.midis[0] + 7, e.midis[0] + 12]);
  });
});
test('unknown types fall back to the power-chord riff', () => {
  assert.ok(metal.buildRiff(parsed('UNKNOWN', BYTES)).every((e) => e.tech === 'chord'));
});
test('GRP_TXT: low bytes chug on open drop-D, high bytes accent with a chord', () => {
  const ev = metal.buildRiff(parsed('GRP_TXT', [0x10, 0xf0, 0x20, 0xe0].flatMap((b) => [b, b, b, b]))); // 16 bytes → 4 notes
  assert.deepStrictEqual([...ev.map((e) => e.tech)], ['mute', 'chord', 'mute', 'chord']);
  assert.deepStrictEqual([...ev[0].midis], [38, 45]);
  assert.strictEqual(ev[0].len, 1);
});
test('TXT_MSG: single lead notes, last one held', () => {
  const ev = metal.buildRiff(parsed('TXT_MSG', BYTES));
  assert.ok(ev.every((e) => e.tech === 'lead' && e.midis.length === 1 && e.midis[0] >= 62));
  assert.strictEqual(ev[ev.length - 1].len, 6);
});
test('TRACE: bends, ending in a pinch harmonic kept in range', () => {
  const ev = metal.buildRiff(parsed('TRACE', new Array(16).fill(0xff)));
  assert.deepStrictEqual([...ev.map((e) => e.tech)], ['bend', 'bend', 'bend', 'pinch']);
  assert.ok(ev[3].midis[0] <= 93);
});
test('same packet always gives the same riff', () => {
  assert.deepStrictEqual(JSON.stringify(metal.buildRiff(parsed('GRP_TXT', BYTES))),
    JSON.stringify(metal.buildRiff(parsed('GRP_TXT', BYTES))));
});

console.log('\n=== distortion curve ===');
test('curve is built once and reused', () => assert.strictEqual(metal.distortionCurve(), metal.distortionCurve()));
test('curve is odd-symmetric, monotonic and bounded to ±1', () => {
  const c = metal.distortionCurve();
  assert.ok(Math.abs(c[0] + 1) < 1e-6 && Math.abs(c[c.length - 1] - 1) < 1e-6);
  for (let i = 1; i < c.length; i++) assert.ok(c[i] >= c[i - 1]);
  for (let i = 0; i < c.length; i++) assert.ok(Math.abs(c[i] + c[c.length - 1 - i]) < 1e-6);
});

console.log('\n=== play() audio graph ===');
test('returns a positive duration and every guitar oscillator runs through the amp to master', () => {
  const r = playOnce(parsed('ADVERT', BYTES, { hopCount: 3, obsCount: 4 }));
  assert.ok(r.dur > 0);
  const saws = r.nodes.filter((n) => n.kind === 'osc' && n.type === 'sawtooth');
  assert.ok(saws.length > 0);
  saws.forEach((o) => assert.ok(pathHasShaper(o, r.master), 'oscillator bypasses the distortion'));
});
test('every packet shares the cached distortion curve', () => {
  const a = playOnce(parsed('ADVERT', BYTES)).nodes.find((n) => n.kind === 'shaper');
  const b = playOnce(parsed('TRACE', BYTES)).nodes.find((n) => n.kind === 'shaper');
  assert.strictEqual(a.curve, metal.distortionCurve());
  assert.strictEqual(b.curve, a.curve);
});
test('power chord oscillators sit a perfect fifth apart', () => {
  const r = playOnce(parsed('ADVERT', [0x00, 0x00, 0x00]));
  const freqs = [...new Set(r.nodes.filter((n) => n.type === 'sawtooth').map((o) => o.frequency.events[0].v))].sort((x, y) => x - y);
  assert.strictEqual(freqs.length, 2);
  assert.ok(Math.abs(freqs[1] / freqs[0] - Math.pow(2, 7 / 12)) < 1e-9);
  assert.ok(Math.abs(freqs[0] - midiToFreq(38)) < 1e-9, 'lowest byte should land on open low D');
});
test('bends start a whole step below the target note', () => {
  const r = playOnce(parsed('TRACE', [0x00, 0x00, 0x00]));
  const osc = r.nodes.find((n) => n.type === 'sawtooth');
  const [from, to] = osc.frequency.events;
  assert.strictEqual(to.m, 'exponentialRampToValueAtTime');
  assert.ok(Math.abs(to.v / from.v - Math.pow(2, 2 / 12)) < 1e-9);
});
test('lead notes get vibrato (an LFO wired into the pitch)', () => {
  const r = playOnce(parsed('TXT_MSG', BYTES));
  const osc = r.nodes.find((n) => n.type === 'sawtooth');
  assert.ok(osc.frequency.inputs.length > 0);
});
test('more hops darken the cab (lower lowpass cutoff)', () => {
  const cut = (hops) => playOnce(parsed('ADVERT', BYTES, { hopCount: hops })).nodes
    .filter((n) => n.kind === 'biquad' && n.type === 'lowpass').map((n) => n.frequency.value).pop();
  assert.ok(cut(8) < cut(1));
});
test('doubling BPM halves the riff length', () => {
  const slow = playOnce(parsed('ADVERT', BYTES), { tempoMultiplier: 1 }).dur;
  const fast = playOnce(parsed('ADVERT', BYTES), { tempoMultiplier: 0.5 }).dur;
  assert.ok(fast < slow * 0.6, `fast=${fast} slow=${slow}`);
});
test('oscillator count per packet stays bounded (worst case 8 notes × 3 tones × 2)', () => {
  ['ADVERT', 'GRP_TXT', 'TXT_MSG', 'TRACE'].forEach((t) => {
    const r = playOnce(parsed(t, new Array(400).fill(0xee), { obsCount: 50 }));
    assert.ok(r.nodes.filter((n) => n.kind === 'osc').length <= 48, t);
  });
});

console.log('\n=== engine integration ===');
test('sonifyPacket with the metal voice handles every type without throwing', () => {
  MeshAudio.setVoice('metal');
  MeshAudio.setEnabled(true);
  ['ADVERT', 'GRP_TXT', 'TXT_MSG', 'TRACE', 'REQ', 'UNKNOWN'].forEach((t) => {
    MeshAudio.sonifyPacket({ raw: 'a1b2c3' + '00112233445566778899aabbccddeeff', observation_count: 2,
      decoded: { header: { payloadTypeName: t }, payload: {}, path: { hops: [] } } });
  });
  MeshAudio.sonifyPacket({ raw: 'a1b2c3ff', decoded: {} });
});

console.log('\n=== helpers.panFor ===');
const { panFor } = MeshAudio.helpers;
test('pans by longitude, clamped', () => {
  assert.strictEqual(panFor({ payload: { lat: 0, lon: -125 }, hops: [] }), -1);
  assert.strictEqual(panFor({ payload: { lat: 0, lon: -65 }, hops: [] }), 1);
  assert.strictEqual(panFor({ payload: { lat: 0, lon: 10 }, hops: [] }), 1);
});
test('centred without coordinates or hops, small spread with hops', () => {
  assert.strictEqual(panFor({ payload: {}, hops: [] }), 0);
  const p = panFor({ payload: {}, hops: ['aa'] });
  assert.ok(Math.abs(p) <= 0.3);
});

console.log('\n=== helpers.sampleBytes ===');
const { sampleBytes } = MeshAudio.helpers;
test('samples sqrt(len) bytes evenly, clamped to the bounds', () => {
  assert.deepStrictEqual([...sampleBytes([0, 1, 2, 3, 4, 5, 6, 7, 8], 2, 10)], [0, 3, 6]);
  assert.strictEqual(sampleBytes([9], 3, 8).length, 3);
  assert.strictEqual(sampleBytes(new Array(400).fill(1), 3, 8).length, 8);
});

console.log(`\n${passed} passed, ${failed} failed`);
process.exit(failed > 0 ? 1 : 0);
