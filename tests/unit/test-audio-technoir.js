/* Unit tests for the "technoir" audio voice (public/audio-v4-technoir.js)
 * and the shared synth kit (public/audio-synthkit.js) it is built on.
 * Loads the real audio.js + voice modules via tests/unit/audio-harness.js. */
'use strict';
const assert = require('assert');
const { FakeCtx, loadAudio, playOnce: play, reaches, parsed } = require('./audio-harness');

let passed = 0, failed = 0;
function test(name, fn) {
  try { fn(); passed++; console.log(`  ✅ ${name}`); }
  catch (e) { failed++; console.log(`  ❌ ${name}: ${e.message}`); }
}

const ctx = loadAudio(['public/audio-synthkit.js', 'public/audio-v1-constellation.js', 'public/audio-v2-metal.js',
  'public/audio-v3-synthmetal.js', 'public/audio-v4-technoir.js']);
const MeshAudio = ctx.MeshAudio;
const noir = ctx._meshAudioVoices.technoir;
const kit = MeshAudio.synthkit;
const playOnce = (p, opts, t) => play(noir, p, opts, t);
const BYTES = [0x00, 0x11, 0x42, 0x77, 0x9a, 0xb0, 0xc3, 0xde, 0xf0, 0xff, 0x05, 0x60, 0x81, 0x33, 0xaa, 0x50];
const ALL_TYPES = ['ADVERT', 'GRP_TXT', 'TXT_MSG', 'TRACE', 'REQ'];
const D_MINOR_PCS = new Set([2, 4, 5, 7, 9, 10, 0]); // D E F G A Bb C
const arrange = (t, bytes, extra) => noir.arrange(parsed(t, bytes || BYTES, extra));
const stepsOf = (list, kind) => [...list.filter((e) => !kind || e.kind === kind).map((e) => e.step)];

console.log('\n=== registration ===');
test('technoir registers as the fourth voice, constellation stays default', () => {
  assert.deepStrictEqual([...MeshAudio.getVoiceNames()], ['constellation', 'metal', 'synthmetal', 'technoir']);
  assert.strictEqual(MeshAudio.getVoiceName(), 'constellation');
});

console.log('\n=== arrange ===');
test('every pitched synth/bass note is in D natural minor', () => {
  ALL_TYPES.forEach((t) => {
    const a = arrange(t);
    a.pads.concat(a.stabs, a.arps).forEach((e) => e.midis.forEach((m) => assert.ok(D_MINOR_PCS.has(m % 12), `${t} ${m}`)));
    a.bass.forEach((e) => assert.ok(D_MINOR_PCS.has(e.midi % 12), `${t} bass ${e.midi}`));
  });
});
test('chords come from the i–VI–III–VII–iv progression (pad roots D, Bb, F, C, G)', () => {
  const roots = new Set();
  for (let b = 0; b < 256; b += 8) arrange('ADVERT', [b, b, b, b]).pads.forEach((p) => roots.add(p.midis[0] % 12));
  assert.deepStrictEqual([...roots].sort((x, y) => x - y), [0, 2, 5, 7, 10]);
});
test('bass drives straight 8ths across the whole riff', () => {
  ALL_TYPES.forEach((t) => {
    const a = arrange(t);
    const bassEnd = t === 'TRACE' ? a.steps - 6 : a.steps;
    assert.deepStrictEqual(stepsOf(a.bass), Array.from({ length: bassEnd / 2 }, (_, i) => i * 2), t);
  });
});
test('bass filter sweeps slowly open and closed (bright 0 → 1 → 0 over 32 steps)', () => {
  const a = arrange('ADVERT', new Array(16).fill(0x01)); // odd bytes → 8-step chords
  const bright = (s) => a.bass.find((e) => e.step === s).bright;
  assert.ok(bright(0) < 0.01 && bright(16) > 0.99 && bright(8) > 0.4 && bright(8) < 0.6);
});
test('ADVERT: pads + stabs on every chord change, full drum kit', () => {
  const a = arrange('ADVERT');
  assert.deepStrictEqual(stepsOf(a.pads), stepsOf(a.stabs));
  assert.ok(a.pads.every((p) => p.midis.length === 4));
  a.drums.forEach((d) => {
    if (d.kind === 'snare') assert.strictEqual(d.step % 8, 4);
    if (d.kind === 'kick') assert.ok(d.step % 8 === 0 || d.step % 16 === 10);
  });
  assert.deepStrictEqual(stepsOf(a.drums, 'hat'), Array.from({ length: a.steps / 2 }, (_, i) => i * 2));
});
test('GRP_TXT: bass and drums only, short', () => {
  const a = arrange('GRP_TXT');
  assert.strictEqual(a.pads.length + a.stabs.length + a.arps.length + a.guitar.length, 0);
  assert.ok(a.drums.some((d) => d.kind === 'kick') && a.bass.length > 0);
  assert.ok(a.steps <= 24);
});
test('TXT_MSG: slow 8-step pad swells, no drums', () => {
  const a = arrange('TXT_MSG');
  assert.strictEqual(a.drums.length, 0);
  assert.ok(a.pads.length > 0 && a.pads.every((p) => p.len === 8));
});
test('TRACE: pluck arps + hats only, ending in a guitar squeal after the groove', () => {
  const a = arrange('TRACE');
  assert.ok(a.drums.every((d) => d.kind === 'hat'));
  const squeal = a.guitar[0];
  assert.strictEqual(squeal.tech, 'pinch');
  assert.strictEqual(squeal.step, a.steps - 6);
  assert.ok(squeal.midis[0] <= 93);
  assert.deepStrictEqual(stepsOf(a.arps), Array.from({ length: a.steps - 6 }, (_, i) => i));
});

