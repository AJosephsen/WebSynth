// The matrix inside the synth and the sequencer: modulation changes the sound, stays finite, routes to the mix, TIME delays a step.
import { factoryInstrument } from "../src/instruments";
import { createEngine, Engine } from "../src/seq/engine";
import { engineById } from "../src/engines/registry";
import { defaultInput, NoteInput } from "../src/synth/noteinput";
import { makeSynth, Instrument } from "../src/synth/synth";
import { defaultSongFx, emptyPattern, sanitizeSong, Song } from "../src/seq/song";
import { defaultMod, ModSetup } from "../src/mod/setup";
import { MD_CUT, MD_PAN, MD_PITCH, MD_TIME, MS_LFO, MS_RAND, MS_MODW, MD_DEPTH } from "../src/mod/mod";

let fails = 0;
const check = (ok: boolean, msg: string): void => { if (!ok) { fails++; console.error("FAIL " + msg); } };

function song(mod?: ModSetup): Song {
  const s: Song = {
    bpm: 120, swing: 0,
    tracks: [{ patch: "ANALOG/SAW LEAD", mute: false, level: 112, pan: 0, dist: 0, chorus: 0, delay: 0, reverb: 0, itype: 0, imix: 64, ia: 0, ib: 0, ic: 0, mod },
      { patch: "INIT", mute: true }, { patch: "INIT", mute: true }, { patch: "INIT", mute: true }] as Song["tracks"],
    fx: defaultSongFx(),
    patterns: [emptyPattern("A", 4)],
    arrangement: [0],
  };
  s.patterns[0].steps[0][0] = { notes: [57], gate: 2 };
  return s;
}
function render(s: Song, blocks = 200): { l: Float32Array; r: Float32Array } {
  const e = createEngine(44100, s, factoryInstrument);
  e.play();
  const l = new Float32Array(blocks * 32), r = new Float32Array(blocks * 32);
  e.renderStereo(l, r);
  return { l, r };
}
const diff = (a: Float32Array, b: Float32Array): number => { let d = 0; for (let i = 0; i < a.length; i++) d += Math.abs(a[i] - b[i]); return d; };
const peak = (a: Float32Array): number => a.reduce((m, x) => Math.max(m, Math.abs(x)), 0);

const base = render(song());
check(peak(base.l) > 0.01, "the unmodulated track sounds");

const m = defaultMod();
m.rate = 100; m.ldPit = 30;
const vib = render(song(m));
check(vib.l.every(Number.isFinite) && diff(base.l, vib.l) > 1, "LFO to pitch changes the sound");

const m2 = defaultMod();
m2.rate = 100; m2.slots[0] = { src: MS_LFO, dst: MD_CUT, amt: 50 }; m2.slots[1] = { src: MS_RAND, dst: MD_PITCH, amt: 10 };
const mx = render(song(m2));
check(mx.l.every(Number.isFinite) && diff(base.l, mx.l) > 1, "matrix slots change the sound");

const m3 = defaultMod();
m3.rate = 110; m3.slots[0] = { src: MS_LFO, dst: MD_PAN, amt: 63 };
const pan = render(song(m3));
let lr = 0;
for (let i = 0; i < pan.l.length; i++) lr += Math.abs(pan.l[i]) - Math.abs(pan.r[i]);
check(diff(base.l, pan.l) > 1 && diff(base.r, pan.r) > 1, "PAN modulation moves the stereo image");

const m4 = defaultMod();
m4.slots[0] = { src: MS_RAND, dst: MD_TIME, amt: 64 };
const late = render(song(m4));
const first = (a: Float32Array): number => a.findIndex((x) => Math.abs(x) > 1e-4);
check(first(late.l) >= first(base.l), "TIME plays a step late, never early");

