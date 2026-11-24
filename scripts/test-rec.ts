// REC: notes played on the live keyboard while the song runs are written into the track's pattern at the nearest step, with their length.
import { factoryInstrument } from "../src/instruments";
import { createEngine } from "../src/seq/engine";
import { defaultSong, emptyPattern } from "../src/seq/song";

let fails = 0;
const check = (ok: boolean, msg: string): void => { if (!ok) { fails++; console.error("FAIL " + msg); } else console.log("OK " + msg); };
const song = defaultSong();
song.patterns = [emptyPattern("A", 16)];
song.arrangement = [0];
song.bpm = 120;
const e = createEngine(44100, song, factoryInstrument, 4);
e.mode = "pattern";
const got: string[] = [];
e.onRecord = (t, p, s, d) => got.push(`${t}:${p}:${s}:${d?.notes.join("+")}`);
e.recTrack = 1;
e.play();
const l = new Float32Array(1024), r = new Float32Array(1024);
const quarter = 22050, step = quarter / 4; // 1/16 notes at 120 BPM
const run = (samples: number): void => { for (let i = 0; i < samples; i += 1024) e.renderStereo(l, r); };
run(step * 4.1);            // into step 4
e.liveInput.noteOn(60, 100);
run(step * 2);
e.liveInput.noteOff(60);
run(step * 0.3);
e.liveInput.noteOn(64, 90); // late in a step: the next one
run(step * 0.4);
e.liveInput.noteOff(64);
const st = song.patterns[0].steps[1];
const notes = [...e.recTrack === 1 ? [0] : []];
void notes;
check(got.length >= 2, `notes are recorded (${got.join(" ")})`);
const eng = (e as unknown as { song: typeof song }).song.patterns[0].steps[1];
const at60 = eng.findIndex((s) => s?.notes.includes(60));
check(at60 >= 3 && at60 <= 5, `C4 lands near step 4 (${at60})`);
check((eng[at60]?.gate ?? 0) > 1, `and keeps its length of about two steps (gate ${eng[at60]?.gate})`);
const at64 = eng.findIndex((s) => s?.notes.includes(64));
check(at64 > at60, `E4 comes after it (step ${at64})`);
void st;
process.exit(fails ? 1 : 0);
