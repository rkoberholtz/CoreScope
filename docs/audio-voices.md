# Live map audio voices

The Live page can turn each incoming packet into sound. *How* a packet sounds is
decided by a **voice**: a small, self-contained JavaScript module that receives a
parsed packet and schedules Web Audio nodes. Voices are pluggable. Add a file,
register it, and it shows up in the **Voice** dropdown on the Live page and in
the Audio Lab (`#/audio-lab`).

This guide covers how the pieces fit together, the voice contract, the shared
building blocks, and how to test a new voice.

## Existing voices

| Voice | File | Style |
|-------|------|-------|
| `constellation` | `public/audio-v1-constellation.js` | Melodic sine/triangle tones, scale per packet type (default voice) |
| `metal` | `public/audio-v2-metal.js` | Distorted drop-D guitar: power chords, palm-mute chugs, leads, bends |
| `synthmetal` | `public/audio-v3-synthmetal.js` | Metal guitar + supersaws, octave bass, kick/gated snare, ping-pong delay |
| `technoir` | `public/audio-v4-technoir.js` | Dark 80s synthwave: driving bass, drum machine, chorused pads |
| `ambient` | `public/audio-v5-ambient.js` | Slow FM bells and drone pads in a big hall, not tied to the beat |
| `dub` | `public/audio-v6-dub.js` | One-drop drums, offbeat skanks into a long feedback echo, sirens |
| `acid` | `public/audio-v7-acid.js` | TB-303 patterns from packet bytes over four-on-the-floor drums |
| `lofi` | `public/audio-v8-lofi.js` | Swung boom-bap, electric-piano jazz chords, tape wobble, crackle |

`metal` doubles as a guitar rig that other voices reuse. Every voice after it
is built on the shared synth kit (`public/audio-synthkit.js`).

## How it fits together

```
live.js ──(each packet)──▶ MeshAudio.sonifyPacket(pkt)          public/audio.js
                               │  parsePacketBytes(pkt) → parsed
                               │  voice-slot cap (MAX_VOICES = 12)
                               ▼
                           currentVoice.play(audioCtx, masterGain, parsed, opts)
                               │  schedules oscillators/filters/gains
                               ▼
                           masterGain (volume slider) → speakers
```

- **`public/audio.js`** is the engine. It owns the `AudioContext`, the master
  gain (the volume slider), BPM, the voice registry and the enabled/voice/BPM/
  volume settings in `localStorage`. It also exposes shared helpers for voices.
- **`public/audio-synthkit.js`** (`MeshAudio.synthkit`) holds shared instruments
  (supersaw, FM bell/electric piano, 303 acid, bass, kick, snare, hi-hat, vinyl
  crackle) and effects buses (gated reverb, hall, ping-pong delay, dub echo,
  chorus).
- **`public/audio-v*.js`** are the voices. Each is an IIFE that calls
  `MeshAudio.registerVoice(...)` when it loads.
- **`public/index.html`** loads them in order. Load order matters (see below).

The first voice to register becomes the default, so `constellation` must stay
first. A saved choice (`localStorage['live-audio-voice']`) is restored when the
Live page initialises. The Voice dropdown only appears once two or more voices
are registered.

## The voice contract

```js
MeshAudio.registerVoice(name, {
  name,                                         // same string, lowercase
  play(audioCtx, masterGain, parsed, opts) {    // required
    // schedule audio starting at audioCtx.currentTime + a small lookahead
    return durationSeconds;                     // how long this packet's notes run
  },
  // anything else you attach (e.g. a pure arrange() for tests) is allowed
});
```

### `parsed`: what you get about the packet

Built by `parsePacketBytes()` in `audio.js`. `play()` is never called when
`payloadBytes` is empty.

| Field | Type | Meaning |
|-------|------|---------|
| `allBytes` | `number[]` | Every byte of the raw packet (0–255) |
| `headerBytes` | `number[]` | First 3 bytes |
| `payloadBytes` | `number[]` | Everything after the first 3 bytes, the usual melody source |
| `typeName` | `string` | Decoded payload type, e.g. `ADVERT`, `GRP_TXT`, `TXT_MSG`, `TRACE`, `REQ`, or `UNKNOWN` |
| `hopCount` | `number` | Path hops, at least 1 |
| `obsCount` | `number` | How many observers heard the packet, at least 1 |
| `payload` | `object` | Decoded payload. May carry `lat`/`lon` (adverts) |
| `hops` | `array` | Decoded path hops |

Always handle an unrecognised `typeName` (fall back to a default treatment).

### `opts`

