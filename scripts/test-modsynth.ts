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
// the track sequencers: polymeter, ratchets, ties
{
  const sg = song();
  const pat = sg.patterns[0];
  pat.length = 16;
  pat.lens = [16, 12, 16, 16];
  for (let i = 0; i < 16; i++) pat.steps[1][i] = { notes: [60 + (i % 12)] };
  const e = createEngine(44100, sg, factoryInstrument);
  const seen: number[][] = [[], [], [], []];
  e.onTrackStep = (t, _p, st) => seen[t].push(st);
  e.mode = "pattern";
  e.play();
  const buf = new Float32Array(128);
  for (let i = 0; i < Math.ceil(44100 * 3.9 / 128); i++) e.render(buf); // a little under two passes of 16 steps
  const t1 = seen[1].slice(0, 20).join(",");
  check(t1.startsWith("0,1,2,3,4,5,6,7,8,9,10,11,0,1,2,3,0,1,2,3"), `a 12-step track loops inside a 16-step pattern (${t1})`);
  check(seen[0].slice(14, 18).join(",") === "14,15,0,1", `track 1 runs its 16 steps then restarts with the pattern (${seen[0].slice(14, 18)})`);
  // a ratcheted step plays its hits
  const sg2 = song();
  sg2.patterns[0].steps[0][0] = { notes: [60], ratchet: 4 };
  const e2 = createEngine(44100, sg2, factoryInstrument);
  let ons = 0;
  const orig = e2.tracks[0].synth.noteOn.bind(e2.tracks[0].synth);
  e2.tracks[0].synth.noteOn = (n: number, v?: number) => { ons++; orig(n, v); };
  e2.mode = "pattern";
  e2.play();
  for (let i = 0; i < Math.ceil(44100 * 0.45 / 128); i++) e2.render(buf);
  check(ons === 4, `a RATCH 4 step plays four hits (${ons})`);
}
// the song chain: a section repeats, a lane can play another pattern or stay silent
{
  const sg = song();
  sg.patterns[0] = emptyPattern("A", 4);
  sg.patterns[0].steps[0][0] = { notes: [60] };
  sg.patterns.push(emptyPattern("B", 4));
  sg.patterns[1].steps[0][0] = { notes: [67] };
  sg.arrangement = [0, 0];
  sg.sections = [{ repeat: 2 }, { lanes: [1, -2, -1, -1] }];
  const e = createEngine(44100, sg, factoryInstrument);
  const seen: string[] = [];
  e.onStep = (p, st, ap) => seen.push(`${p}.${st}@${ap}`);
  const played: number[] = [];
  const orig = e.tracks[0].synth.noteOn.bind(e.tracks[0].synth);
  e.tracks[0].synth.noteOn = (n: number, v?: number) => { played.push(n); orig(n, v); };
  e.play();
  const buf = new Float32Array(128);
  for (let i = 0; i < Math.ceil(44100 * 2.4 / 128); i++) e.render(buf);
  check(seen.slice(0, 9).join() === "0.0@0,0.1@0,0.2@0,0.3@0,0.0@0,0.1@0,0.2@0,0.3@0,1.0@1", `a section repeats, then the next (${seen.slice(0, 9)})`);
  check(played.slice(0, 3).join() === "60,60,67", `a lane plays another pattern (${played.slice(0, 3)})`);
}
// motion: a lock holds for its step only, automation holds until the loop restarts
{
  const sg = song();
  sg.patterns[0] = emptyPattern("M", 4);
  for (let i = 0; i < 4; i++) sg.patterns[0].steps[0][i] = { notes: [60 + i] };
  sg.patterns[0].motion = [
    { track: 0, step: 1, param: 12, value: 40, lock: true }, // P_PAN
    { track: 0, step: 2, param: 13, value: 50 }, // P_DIST
  ];
  const e = createEngine(44100, sg, factoryInstrument);
  const store = e.tracks[0].synth.paramStore!;
  let cur = -1;
  e.onTrackStep = (t, _p, st) => { if (t === 0) cur = st; };
  e.mode = "pattern";
  e.play();
  const l = new Float32Array(32), r = new Float32Array(32);
  const at: Record<number, { pan: number; dist: number }> = {};
  const second: Record<number, { pan: number; dist: number }> = {};
  let pass = 0, prev = -1;
  for (let b = 0; b < 800 && pass < 2; b++) {
    e.renderStereo(l, r);
    if (cur < prev) pass++;
    prev = cur;
    const rec = { pan: store.read(12), dist: store.read(13) };
    if (pass === 0) at[cur] = rec; else second[cur] = rec;
  }
  check(at[1].pan === 40 && at[0].pan === 0 && at[2].pan === 0, `a lock holds for its step only (pan ${at[0].pan},${at[1].pan},${at[2].pan})`);
  check(at[1].dist === 0 && at[2].dist === 50 && at[3].dist === 50, `automation holds from its step (dist ${at[1].dist},${at[2].dist},${at[3].dist})`);
  check(second[0]?.dist === 0, `the loop's restart puts the sound's own value back (dist ${second[0]?.dist})`);
  e.stop();
  check(store.read(13) === 0 && store.read(12) === 0, "stop restores the sound's own values");
}
// the SLICER insert gates a sustained sound
{
  const rmsOf = (sl?: { mode: number; pat: number; rate: number; depth: number }): number => {
    const sg = song();
    sg.patterns[0].steps[0][0] = { notes: [57], gate: 6 };
    if (sl) sg.tracks[0].slicer = sl;
    const out = render(sg, 600);
    let sum = 0;
    for (let i = 0; i < out.l.length; i++) sum += out.l[i] * out.l[i];
    return Math.sqrt(sum / out.l.length);
  };
  const open = rmsOf();
  const gated = rmsOf({ mode: 1, pat: 7, rate: 1, depth: 127 });
  check(gated < open * 0.7 && gated > 0, `the SLICER gate closes the '.' steps (rms ${open.toFixed(3)} -> ${gated.toFixed(3)})`);
}
if (fails) process.exit(1);
console.log("OK modulation in the synth and sequencer");
