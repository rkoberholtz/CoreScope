/* Unit tests for the "ambient" voice (public/audio-v5-ambient.js). */
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

const v = ctx._meshAudioVoices.ambient;
const arrange = (t, b, x) => v.arrange(parsed(t, b || BYTES, x));

console.log('\n=== basics ===');
voiceBasics(test, ctx, 'ambient', 16);

console.log('\n=== arrange ===');
test('every note is in C major pentatonic (overlaps never clash)', () => {
  const ok = new Set([0, 2, 4, 7, 9]);
  ['ADVERT', 'GRP_TXT', 'TXT_MSG', 'TRACE', 'REQ'].forEach((t) => {
    for (let b = 0; b < 256; b += 17) arrange(t, [b, b ^ 0x5a, b ^ 0xa5, b, b]).forEach((n) => pcs(n.midis).forEach((pc) => assert.ok(ok.has(pc), `${t} pc ${pc}`)));
  });
});
test('ADVERT is a low drone pad; 3+ observers add the octave', () => {
  const [pad] = arrange('ADVERT');
  assert.strictEqual(pad.kind, 'pad');
  assert.ok(pad.midis[0] < 48 && pad.midis.length === 2 && pad.midis[1] - pad.midis[0] === 7);
  assert.strictEqual(arrange('ADVERT', BYTES, { obsCount: 3 })[0].midis.length, 3);
});
test('sparse: GRP_TXT 1–2 bells, TXT_MSG 2–3 bells, TRACE 3–5 high glints', () => {
  const g = arrange('GRP_TXT'), m = arrange('TXT_MSG'), tr = arrange('TRACE');
  assert.ok(g.length >= 1 && g.length <= 2 && g.every((n) => n.kind === 'bell'));
  assert.ok(m.length >= 2 && m.length <= 3 && m.every((n) => n.kind === 'bell'));
  assert.ok(tr.length >= 3 && tr.length <= 5 && tr.every((n) => n.kind === 'glint' && n.midis[0] >= 84));
});

console.log('\n=== play() ===');
test('more hops → quieter dry signal and more reverb', () => {
  const dryGain = (hops) => {
    const r = play(v, parsed('GRP_TXT', BYTES, { hopCount: hops }));
    const fromVerb = (g) => r.nodes.some((x) => x.kind === 'convolver' && x.outputs.includes(g));
    return r.nodes.find((n) => n.kind === 'gain' && n.outputs.includes(r.master) && !fromVerb(n)).gain.value;
  };
  assert.ok(dryGain(10) < dryGain(1));
  const hallSend = (hops) => Math.max(...play(v, parsed('GRP_TXT', BYTES, { hopCount: hops })).nodes
    .filter((n) => n.kind === 'gain' && n.outputs.some((o) => o.outputs && o.outputs.some((x) => x.kind === 'convolver'))).map((n) => n.gain.value));
  assert.ok(hallSend(10) > hallSend(1));
});
test('not tied to the grid: starts right away', () => {
  const r = play(v, parsed('GRP_TXT', BYTES), {}, 1.03);
  const t = Math.min(...r.nodes.filter((n) => n.kind === 'osc').map((o) => o.frequency.events[0].t));
  assert.ok(Math.abs(t - 1.08) < 1e-9);
});

console.log(`
${passed} passed, ${failed} failed`);
process.exit(failed > 0 ? 1 : 0);