| Field | Meaning |
|-------|---------|
| `bpm` | Current BPM slider value (40–300) |
| `tempoMultiplier` | `120 / bpm`. Multiply all your durations by it. A 16th note is `0.125 * opts.tempoMultiplier` seconds |

### Return value and the voice-slot cap

The engine plays at most `MAX_VOICES` (12) packets at once. Each `play()` call
takes a slot, which is released `duration + 0.5` s later. Packets that arrive
while every slot is busy are skipped silently.

Return how long **this packet's own notes** run. Don't include echo or reverb
tails that ring in shared effects buses. Those don't cost the packet anything,
and counting them makes busy traffic drop more packets than it needs to.

If `play()` throws, the engine catches it, logs `[audio] voice error:` and frees
the slot.

## Shared helpers: `MeshAudio.helpers`

| Helper | What it does |
|--------|--------------|
| `buildScale(intervals, rootMidi)` | 3 octaves of MIDI notes, e.g. `buildScale([0,3,5,7,10], 62)` for D minor pentatonic |
| `quantizeToScale(byte, scale)` | Maps a byte (0–255) evenly onto a scale array |
| `midiToFreq(midi)` | MIDI note → Hz (A4 = 69 = 440 Hz) |
| `mapRange(v, inMin, inMax, outMin, outMax)` | Linear mapping |
| `sampleBytes(bytes, minN, maxN)` | Evenly picks `sqrt(len)` bytes, clamped to `[minN, maxN]`. Use it for note count |
| `panFor(parsed)` | Stereo position: longitude when the packet has coordinates, a small random spread for routed packets, centre otherwise |

## Shared synth kit: `MeshAudio.synthkit`

Load `audio-synthkit.js` before any voice that uses it.

| Function | Purpose |
|----------|---------|
| `bus(audioCtx, masterGain, name)` | Lazily builds, once per `AudioContext`, and returns a shared bus: `'noise'` and `'crackle'` (`{ buffer }`), `'gated'`, `'hall'`, `'chorus'` (`{ input }`), `'delay'` (ping-pong) and `'dubecho'` (`{ input, delays: [...] }`; set `delays[i].delayTime.value` per packet to follow BPM) |
| `gridStart(audioCtx, sixteenth)` | Next 16th-note boundary on a global grid. Start riffs here so overlapping packets stay in time |
| `stepTime(t0, step, sixteenth, swing?)` | Time of a grid step, with odd 16ths pushed late by `swing` × a 16th. Start swung riffs with `gridStart(ctx, 2 * sixteenth)` |
| `createMix(audioCtx, masterGain, level)` | Per-packet `{ mix, nodes }`: gain → glue limiter → master. Disconnect `nodes` when done |
| `duck(gainParam, t, recover, depth?)` | Sidechain "pump": dips a bus on a kick |
| `playSynth(ctx, dest, preset, midis, start, dur, { glideFrom?, sends? })` | Detuned oscillator stack through an enveloped resonant lowpass. `preset = { type?, detunes, cutoff: [start, peak, end], filterAttack?, q, attack, sustain, release, level }`. `sends = [[busInput, amount], ...]` |
| `playFM(ctx, dest, preset, midis, start, dur, { sends?, pitchMod? })` | Two-operator FM: bells (inharmonic `ratio`) or electric piano (`ratio: 1`). `preset = { ratio, index: [peak, settled], indexDecay, attack, decay, sustain, release, level }`. `pitchMod` is a node (e.g. an LFO gain in cents) fed into every oscillator's detune |
| `playAcid(ctx, dest, { midi, accent, slide, prevMidi }, start, dur, { cutoff, q, envMod, decay, level })` | One TB-303 step: resonant filter envelope, accents, slides |
| `playBass(ctx, dest, midi, start, dur, { cutoff: [open, closed], q, level, maxDecay }?)` | Plucked saw bass |
| `playKick(ctx, dest, start, { from, to, sweep, decay, level }?)` | Sine kick with pitch drop |
| `playSnare(ctx, dest, noiseBuffer, start, sends?, { level, decay, body }?)` | Noise snare with tonal body |
| `playHat(ctx, dest, noiseBuffer, start, level)` | Closed hi-hat |
| `playCrackle(ctx, dest, crackleBuffer, start, end, level)` | Looped vinyl crackle under a packet |

Every `play*` function returns the time its nodes stop, so you can track the
packet's end time. Each one disconnects its own nodes in `onended`.

### Guitar rig (from `metal`)

