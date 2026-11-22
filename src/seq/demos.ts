import { byName } from "../fm6/library";
import { PolySynth } from "../synth/poly";
import { Engine, Step } from "./engine";

const n = (...notes: number[]): Step => ({ notes });
const _ = null;
const C = 0, D = 2, E = 4, F = 5, G = 7, A = 9, B = 11;
const m = (pc: number, oct: number) => 12 * (oct + 1) + pc; // MIDI note

export interface Demo {
  name: string;
  bpm: number;
  swing: number;
  tracks: { patch: string; steps: Step[] }[];
}

export const demos: Demo[] = [
  {
    name: "Pocket groove",
    bpm: 104,
    swing: 0.12,
    tracks: [
      {
        patch: "FM BASS",
        steps: [
          n(m(C, 2)), _, _, n(m(C, 2)), _, _, n(m(G, 1)), _,
          n(m(A, 1)), _, _, n(m(A, 1)), _, n(m(E, 2)), _, n(m(G, 1)),
        ],
      },
      {
        patch: "TINE EP",
        steps: [
          { notes: [m(E, 4), m(G, 4), m(B, 4)], gate: 1.8 }, _, _, _, _, _, _, _,
          { notes: [m(E, 4), m(A, 4), m(C, 5)], gate: 1.8 }, _, _, _, _, _, { notes: [m(D, 4), m(G, 4), m(B, 4)], gate: 0.9 }, _,
        ],
      },
      {
        patch: "MARIMBA",
        steps: [
          _, n(m(G, 5)), _, n(m(E, 5)), _, n(m(C, 5)), _, _,
          _, n(m(A, 5)), _, n(m(E, 5)), _, n(m(C, 5)), n(m(D, 5)), _,
        ],
      },
    ],
  },
  {
    name: "Bells and pad",
    bpm: 84,
    swing: 0,
    tracks: [
      {
        patch: "PAD",
        steps: [
          { notes: [m(A, 3), m(C, 4), m(E, 4)], gate: 7.5 }, _, _, _, _, _, _, _,
          { notes: [m(F, 3), m(A, 3), m(C, 4)], gate: 7.5 }, _, _, _, _, _, _, _,
        ],
      },
      {
        patch: "BELL",
        steps: [
          n(m(E, 5)), _, _, _, n(m(A, 5)), _, _, n(m(C, 6)),
          _, _, n(m(A, 5)), _, _, _, n(m(F, 5)), _,
        ],
      },
    ],
  },
  {
    name: "Organ and pluck",
    bpm: 126,
    swing: 0,
    tracks: [
      {
        patch: "ORGAN",
        steps: [
          { notes: [m(C, 3), m(G, 3), m(E, 4)], gate: 3.6 }, _, _, _, { notes: [m(C, 3), m(G, 3), m(E, 4)], gate: 3.6 }, _, _, _,
          { notes: [m(G, 2), m(D, 3), m(B, 3)], gate: 3.6 }, _, _, _, { notes: [m(G, 2), m(D, 3), m(B, 3)], gate: 3.6 }, _, _, _,
        ],
      },
      {
        patch: "PLUCK",
        steps: [0, 4, 7, 12, 7, 4, 0, 4, -5, -1, 2, 7, 2, -1, -5, -1].map((x) => n(m(C, 4) + x)),
      },
    ],
  },
];

/** Builds an engine that plays a demo (one polyphonic synth per track). */
export function engineForDemo(sampleRate: number, demo: Demo, voices = 6): Engine {
  const e = new Engine(sampleRate, new PolySynth(byName("TINE EP").patch, 8));
  for (const t of demo.tracks) {
    const s = new PolySynth(byName(t.patch).patch, voices);
    s.gain = 0.7;
    e.addTrack(s, t.steps);
  }
  e.bpm = demo.bpm;
  e.swing = demo.swing;
  return e;
}
