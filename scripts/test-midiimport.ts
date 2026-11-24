// MIDI file import: a small file with drums, bass and a chord becomes a song with the drums on track 1 and MIDI track 1.
import { importMidi } from "../src/seq/midiimport";
import { sanitizeSong } from "../src/seq/song";

let fails = 0;
const check = (ok: boolean, msg: string): void => { if (!ok) { fails++; console.error("FAIL " + msg); } else console.log("OK " + msg); };
const vlq = (v: number): number[] => { const o = [v & 127]; while ((v >>= 7)) o.unshift((v & 127) | 128); return o; };
const ev: { t: number; b: number[] }[] = [{ t: 0, b: [0xff, 0x51, 3, 0x07, 0xa1, 0x20] }]; // 120 BPM
const note = (t: number, ch: number, n: number, v: number, dur: number) => { ev.push({ t, b: [0x90 | ch, n, v] }, { t: t + dur, b: [0x80 | ch, n, 0] }); };
for (let bar = 0; bar < 2; bar++) {
  const o = bar * 1920; // 480 ppq, 4/4
  note(o, 9, 36, 110, 20); note(o + 960, 9, 38, 100, 20); note(o + 480, 9, 42, 70, 20); note(o + 1440, 9, 42, 70, 20);
  note(o, 1, 40, 100, 900); note(o + 960, 1, 43, 100, 900);
  note(o, 2, 64, 80, 1800); note(o, 2, 67, 80, 1800);
  for (let i = 0; i < 8; i++) note(o + i * 240, 3, 72 + (i % 3), 90, 100);
}
ev.sort((a, b) => a.t - b.t);
const trk: number[] = [];
let last = 0;
for (const e of ev) { trk.push(...vlq(e.t - last), ...e.b); last = e.t; }
trk.push(0, 0xff, 0x2f, 0);
const u32 = (n: number): number[] => [n >>> 24, (n >> 16) & 255, (n >> 8) & 255, n & 255];
const file = new Uint8Array([0x4d, 0x54, 0x68, 0x64, ...u32(6), 0, 0, 0, 1, 1, 0xe0, 0x4d, 0x54, 0x72, 0x6b, ...u32(trk.length), ...trk]);
const r = importMidi(file);
check(Math.abs(r.song.bpm - 120) < 0.01, `the tempo is read (${r.song.bpm})`);
check(r.song.arrangement.length === 1 && r.song.sections?.[0].repeat === 2, "two identical bars become one section played twice");
const p = r.song.patterns[0];
check(p.steps[0][0]?.notes[0] === 36 && p.steps[0][16]?.notes[0] === 38 && p.steps[0][8]?.notes[0] === 42, "drums land on the 1/32 grid (kick 1, hat on 2, snare on 3)");
check(p.steps[4][0]?.notes[0] === 36, "and the same drums on MIDI track 1");
check(r.song.midi?.[0].channel === 10 && r.song.tracks[0].patch === "DRUM/CR78 KIT", "channel 10 plays the CR78 kit and goes out on channel 10");
check(p.steps[1][0]?.notes[0] === 40 && p.steps[2][0]?.notes.join() === "64,67" && (p.steps[2][0]?.gate ?? 0) > 25, "bass to track 2, the chord with its long gate to track 3");
check(sanitizeSong(JSON.parse(JSON.stringify(r.song))) !== null, "the song survives sanitising");
process.exit(fails ? 1 : 0);
