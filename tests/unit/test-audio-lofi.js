/* Unit tests for the "lofi" voice (public/audio-v8-lofi.js). */
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

const v = ctx._meshAudioVoices.lofi;
const arrange = (t, b, x) => v.arrange(parsed(t, b || BYTES, x));
const F_MAJOR = new Set([5, 7, 9, 10, 0, 2, 4]);

console.log('\n=== basics ===');
voiceBasics(test, ctx, 'lofi', 64);

console.log('\n=== arrange ===');
test('every chord, bass, melody and arp note is in F major', () => {
  ['ADVERT', 'GRP_TXT', 'TXT_MSG', 'TRACE'].forEach((t) => {
    for (let b = 0; b < 256; b += 9) {
      const a = arrange(t, [b, b ^ 0x77, b]);
      pcs(a.chords.flatMap((c) => [...c.midis]).concat(a.bass.map((n) => n.midi), a.melody.map((n) => n.midi), a.arp.map((n) => n.midi)))
        .forEach((pc) => assert.ok(F_MAJOR.has(pc), `${t} pc ${pc}`));
    }
  });
});
test('chords are 5-note jazz voicings with no semitone clusters', () => {
  for (let b = 0; b < 256; b += 16) {
    const [c] = arrange('ADVERT', [b, b]).chords;
    assert.strictEqual(c.midis.length, 5);
    for (let i = 1; i < 5; i++) assert.ok(c.midis[i] - c.midis[i - 1] >= 2, `${c.midis}`);
  }
});
test('boom-bap: kicks on 1 and the "and" of 3, snares on 2 and 4', () => {
  const a = arrange('ADVERT');
  a.drums.forEach((d) => {
    if (d.kind === 'kick') assert.ok([0, 10].includes(d.step % 16));
    if (d.kind === 'snare') assert.ok([4, 12].includes(d.step % 16));
  });
  assert.ok(a.drums.some((d) => d.kind === 'kick') && a.drums.some((d) => d.kind === 'snare'));
});
test('TXT_MSG has a melody and no drums; TRACE is an arp with hats only', () => {
  const m = arrange('TXT_MSG');
  assert.ok(m.melody.length > 0 && m.drums.length === 0);
  const t = arrange('TRACE');
  assert.ok(t.arp.length === t.steps && t.chords.length === 0 && t.drums.every((d) => d.kind === 'hat'));
});

console.log('\n=== play() ===');
const noteTimes = (r) => r.nodes.filter((n) => n.kind === 'osc' && n.frequency.events.length && n.type === 'sine').map((o) => o.frequency.events[0].t);
test('swing: starts on an 8th boundary and pushes odd 16ths late', () => {
  const r = play(v, parsed('TRACE', BYTES), {}, 0.3);
  const times = [...new Set(noteTimes(r))].sort((a, b) => a - b);
  assert.ok(Math.abs(times[0] - 0.5) < 1e-9, `starts at ${times[0]}`);
  assert.ok(Math.abs((times[1] - times[0]) - 0.125 * 1.3) < 1e-9, `odd step at ${times[1] - times[0]}`);
});
test('more hops → darker tape filter and deeper wobble', () => {
  const tape = (hops) => play(v, parsed('ADVERT', BYTES, { hopCount: hops })).nodes.find((n) => n.kind === 'biquad' && n.type === 'lowpass' && n.Q.value === 0.5);
  assert.ok(tape(10).frequency.value < tape(1).frequency.value);
  const wobble = (hops) => play(v, parsed('ADVERT', BYTES, { hopCount: hops })).nodes.find((n) => n.kind === 'osc' && n.frequency.value === 0.8).outputs[0].gain.value;
  assert.ok(wobble(10) > wobble(1));
});
test('vinyl crackle loops under the packet', () => {
  const src = play(v, parsed('GRP_TXT', BYTES)).nodes.find((n) => n.kind === 'bufsrc' && n.loop);
  assert.ok(src);
});

console.log(`
${passed} passed, ${failed} failed`);
process.exit(failed > 0 ? 1 : 0);
