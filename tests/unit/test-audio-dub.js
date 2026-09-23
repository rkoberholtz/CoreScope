/* Unit tests for the "dub" voice (public/audio-v6-dub.js). */
"use strict";
const assert = require("assert");
const { loadAudio, playOnce: play, reaches, parsed, ALL_VOICE_FILES, voiceBasics } = require("./audio-harness");

let passed = 0, failed = 0;
function test(name, fn) {
  try { fn(); passed++; console.log(`  ✅ ${name}`); }
  catch (e) { failed++; console.log(`  ❌ ${name}: ${e.message}`); }
}

const ctx = loadAudio(ALL_VOICE_FILES);
const BYTES = [0x00, 0x11, 0x42, 0x77, 0x9a, 0xb0, 0xc3, 0xde, 0xf0, 0xff, 0x05, 0x60, 0x81, 0x33, 0xaa, 0x50];
const pcs = (list) => list.map((m) => ((m % 12) + 12) % 12);

const v = ctx._meshAudioVoices.dub;
const arrange = (t, b, x) => v.arrange(parsed(t, b || BYTES, x));
const A_MINOR = new Set([9, 11, 0, 2, 4, 5, 7]);

console.log('\n=== basics ===');
voiceBasics(test, ctx, 'dub', 64);

console.log('\n=== arrange ===');
test('skanks land on the offbeat 8ths (steps 2, 6, 10, 14 of each bar)', () => {
  ['ADVERT', 'GRP_TXT', 'TXT_MSG'].forEach((t) => arrange(t).skanks.forEach((s) => assert.strictEqual(s.step % 4, 2, t)));
});
test('one drop: kick and rim together on beat 3, only kick on adverts', () => {
  const a = arrange('ADVERT');
  assert.ok(a.drums.every((d) => d.step % 16 === 8));
  assert.ok(a.drums.some((d) => d.kind === 'kick'));
  assert.ok(arrange('GRP_TXT').drums.every((d) => d.kind === 'rim' && d.step === 8));
  assert.strictEqual(arrange('TXT_MSG').drums.length, 0);
});
test('skanks, bass and sirens stay in A minor', () => {
  ['ADVERT', 'TXT_MSG', 'TRACE'].forEach((t) => {
    for (let b = 0; b < 256; b += 13) {
      const a = arrange(t, [b, b ^ 0x3c, b ^ 0xc3, b]);
      pcs(a.skanks.flatMap((s) => [...s.midis]).concat(a.bass.map((n) => n.midi), a.sirens.map((n) => n.midi)))
        .forEach((pc) => assert.ok(A_MINOR.has(pc), `${t} pc ${pc}`));
    }
  });
});
test('ADVERT is two bars, GRP_TXT/TXT_MSG one; TRACE is sirens + rims', () => {
  assert.strictEqual(arrange('ADVERT').steps, 32);
  assert.strictEqual(arrange('GRP_TXT').steps, 16);
  const tr = arrange('TRACE');
  assert.ok(tr.sirens.length >= 2 && tr.skanks.length === 0 && tr.drums.every((d) => d.kind === 'rim'));
});

console.log('\n=== play() ===');
const echoSend = (hops) => {
  const r = play(v, parsed('GRP_TXT', BYTES, { hopCount: hops }));
  const echoIn = r.nodes.find((n) => n.kind === 'gain' && n.outputs.some((o) => o.kind === 'biquad' && o.type === 'highpass' && o.outputs.some((d) => d.kind === 'delay')));
  return Math.max(...r.nodes.filter((n) => n.kind === 'gain' && n.outputs.includes(echoIn)).map((n) => n.gain.value));
};
test('more hops throw more into the dub echo', () => assert.ok(echoSend(10) > echoSend(1)));
test('observers widen the skanks', () => {
  const width = (obs) => Math.max(...play(v, parsed('GRP_TXT', BYTES, { obsCount: obs })).nodes.filter((n) => n.kind === 'panner').map((p) => Math.abs(p.pan.value)));
  assert.ok(width(8) > width(1));
});
test('echo time follows the tempo (dotted 8th)', () => {
  const d = play(v, parsed('GRP_TXT', BYTES), { tempoMultiplier: 0.5 }).nodes.find((n) => n.kind === 'delay');
  assert.ok(Math.abs(d.delayTime.value - 3 * 0.0625) < 1e-12);
});

console.log(`
${passed} passed, ${failed} failed`);
process.exit(failed > 0 ? 1 : 0);
