// The song layer of Melodee: 64 sections, LOOP SONG off stops at the end, a section's own sound per track, the time ruler, sanitising.
import { factoryInstrument } from "../src/instruments";
import { createEngine } from "../src/seq/engine";
import { MAX_ARRANGEMENT, defaultSong, emptyPattern, sanitizeSong, sectionSeconds } from "../src/seq/song";

let fails = 0;
const check = (ok: boolean, msg: string): void => { if (!ok) { fails++; console.error("FAIL " + msg); } else console.log("OK " + msg); };
const song = defaultSong();
song.patterns = [emptyPattern("A", 8), emptyPattern("B", 8)];
song.patterns[0].steps[0][0] = { notes: [48] };
song.arrangement = [0, 1];
song.sections = [{}, { sounds: ["BELL", null, null, null] }];
song.loop = false;
check(MAX_ARRANGEMENT === 64, "64 sections");
const clean = sanitizeSong(JSON.parse(JSON.stringify(song)))!;
check(clean.loop === false && clean.sections?.[1].sounds?.[0] === "BELL" && !clean.sections?.[0].sounds, "loop and section sounds survive sanitising");
const secs = sectionSeconds(clean, (d) => 60 / clean.bpm / [1, 2, 4, 8, 3, 6][d]);
check(Math.abs(secs[0] - 8 * 60 / clean.bpm / 4) < 1e-9, `a section's seconds (${secs[0].toFixed(3)})`);
const e = createEngine(44100, clean, factoryInstrument, 4);
e.sectionInstruments = { BELL: factoryInstrument("BELL") };
const first = e.tracks[0].synth;
let ended = false;
e.onSongEnd = () => { ended = true; };
e.mode = "song";
e.play();
const l = new Float32Array(1024), r = new Float32Array(1024);
const seconds = secs[0] + secs[1];
let sawBell = false;
for (let i = 0; i < Math.ceil((seconds + 1) * 44100 / 1024) && !ended; i++) {
  e.renderStereo(l, r);
  if (e.arrPos === 1 && e.tracks[0].synth !== first) sawBell = true;
}
check(sawBell, "section 2 plays its own sound on track 1");
check(ended && !e.playing, "LOOP SONG off: the song stops after the last section");
process.exit(fails ? 1 : 0);