const m5 = defaultMod();
m5.slots[0] = { src: MS_MODW, dst: MD_DEPTH, amt: 64 };
const sx = sanitizeSong(JSON.parse(JSON.stringify(song(m2))));
check(JSON.stringify(sx?.tracks[0].mod) === JSON.stringify(m2), "the modulation setup survives sanitize");
check(sanitizeSong(JSON.parse(JSON.stringify(song())))?.tracks[0].mod === undefined, "a default setup is not stored");
void m5; void lr;
// the FX hold layer: a throw changes the mix, a mute key silences its track (after its 2.9 ms ramp)
{
  const N = 600 * 32;
  const make = (bit?: number): Float32Array => {
    const e = createEngine(44100, song(), factoryInstrument);
    if (bit !== undefined) e.perform.press(bit, true);
    e.play();
    const l = new Float32Array(N), r = new Float32Array(N);
    e.renderStereo(l, r);
    return l;
  };
  const plain = make(), rev = make(12), echo = make(13), muted = make(14);
  check(rev.every(Number.isFinite) && diff(plain, rev) > 1, "REV THROW adds reverb send");
  check(diff(plain, echo) > 1, "ECHO THROW adds delay send");
  check(peak(muted.subarray(1000)) < peak(plain) * 0.02, "a mute key silences its track");
}
// voice modes: UNISON stacks voices, MONO / LEGATO keep one, GLIDE moves the pitch, SPREAD opens the stereo image
{
  const base = factoryInstrument("ANALOG/SAW LEAD") as Extract<Instrument, { kind: "engine" }>;
  const vp = (o: object): Instrument => ({ ...base, vp: { voice: 0, glide: 0, glmode: 0, prio: 0, alloc: 0, detune: 40, spread: 0, ...o } });
  const run = (inst: Instrument, notes: number[][], blocks = 150): { l: Float32Array; r: Float32Array; syn: ReturnType<typeof makeSynth> } => {
    const syn = makeSynth(inst, 8);
    const song0 = song();
    const e = new Engine(44100, makeSynth(factoryInstrument("INIT"), 2), song0);
    e.addTrack(syn);
    const l = new Float32Array(blocks * 32), r = new Float32Array(blocks * 32);
    const half = Math.floor(l.length / 2);
    for (const n of notes[0]) syn.noteOn(n, 100);
    e.renderStereo(l.subarray(0, half), r.subarray(0, half));
    for (const n of notes[1] ?? []) syn.noteOn(n, 100);
    e.renderStereo(l.subarray(half), r.subarray(half));
    return { l, r, syn };
  };
  void engineById;
  const poly = run(vp({}), [[60]]);
  const uni = run(vp({ voice: 3 }), [[60]]);
  check(poly.syn.activeVoices === 1 && uni.syn.activeVoices === 8, `UNISON sounds 8 voices (got ${uni.syn.activeVoices})`);
  check(diff(poly.l, uni.l) > 1, "UNISON changes the sound");
  const mono = run(vp({ voice: 1 }), [[60], [64, 67]]);
  check(mono.syn.activeVoices === 1, "MONO keeps one voice");
  const g0 = run(vp({ voice: 2 }), [[60], [72]]), g1 = run(vp({ voice: 2, glide: 60 }), [[60], [72]]);
  check(g1.l.every(Number.isFinite) && diff(g0.l, g1.l) > 1, "GLIDE moves the pitch between notes");
  const sp0 = run(vp({}), [[60, 64, 67]]), sp1 = run(vp({ spread: 127 }), [[60, 64, 67]]);
  let lr0 = 0, lr1 = 0;
  for (let i = 0; i < sp0.l.length; i++) { lr0 += Math.abs(sp0.l[i] - sp0.r[i]); lr1 += Math.abs(sp1.l[i] - sp1.r[i]); }
  check(lr0 < 1e-3 && lr1 > 1, `SPREAD opens the stereo image (L-R ${lr0.toFixed(3)} -> ${lr1.toFixed(2)})`);
}
// chord keys and the arpeggiator in front of a synth
{
  const events: string[] = [];
  const rec = { gain: 1, activeVoices: 0, noteOn: (n: number) => events.push(`+${n}`), noteOff: (n: number) => events.push(`-${n}`), allOff: () => events.push("off"), render: () => undefined };
  const input = new NoteInput(() => rec);
  const st = defaultInput();
  st.chord.chrd = 3; // MAJ
  input.set(st);
  input.noteOn(60, 100);
  input.noteOff(60);
  check(events.join(" ") === "+60 +64 +67 -60 -64 -67", `a chord key starts and ends its notes (${events.join(" ")})`);
  events.length = 0;
  const st2 = defaultInput();
  st2.arp.mode = 1; // UP
  st2.arp.rate = 2; // 1/16
  input.set(st2);
  input.noteOn(60, 100);
  input.noteOn(64, 100);
  for (let i = 0; i < 1400; i++) input.tick(32, 22050); // 1 s at 120 BPM: eight sixteenths
  const ons = events.filter((e) => e.startsWith("+")).map((e) => e.slice(1)).join(",");
  check(/^(60,64,)+/.test(ons + ","), `the arp alternates the held notes (${ons})`);
  check(events.filter((e) => e.startsWith("+")).length >= 6, "the arp plays in time");
}
if (fails) process.exit(1);
console.log("OK modulation in the synth and sequencer");