`window._meshAudioVoices.metal` exposes `buildAmp(ctx, dest, cabLowpassHz,
level, pan)` → `{ input, nodes }` and `playNote(ctx, ampInput, event, start,
dur)`. `event = { midis, tech }` with `tech` one of `'chord'`, `'mute'`,
`'lead'`, `'bend'`, `'pinch'`. Load `audio-v2-metal.js` before any voice that
uses it.

## Adding a voice, step by step

### 1. Create the file

Name it `public/audio-v<N>-<name>.js` (the next free number is 9). A minimal working voice:

```js
// Voice v9: "Chime" — one triangle-wave note per sampled byte
(function () {
  'use strict';

  const { buildScale, quantizeToScale, midiToFreq, sampleBytes, panFor } = MeshAudio.helpers;
  const SCALE = buildScale([0, 2, 4, 7, 9], 60); // C major pentatonic from C4

  function play(audioCtx, masterGain, parsed, opts) {
    const sixteenth = 0.125 * opts.tempoMultiplier;
    const out = audioCtx.createStereoPanner();
    out.pan.value = panFor(parsed);
    out.connect(masterGain);

    const t0 = audioCtx.currentTime + 0.02; // small lookahead
    let end = t0;
    sampleBytes(parsed.payloadBytes, 3, 8).forEach((b, i) => {
      const start = t0 + i * 2 * sixteenth;
      const stop = start + 1.5 * sixteenth;
      const osc = audioCtx.createOscillator();
      const env = audioCtx.createGain();
      osc.type = 'triangle';
      osc.frequency.value = midiToFreq(quantizeToScale(b, SCALE));
      env.gain.setValueAtTime(0.0001, start);
      env.gain.exponentialRampToValueAtTime(0.5, start + 0.01);
      env.gain.exponentialRampToValueAtTime(0.0001, stop);
      osc.connect(env);
      env.connect(out);
      osc.start(start);
      osc.stop(stop + 0.05);
      osc.onended = () => { osc.disconnect(); env.disconnect(); };
      end = stop + 0.05;
    });

    setTimeout(() => out.disconnect(), (end - audioCtx.currentTime + 1) * 1000);
    return end - audioCtx.currentTime;
  }

  MeshAudio.registerVoice('chime', { name: 'chime', play });
})();
```

### 2. Load it in `public/index.html`

Add a script tag after the voices it depends on and before `audio-lab.js`,
matching the existing tags:

```html
<script src="audio-v9-chime.js?v=__BUST__" onerror="console.error('Failed to load:', this.src)"></script>
```

The order is `audio.js` → `audio-synthkit.js` → `audio-v1-constellation.js`
(the default) → `audio-v2-metal.js` → other voices. Leave `__BUST__` as it is.
The server swaps it for a cache-busting timestamp at startup, so **restart the
server** after editing `index.html`.

### 3. Try it

Open `#/live`, tick **Audio**, and pick your voice in the Voice dropdown. For
repeatable listening, use the Audio Lab (`#/audio-lab`). It has the same voice
selector, a sidebar of sample packets grouped by type, and **Play** / **Loop**
buttons. Its "Sound Mapping" table and per-note breakdown describe the
`constellation` voice's mapping, not yours.

## Design guidelines

These are the patterns the existing voices follow. They are what keep audio
cheap on a busy mesh (30K+ packets, several arriving per second).

- **Separate the music from the audio.** Write a pure `arrange(parsed)` (or
  `buildRiff`) that returns note events on a step grid, and a `play()` that
  renders them. The pure part can be unit-tested exactly. Expose it on the
  voice object (`registerVoice('x', { name, play, arrange })`).
- **Be deterministic.** The same packet should always produce the same riff.
  Derive everything from the packet's bytes and fields. The only randomness
  allowed is `panFor`'s spread and noise buffers.
- **Follow the tempo.** Scale every duration by `opts.tempoMultiplier`. If your
  voice has drums or a groove, start on `kit.gridStart()` so concurrent packets
  lock together.
- **Budget oscillators.** Stay at or below **128 oscillators per packet** in the
  worst case (the longest payload, the highest `obsCount`, every type). For a
  sine sub bass, use `playSynth` with `type: 'sine'` and one detune rather
  than a new instrument. Use
  `sampleBytes` to bound the note count. Limit detuned stacks to 3–5
  oscillators.
- **Never build expensive nodes per packet.** Convolvers (reverb), long delays
  and LFOs belong in shared buses, built once per `AudioContext` (`kit.bus`, or
  your own `WeakMap` keyed by the context).
- **Clean up.** Disconnect every per-note node in the oscillator's `onended`, and
  disconnect per-packet buses in a `setTimeout` after the last note.