console.log('\n=== play() ===');
test('riffs start on the shared 16th-note grid', () => {
  const r = playOnce(parsed('ADVERT', BYTES), { tempoMultiplier: 1 }, 2.51);
  const times = r.nodes.filter((n) => n.kind === 'osc' && n.frequency.events.length).map((o) => o.frequency.events[0].t);
  assert.ok(Math.abs(Math.min(...times) - 2.625) < 1e-9);
});
test('pads feed the chorus and hall; snares feed the gated verb and hall', () => {
  const r = playOnce(parsed('ADVERT', BYTES));
  const convolvers = r.nodes.filter((n) => n.kind === 'convolver');
  assert.strictEqual(convolvers.length, 2); // gated + hall
  const chorusDelays = r.nodes.filter((n) => n.kind === 'delay' && n.delayTime.inputs.length > 0);
  assert.strictEqual(chorusDelays.length, 2);
  const saws = r.nodes.filter((n) => n.kind === 'osc' && n.type === 'sawtooth');
  assert.ok(saws.some((o) => chorusDelays.every((d) => reaches(o, d))));
  const isSnare = (n) => n.kind === 'bufsrc' && n.outputs[0].frequency.value === 1200; // hats high-pass at 7k
  const snares = r.nodes.filter(isSnare);
  assert.ok(snares.length > 0);
  snares.forEach((s) => convolvers.forEach((c) => assert.ok(reaches(s, c))));
  r.nodes.filter((n) => n.kind === 'bufsrc' && !isSnare(n)).forEach((h) => convolvers.forEach((c) => assert.ok(!reaches(h, c), 'hat in reverb')));
});
test('kicks pump the pad/bass bus', () => {
  const r = playOnce(parsed('ADVERT', BYTES));
  assert.ok(r.nodes.some((n) => n.kind === 'gain' && n.gain.events.some((e) => e.v === 0.55)));
});
test('traces route the squeal through the metal guitar rig', () => {
  const r = playOnce(parsed('TRACE', BYTES));
  const shaper = r.nodes.find((n) => n.kind === 'shaper');
  assert.ok(shaper && shaper.curve === ctx._meshAudioVoices.metal.distortionCurve());
});
test('everything reaches the master output', () => {
  ALL_TYPES.forEach((t) => {
    const r = playOnce(parsed(t, BYTES, { obsCount: 4 }));
    r.nodes.filter((n) => n.kind === 'osc' && n.type !== 'sine').forEach((o) => assert.ok(reaches(o, r.master), t));
  });
});
test('oscillator count per packet stays within budget (≤128)', () => {
  ALL_TYPES.forEach((t) => {
    [new Array(400).fill(0xef), new Array(400).fill(0x11), BYTES].forEach((bytes) => {
      const n = playOnce(parsed(t, bytes, { obsCount: 50 })).nodes.filter((x) => x.kind === 'osc').length;
      assert.ok(n <= 128, `${t}: ${n} oscillators`);
    });
  });
});

console.log('\n=== synth kit ===');
test('effect buses are built once per context, lazily', () => {
  const audioCtx = new FakeCtx();
  const master = audioCtx.createGain();
  const a = kit.bus(audioCtx, master, 'hall');
  assert.strictEqual(kit.bus(audioCtx, master, 'hall'), a);
  assert.strictEqual(audioCtx.nodes.filter((n) => n.kind === 'convolver').length, 1);
  for (let i = 0; i < 3; i++) noir.play(audioCtx, master, parsed('ADVERT', BYTES), { bpm: 120, tempoMultiplier: 1 });
  assert.strictEqual(audioCtx.nodes.filter((n) => n.kind === 'convolver').length, 2);
  assert.strictEqual(audioCtx.nodes.filter((n) => n.kind === 'osc' && n.frequency.value === 0.6).length, 1, 'one chorus LFO');
});
test('gridStart snaps to the next 16th after a small lookahead', () => {
  assert.strictEqual(kit.gridStart({ currentTime: 0.99 }, 0.125), 1.125);
  assert.strictEqual(kit.gridStart({ currentTime: 0 }, 0.125), 0.125);
});
test('playSynth skips zero-amount sends', () => {
  const audioCtx = new FakeCtx();
  const dest = audioCtx.createGain();
  const fx = audioCtx.createGain();
  const before = audioCtx.nodes.length;
  kit.playSynth(audioCtx, dest, { detunes: [0], cutoff: [100, 200, 100], q: 1, attack: 0.01, sustain: 0.5, release: 0.1, level: 0.5 },
    [60], 0, 0.5, { sends: [[fx, 0]] });
  assert.strictEqual(fx.inputs ? fx.inputs.length : 0, 0);
  assert.strictEqual(audioCtx.nodes.length - before, 3); // osc + filter + env, no send gain
});

console.log('\n=== engine integration ===');
test('sonifyPacket with technoir handles every type without throwing', () => {
  MeshAudio.setVoice('technoir');
  MeshAudio.setEnabled(true);
  ALL_TYPES.concat('UNKNOWN').forEach((t) => {
    MeshAudio.sonifyPacket({ raw: 'a1b2c3' + '00112233445566778899aabbccddeeff', observation_count: 2,
      decoded: { header: { payloadTypeName: t }, payload: {}, path: { hops: [] } } });
  });
  assert.strictEqual(MeshAudio.getVoiceName(), 'technoir');
});

console.log(`\n${passed} passed, ${failed} failed`);
process.exit(failed > 0 ? 1 : 0);
