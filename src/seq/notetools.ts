// Range edits on a pattern's track (after Melodee's PITCH / LENGTH / VELOCITY tools): a range of steps is moved in pitch, in length or in velocity
// as a whole, so the differences between its notes stay; and a track's pattern is copied to another track.
import type { Pattern, Step } from "./song";

const clamp = (x: number, lo: number, hi: number): number => Math.min(hi, Math.max(lo, x));
const inRange = (steps: Step[], from: number, to: number): { i: number; s: NonNullable<Step> }[] => {
  const out: { i: number; s: NonNullable<Step> }[] = [];
  for (let i = Math.max(0, from); i <= Math.min(to, steps.length - 1); i++) { const s = steps[i]; if (s) out.push({ i, s }); }
  return out;
};

/** Moves the notes of steps from..to by `semis`; the range stops at the MIDI limits together (its notes keep their intervals). */
export function transposeRange(p: Pattern, track: number, from: number, to: number, semis: number): number {
  const hit = inRange(p.steps[track], from, to);
  if (!hit.length) return 0;
  let lo = 127, hi = 0;
  for (const { s } of hit) for (const n of s.notes) { lo = Math.min(lo, n); hi = Math.max(hi, n); }
  const d = clamp(semis, -lo, 127 - hi);
  for (const { i, s } of hit) p.steps[track][i] = { ...s, notes: s.notes.map((n) => n + d) };
  return d;
}

/** Moves the velocities of steps from..to by `delta`, the range together (1..127). */
export function velocityRange(p: Pattern, track: number, from: number, to: number, delta: number): number {
  const hit = inRange(p.steps[track], from, to);
  if (!hit.length) return 0;
  let lo = 127, hi = 1;
  for (const { s } of hit) { const v = s.vel ?? 100; lo = Math.min(lo, v); hi = Math.max(hi, v); }
  const d = clamp(delta, 1 - lo, 127 - hi);
  for (const { i, s } of hit) p.steps[track][i] = { ...s, vel: (s.vel ?? 100) + d };
  return d;
}

/** Moves the gate lengths of steps from..to by `delta` steps, the range together (0.1..16 steps). */
export function lengthRange(p: Pattern, track: number, from: number, to: number, delta: number): number {
  const hit = inRange(p.steps[track], from, to);
  if (!hit.length) return 0;
  let lo = 16, hi = 0.1;
  for (const { s } of hit) { const g = s.gate ?? 0.9; lo = Math.min(lo, g); hi = Math.max(hi, g); }
  const d = clamp(delta, 0.1 - lo, 16 - hi);
  for (const { i, s } of hit) p.steps[track][i] = { ...s, gate: Math.round(((s.gate ?? 0.9) + d) * 100) / 100 };
  return d;
}

/** Copies a track's steps (and its own length) to another track of the same pattern. */
export function copyTrack(p: Pattern, from: number, to: number): void {
  if (from === to) return;
  p.steps[to] = p.steps[from].map((s) => (s ? { ...s, notes: [...s.notes] } : null));
  if (p.lens) p.lens[to] = p.lens[from];
}