- **Exponential ramps can't reach 0.** Use `0.0001` as "silent" for
  `exponentialRampToValueAtTime`.
- **Match the other voices' loudness.** At master gain 0.3, the existing voices
  land around −33 to −24 dB RMS while sounding, with peaks well under 1.0. Check
  yours with the snippet below and adjust the per-packet level.

### Measuring level and output in the browser

Run this in the dev tools console on `#/live`. It renders offline, so nothing
plays out loud.

```js
const bytes = Array.from({ length: 40 }, (_, i) => (i * 97 + 13) & 255);
for (const t of ['ADVERT', 'GRP_TXT', 'TXT_MSG', 'TRACE']) {
  const oc = new OfflineAudioContext(2, 44100 * 5, 44100);
  const master = oc.createGain(); master.gain.value = 0.3; master.connect(oc.destination);
  _meshAudioVoices.chime.play(oc, master, { payloadBytes: bytes, typeName: t, hopCount: 2, obsCount: 4, payload: {}, hops: [] }, { bpm: 120, tempoMultiplier: 1 });
  const d = (await oc.startRendering()).getChannelData(0);
  let peak = 0, sum = 0, n = 0;
  for (const x of d) { const a = Math.abs(x); peak = Math.max(peak, a); if (a > 1e-3) { sum += x * x; n++; } }
  console.log(t, 'peak', peak.toFixed(3), 'rms', (10 * Math.log10(sum / Math.max(1, n))).toFixed(1), 'dB');
}
```

## Testing

Every voice needs tests (see `AGENTS.md`). Two layers:

### Unit tests (`tests/unit/test-audio-<name>.js`)

`tests/unit/audio-harness.js` loads the real `public/audio*.js` files into a
`vm` context with a fake `AudioContext` that records every node, connection and
parameter automation:

```js
const assert = require('assert');
const { loadAudio, playOnce, reaches, parsed } = require('./audio-harness');

const ctx = loadAudio(['public/audio-v1-constellation.js', 'public/audio-v9-chime.js']);
const chime = ctx._meshAudioVoices.chime;

// Render one packet and inspect the graph
const r = playOnce(chime, parsed('ADVERT', [1, 2, 3, 4, 5, 6, 7, 8, 9]));
assert.ok(r.dur > 0);
r.nodes.filter((n) => n.kind === 'osc').forEach((o) => assert.ok(reaches(o, r.master)));
```

`voiceBasics(test, ctx, name, budget)` from the harness runs the checks every
voice needs: registration with `constellation` still the default, every
oscillator heard or modulating, the worst-case oscillator budget, deterministic
`arrange()`, and engine integration. Load all voices with `loadAudio(ALL_VOICE_FILES)`
after adding yours to `ALL_VOICE_FILES`. See `test-audio-dub.js` for a compact
example, and `test-audio-technoir.js` for a longer one.

Also worth covering:

- `arrange()` output for each type: notes in the intended scale, rhythm on the
  grid, fallback for unknown types, same bytes giving the same result
- the audio graph: every oscillator reaches the master; effects are shared
  (built once per context); worst-case oscillator count stays within budget
- `MeshAudio.sonifyPacket()` with the voice selected doesn't throw for any type

Arrays created inside the `vm` context have a different prototype. Spread them
(`[...arr]`) before `assert.deepStrictEqual`.

Add the file to `test-all.sh` in alphabetical order. The inventory check
(`tests/unit/test-test-inventory.js`) fails if a `test-*.js` file isn't listed.

### E2E (`tests/e2e/test-audio-live-1297-e2e.js`)

This test stubs `AudioContext` in the browser and drives the Live page. Add your
voice to the voice list checks: the dropdown lists it, selecting it persists,
and it plays every type without logging `[audio] voice error`. If your voice
uses a Web Audio node the stub doesn't provide yet, add it to the
`FakeAudioContext` there.

## Trying a voice on a running Docker container

The image copies `public/` into `/app/public` at build time. To try a voice on
an existing container without rebuilding:

```sh
docker cp public/audio-v9-chime.js <container>:/app/public/
docker exec <container> sed -i 's#\(<script src="audio-v8-lofi.js[^>]*></script>\)#\1\n  <script src="audio-v9-chime.js?v=__BUST__"></script>#' /app/public/index.html
docker restart <container>   # re-applies cache busting
```

Also copy any shared files your voice depends on (`audio.js`,
`audio-synthkit.js`, `audio-v2-metal.js`) if they're newer than the image's.
Changes made this way are lost when the container is recreated. For a lasting
change, rebuild the image.
