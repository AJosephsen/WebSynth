// MIDI-only tracks: the sequencer's notes go out as MIDI on the track's channel, a retrigger ends the old strike, a mute or channel change releases
// what is held, CLOCK OUT sends 24 pulses a quarter note with start and stop.
import { factoryInstrument } from "../src/instruments";
import { createEngine } from "../src/seq/engine";
import { MidiTrackOut } from "../src/seq/miditrack";
import { defaultMidiTracks, defaultSong, emptyPattern, sanitizeSong } from "../src/seq/song";

let fails = 0;
const check = (ok: boolean, msg: string): void => { if (!ok) { fails++; console.error("FAIL " + msg); } else console.log("OK " + msg); };
const hex = (b: number[]): string => b.map((x) => x.toString(16)).join(" ");
// the output tracker
{
  const out: number[][] = [];
  const t = new MidiTrackOut((b) => out.push(b));
  t.settings = { channel: 3, blocked: false };
  t.noteOn(60, 100); t.noteOn(60, 90); t.noteOff(60); t.noteOff(60);
  check(out.map(hex).join("|") === "92 3c 64|82 3c 0|92 3c 5a|82 3c 0", `a retrigger ends the old strike first (${out.map(hex).join("|")})`);
  out.length = 0;
  t.noteOn(64, 100); t.settings = { channel: 5, blocked: false }; t.tick();
  check(out.map(hex).join("|") === "92 40 64|82 40 0", "a channel change releases the held notes on the old channel");
  out.length = 0;
  t.noteOn(67, 100); t.controller(0xb0, 64, 127); t.settings = { channel: 5, blocked: true }; t.tick();
  check(out.map(hex).join("|") === "94 43 64|b4 40 7f|84 43 0|b4 40 0", `a mute releases the notes and the pedal (${out.map(hex).join("|")})`);
  out.length = 0;
  t.noteOn(70, 100);
  check(out.length === 0, "a muted track sends nothing");
}
// the engine
{
  const song = defaultSong();
  song.patterns = [emptyPattern("A", 8)];
  song.arrangement = [0];
  song.bpm = 120;
  song.patterns[0].steps[4][0] = { notes: [60], vel: 100, gate: 0.5 };
  song.patterns[0].steps[4][4] = { notes: [64, 67], vel: 80, gate: 0.5 };
  song.midi = defaultMidiTracks();
  song.midi[0].channel = 3;
  song.clockOut = true;
  const clean = sanitizeSong(JSON.parse(JSON.stringify(song)))!;
  check(clean.midi?.[0].channel === 3 && clean.clockOut === true && !!clean.patterns[0].steps[4][4], "MIDI tracks, CLOCK OUT and their steps survive sanitising");
  const e = createEngine(44100, clean, factoryInstrument, 4);
  const out: number[][] = [];
  e.onMidiOut = (b) => out.push(b);
  e.mode = "pattern";
  e.play();
  const l = new Float32Array(1024), r = new Float32Array(1024);
  for (let i = 0; i < Math.ceil(22050 * 3 / 1024); i++) e.renderStereo(l, r); // 1.5 s: three beats, 8 sixteenths
  e.stop();
  const ons = out.filter((b) => (b[0] & 0xf0) === 0x90).map((b) => `${b[0] & 15}:${b[1]}`);
  check(ons.slice(0, 3).join(",") === "2:60,2:64,2:67", `notes go out on channel 3 (${ons.slice(0, 4).join(",")})`);
  const clocks = out.filter((b) => b[0] === 0xf8).length;
  check(out[0][0] === 0xfa && out[out.length - 1][0] === 0xfc && Math.abs(clocks - 72) <= 2, `start, ${clocks} clock pulses for 3 beats, stop`);
  check(out.filter((b) => (b[0] & 0xf0) === 0x80).length >= 3, "the notes are released");
}
process.exit(fails ? 1 : 0);
