/* Unit tests for the "synthmetal" audio voice (public/audio-v3-synthmetal.js).
 * Loads the real audio.js + voice modules via tests/unit/audio-harness.js. */
'use strict';
const assert = require('assert');
const { FakeCtx, loadAudio, playOnce: play, reaches, parsed } = require('./audio-harness');

let passed = 0, failed = 0;
function test(name, fn) {
  try { fn(); passed++; console.log(`  ✅ ${name}`); }
  catch (e) { failed++; console.log(`  ❌ ${name}: ${e.message}`); }
}

const ctx = loadAudio(['public/audio-synthkit.js', 'public/audio-v1-constellation.js', 'public/audio-v2-metal.js', 'public/audio-v3-synthmetal.js']);
const MeshAudio = ctx.MeshAudio;
const synth = ctx._meshAudioVoices.synthmetal;
const playOnce = (p, opts, t) => play(synth, p, opts, t);
const BYTES = [0x00, 0x11, 0x42, 0x77, 0x9a, 0xb0, 0xc3, 0xde, 0xf0, 0xff, 0x05, 0x60, 0x81, 0x33, 0xaa, 0x50];
const ALL_TYPES = ['ADVERT', 'GRP_TXT', 'TXT_MSG', 'TRACE', 'REQ'];
const HARMONIC_MINOR_PCS = new Set([2, 4, 5, 7, 9, 10, 1]); // D E F G A Bb C#
const steps = (list) => [...list.map((e) => e.step)];
const arrange = (t, bytes, extra) => synth.arrange(parsed(t, bytes || BYTES, extra));

console.log('\n=== registration ===');
test('synthmetal registers after metal, constellation stays default', () => {
  assert.deepStrictEqual([...MeshAudio.getVoiceNames()], ['constellation', 'metal', 'synthmetal']);
  assert.strictEqual(MeshAudio.getVoiceName(), 'constellation');
});

console.log('\n=== arrange ===');
test('every synth and bass note is in D harmonic minor', () => {
  ALL_TYPES.forEach((t) => {
    const a = arrange(t);
    a.synth.forEach((e) => e.midis.forEach((m) => assert.ok(HARMONIC_MINOR_PCS.has(m % 12), `${t} synth ${m}`)));
    a.bass.forEach((e) => assert.ok(HARMONIC_MINOR_PCS.has(e.midi % 12), `${t} bass ${e.midi}`));
  });
});
test('ADVERT: guitar power chords and synth triads land together', () => {
  const a = arrange('ADVERT');
  assert.deepStrictEqual(steps(a.guitar), steps(a.synth));
  a.synth.forEach((e) => { assert.strictEqual(e.kind, 'stab'); assert.strictEqual(e.midis.length, 3); });
  a.guitar.forEach((e) => assert.strictEqual(e.midis[1] - e.midis[0], 7));
});
test('ADVERT: 8th-note bass bounces root/octave across the whole riff', () => {
  const a = arrange('ADVERT', new Array(9).fill(0)); // all on D, 8th and quarter lengths
  assert.deepStrictEqual(steps(a.bass), Array.from({ length: Math.ceil(a.steps / 2) }, (_, i) => i * 2));
  assert.ok(a.bass.every((e, i) => e.midi === (i % 2 ? 50 : 38)));
});
test('ADVERT: rock beat — kick on 1 and 3, snare on 2 and 4, inside the riff', () => {
  const a = arrange('ADVERT');
  a.drums.forEach((d) => {
    assert.ok(d.step < a.steps && d.step % 4 === 0);
    assert.strictEqual(d.kind, (d.step / 4) % 2 ? 'snare' : 'kick');
  });
  assert.ok(a.drums.some((d) => d.kind === 'kick') && a.drums.some((d) => d.kind === 'snare'));
});
test('GRP_TXT: 16th bass under every step and four-on-the-floor kicks', () => {
  const a = arrange('GRP_TXT');
  assert.deepStrictEqual(steps(a.bass), Array.from({ length: a.steps }, (_, i) => i));
  const kicks = [...a.drums.filter((d) => d.kind === 'kick').map((d) => d.step)];
  assert.deepStrictEqual(kicks, Array.from({ length: Math.ceil(a.steps / 4) }, (_, i) => i * 4));
});
test('TXT_MSG: supersaw lead only, no guitar or drums, last note held', () => {
  const a = arrange('TXT_MSG');
  assert.strictEqual(a.guitar.length, 0);
  assert.strictEqual(a.drums.length, 0);
  assert.ok(a.synth.every((e) => e.kind === 'lead' && e.midis.length === 1));
  assert.strictEqual(a.synth[a.synth.length - 1].len, 6);
});
test('TRACE: back-to-back 16th arps ending in a guitar pinch squeal, no drums', () => {
  const a = arrange('TRACE', new Array(16).fill(0xff));
  assert.strictEqual(a.drums.length, 0);
  assert.ok(a.synth.every((e, i) => e.kind === 'arp' && e.len === 1 && e.step === i));
  const pinch = a.guitar[a.guitar.length - 1];
  assert.strictEqual(pinch.tech, 'pinch');
  assert.strictEqual(pinch.step, a.synth.length);
  assert.ok(pinch.midis[0] <= 93);
});
test('3+ observations add the octave to guitar chords', () => {
  arrange('ADVERT', BYTES, { obsCount: 3 }).guitar.forEach((e) => assert.strictEqual(e.midis.length, 3));
});

