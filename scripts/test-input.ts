// The note input: QNT layouts, the key map in front of chord keys, STRUM sweeps, AUTO harmony from the other parts' notes, microtonal pitch.
import { NoteInput, defaultInput } from "../src/synth/noteinput";
import { Harmony, newHarmonyTrack } from "../src/synth/harmony";
import { scalePitch } from "../src/synth/keymap";

let fails = 0;
const check = (ok: boolean, msg: string): void => { if (!ok) { fails++; console.error("FAIL " + msg); } else console.log("OK " + msg); };
const recorder = () => {
  const events: string[] = [];
  const syn = { gain: 1, activeVoices: 0, noteOn: (n: number) => events.push(`+${n}`), noteOff: (n: number) => events.push(`-${n}`), allOff: () => events.push("off"), render: () => undefined };
  return { events, syn };
};
// SNAP rounds a key down to the scale (C major: C# -> C, D# -> D)
{
  const { events, syn } = recorder();
  const input = new NoteInput(() => syn);
  const st = defaultInput();
  st.chord.quant = 1;
  input.set(st);
  input.noteOn(61); input.noteOn(63); input.noteOn(64);
  check(events.join(" ") === "+60 +62 +64", `QNT SNAP rounds keys down to the scale (${events.join(" ")})`);
}
// WHITE walks the scale on the white keys, black keys are silent; TRN moves it
{
  const { events, syn } = recorder();
  const input = new NoteInput(() => syn);
  const st = defaultInput();
  st.chord.quant = 2; st.chord.scale = 5; // pentatonic
  input.set(st);
  input.noteOn(60); input.noteOn(61); input.noteOn(62); input.noteOn(64); input.noteOn(65);
  check(events.join(" ") === "+60 +62 +64 +67", `QNT WHITE walks the pentatonic scale; black keys are silent (${events.join(" ")})`);
}
// STRUM: the chord's tones follow one another over the sweep, a release cancels the rest
{
  const { events, syn } = recorder();
  const input = new NoteInput(() => syn);
  const st = defaultInput();
  st.chord.chrd = 3; st.chord.strum = 2; // MAJ, a 1/16 sweep
  input.set(st);
  input.noteOn(60, 100);
  check(events.join(" ") === "+60", `STRUM starts the first tone alone (${events.join(" ")})`);
  const quarter = 22050;
  input.tick(quarter / 8, quarter);
  check(events.join(" ") === "+60 +64", `... the next after half the sweep (${events.join(" ")})`);
  input.tick(quarter / 8 + 10, quarter);
  check(events.join(" ") === "+60 +64 +67", `... and the last at the end (${events.join(" ")})`);
  input.noteOff(60);
  check(events.slice(3).join(" ") === "-60 -64 -67", `a release ends the started tones (${events.slice(3).join(" ")})`);
  const b = recorder();
  const i2 = new NoteInput(() => b.syn);
  i2.set(st);
  i2.noteOn(60, 100); i2.noteOff(60); i2.tick(quarter, quarter);
  check(b.events.join(" ") === "+60 -60", `a release before the sweep ends cancels the unplayed tones (${b.events.join(" ")})`);
}
// AUTO: the chord follows what another part holds
{
  const a = recorder();
  const h = new Harmony([newHarmonyTrack(), newHarmonyTrack()], { solo: () => 0, beatSamples: () => 22050 });
  const input = new NoteInput(() => a.syn, { harmony: h, index: 0 });
  const st = defaultInput();
  st.chord.chrd = 10; // AUTO in C major
  input.set(st);
  // the other part holds A: the chord on C should contain it (Am7-ish or C6 shapes) more than the plain triad
  h.tracks[1].held[69 >> 5] = 1 << (69 & 31);
  h.tick(10);
  input.noteOn(60, 100);
  const sounded = a.events.filter((e) => e[0] === "+").map((e) => Number(e.slice(1)) % 12);
  check(sounded.includes(9), `AUTO includes the note another part holds (${a.events.join(" ")})`);
}
// microtonal pitch: 19EDO's degree 1 is 1/19 octave above the root, in 1/16 semitone and the fine part below it
{
  const km = { scale: 26, root: 0, quant: 1, trans: 0, mpcdeg: 1, octave: 0 };
  const p = scalePitch(km, 61);
  const cents = ((p.pitch16 + p.fine / 2367 * 16) / 16) * 100 - 6000;
  check(Math.abs(cents - 1200 / 19) < 1, `19EDO degree 1 is ${cents.toFixed(1)} cents above the root (1200/19 = ${(1200 / 19).toFixed(1)})`);
}
process.exit(fails ? 1 : 0);
