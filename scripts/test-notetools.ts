import { copyTrack, lengthRange, transposeRange, velocityRange } from "../src/seq/notetools";
import { emptyPattern } from "../src/seq/song";

let fails = 0;
const check = (ok: boolean, msg: string): void => { if (!ok) { fails++; console.error("FAIL " + msg); } else console.log("OK " + msg); };
const p = emptyPattern("T", 16);
p.steps[0][0] = { notes: [60, 64], vel: 40 };
p.steps[0][1] = { notes: [125], vel: 120, gate: 2 };
p.steps[0][5] = { notes: [30], vel: 90 };
check(transposeRange(p, 0, 0, 1, 12) === 2 && p.steps[0][0]!.notes.join() === "62,66" && p.steps[0][1]!.notes[0] === 127, "PITCH moves a range together and stops at the MIDI limit");
check(p.steps[0][5]!.notes[0] === 30, "... leaving steps outside the range");
check(velocityRange(p, 0, 0, 1, 30) === 7 && p.steps[0][0]!.vel === 47 && p.steps[0][1]!.vel === 127, "VELOCITY keeps the differences (stops with the loudest at 127)");
check(Math.abs(lengthRange(p, 0, 0, 1, 1) - 1) < 1e-9 && p.steps[0][1]!.gate === 3 && p.steps[0][0]!.gate === 1.9, "LENGTH adds steps to the range's gates");
copyTrack(p, 0, 2);
check(p.steps[2][1]!.notes[0] === 127 && p.steps[2][1] !== p.steps[0][1], "a track copies to another track");
process.exit(fails ? 1 : 0);