console.log('\n=== play() ===');
test('riffs start on the shared 16th-note grid', () => {
  const r = playOnce(parsed('ADVERT', BYTES), { tempoMultiplier: 1 }, 1.03);
  const times = r.nodes.filter((n) => n.kind === 'osc' && n.frequency.events.length).map((o) => o.frequency.events[0].t);
  const first = Math.min(...times);
  assert.ok(Math.abs(first - 1.125) < 1e-9, `first note at ${first}`);
  times.forEach((t) => assert.ok(Math.abs(t / 0.125 - Math.round(t / 0.125)) < 1e-6, `off-grid note at ${t}`));
});
test('effects are built once per audio context and reused', () => {
  const audioCtx = new FakeCtx();
  const master = audioCtx.createGain();
  for (let i = 0; i < 3; i++) synth.play(audioCtx, master, parsed('TXT_MSG', BYTES), { bpm: 120, tempoMultiplier: 1 });
  assert.strictEqual(audioCtx.nodes.filter((n) => n.kind === 'convolver').length, 1);
  assert.strictEqual(audioCtx.nodes.filter((n) => n.kind === 'delay').length, 2);
});
test('ping-pong delay is set to a dotted 8th', () => {
  const r = playOnce(parsed('TXT_MSG', BYTES), { tempoMultiplier: 0.5 });
  r.nodes.filter((n) => n.kind === 'delay').forEach((d) => assert.ok(Math.abs(d.delayTime.value - 3 * 0.0625) < 1e-9));
});
test('kicks duck the synth bus (sidechain pump)', () => {
  const r = playOnce(parsed('GRP_TXT', BYTES));
  assert.ok(r.nodes.some((n) => n.kind === 'gain' && n.gain.events.some((e) => e.v === 0.35)));
});
test('snares feed the gated reverb', () => {
  const r = playOnce(parsed('ADVERT', BYTES));
  const verb = r.nodes.find((n) => n.kind === 'convolver');
  const snares = r.nodes.filter((n) => n.kind === 'bufsrc');
  assert.ok(snares.length > 0);
  snares.forEach((s) => assert.ok(reaches(s, verb)));
});
test('guitar runs through the metal voice\'s distortion rig', () => {
  const r = playOnce(parsed('ADVERT', BYTES));
  const shaper = r.nodes.find((n) => n.kind === 'shaper');
  assert.ok(shaper && shaper.curve === ctx._meshAudioVoices.metal.distortionCurve());
});
test('everything reaches the master output', () => {
  ALL_TYPES.forEach((t) => {
    const r = playOnce(parsed(t, BYTES, { obsCount: 4 }));
    r.nodes.filter((n) => n.kind === 'osc' && n.type === 'sawtooth').forEach((o) => assert.ok(reaches(o, r.master), t));
  });
});
test('doubling BPM roughly halves the riff length', () => {
  const slow = playOnce(parsed('ADVERT', BYTES), { tempoMultiplier: 1 }).dur;
  const fast = playOnce(parsed('ADVERT', BYTES), { tempoMultiplier: 0.5 }).dur;
  assert.ok(fast < slow * 0.65, `fast=${fast} slow=${slow}`);
});
test('oscillator count per packet stays within budget (≤128)', () => {
  ALL_TYPES.forEach((t) => {
    [new Array(400).fill(0xee), new Array(400).fill(0x10), BYTES].forEach((bytes) => {
      const r = playOnce(parsed(t, bytes, { obsCount: 50 }));
      const n = r.nodes.filter((x) => x.kind === 'osc').length;
      assert.ok(n <= 128, `${t}: ${n} oscillators`);
    });
  });
});

console.log('\n=== engine integration ===');
test('sonifyPacket with synthmetal handles every type without throwing', () => {
  MeshAudio.setVoice('synthmetal');
  MeshAudio.setEnabled(true);
  ALL_TYPES.concat('UNKNOWN').forEach((t) => {
    MeshAudio.sonifyPacket({ raw: 'a1b2c3' + '00112233445566778899aabbccddeeff', observation_count: 2,
      decoded: { header: { payloadTypeName: t }, payload: {}, path: { hops: [] } } });
  });
  assert.strictEqual(MeshAudio.getVoiceName(), 'synthmetal');
});

console.log(`\n${passed} passed, ${failed} failed`);
process.exit(failed > 0 ? 1 : 0);
