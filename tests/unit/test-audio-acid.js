/* Unit tests for the "acid" voice (public/audio-v7-acid.js). */
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

const v = ctx._meshAudioVoices.acid;
const arrange = (t, b, x) => v.arrange(parsed(t, b || BYTES, x));

console.log('\n=== basics ===');
voiceBasics(test, ctx, 'acid', 40);

console.log('\n=== arrange ===');
test('pattern length: 16 steps for adverts/messages, 8 for channel messages/traces', () => {
  assert.strictEqual(arrange('ADVERT').steps, 16);
  assert.strictEqual(arrange('TXT_MSG').steps, 16);
  assert.strictEqual(arrange('GRP_TXT').steps, 8);
  assert.strictEqual(arrange('TRACE').steps, 8);
});
test('the downbeat always plays; notes sit on steps inside the pattern', () => {
  for (let b = 0; b < 256; b += 7) {
    const a = arrange('ADVERT', [b, b, b]);
    assert.strictEqual(a.notes[0].step, 0);
    a.notes.forEach((n) => assert.ok(n.step >= 0 && n.step < 16));
  }
});
test('notes use the acid moves over A: root, octave, minor 3rd, 5th, 7th', () => {
  const ok = new Set([0, 12, 3, 7, 10, 15]);
  for (let b = 0; b < 256; b += 5) arrange('ADVERT', [b, b ^ 0xff, b]).notes.forEach((n) => assert.ok(ok.has(n.midi - 45), `${n.midi}`));
});
test('slides only follow a sounding note and carry the previous pitch', () => {
  for (let b = 0; b < 256; b += 3) {
    const notes = arrange('ADVERT', [b, b ^ 0x5a, b ^ 0xa5, b ^ 0x33]).notes;
    notes.forEach((n, i) => { if (n.slide) { assert.ok(i > 0 && notes[i - 1].step === n.step - 1); assert.strictEqual(n.prevMidi, notes[i - 1].midi); } });
  }
});
test('some steps are accents, slides and rests across a range of packets', () => {
  let accents = 0, slides = 0, rests = 0;
  for (let b = 0; b < 256; b += 11) { const a = arrange('ADVERT', [b, b + 1, b + 2]); accents += a.notes.filter((n) => n.accent).length; slides += a.notes.filter((n) => n.slide).length; rests += 16 - a.notes.length; }
  assert.ok(accents > 0 && slides > 0 && rests > 0);
});
test('drums: four-on-the-floor kicks, offbeat hats, claps on 2 and 4; traces hats only', () => {
  const a = arrange('ADVERT');
  assert.deepStrictEqual([...a.drums.filter((d) => d.kind === 'kick').map((d) => d.step)], [0, 4, 8, 12]);
  assert.deepStrictEqual([...a.drums.filter((d) => d.kind === 'clap').map((d) => d.step)], [4, 12]);
  assert.ok(arrange('TRACE').drums.every((d) => d.kind === 'hat'));
});

console.log('\n=== play() ===');
test('more hops → more filter resonance', () => {
  const q = (hops) => play(v, parsed('ADVERT', BYTES, { hopCount: hops })).nodes.find((n) => n.kind === 'osc' && n.type === 'sawtooth').outputs[0].Q.value;
  assert.ok(q(8) > q(1));
  assert.ok(q(50) <= 20);
});
test('steps land on the shared 16th grid', () => {
  const r = play(v, parsed('ADVERT', BYTES), {}, 0.51);
  r.nodes.filter((n) => n.kind === 'osc' && n.type === 'sawtooth').forEach((o) => {
    const t = o.frequency.events[0].t;
    assert.ok(Math.abs(t / 0.125 - Math.round(t / 0.125)) < 1e-9, `${t}`);
  });
});

console.log(`
${passed} passed, ${failed} failed`);
process.exit(failed > 0 ? 1 : 0);
