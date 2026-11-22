import { Operator } from "./dsp/operator";
import { patches } from "./dsp/patches";
import { Voice } from "./dsp/voice";
import { render as fm6Render, Op } from "./fm6/core";
import { freq as fm6Freq } from "./fm6/math";
import { CTL } from "./fm6/tables";

export const SAMPLE_RATE = 44100;

export interface Snippet {
  step: string;
  title: string;
  render: () => Float32Array;
}

function fade(out: Float32Array): Float32Array {
  const n = Math.floor(SAMPLE_RATE * 0.01);
  for (let i = 0; i < n; i++) {
    out[i] *= i / n;
    out[out.length - 1 - i] *= i / n;
  }
  return out;
}

function sine(freq: number, seconds: number): Float32Array {
  const op = new Operator(SAMPLE_RATE);
  op.frequency = freq;
  const out = new Float32Array(Math.floor(SAMPLE_RATE * seconds));
  for (let i = 0; i < out.length; i++) out[i] = op.next() * 0.5;
  return fade(out);
}

/** Render one held note through a patch. */
function note(patch: string, freq: number, hold: number, total: number): Float32Array {
  const v = new Voice(SAMPLE_RATE, patches[patch]);
  const out = new Float32Array(Math.floor(SAMPLE_RATE * total));
  v.noteOn(freq);
  for (let i = 0; i < out.length; i++) {
    if (i === Math.floor(SAMPLE_RATE * hold)) v.noteOff();
    out[i] = v.next() * 0.5;
  }
  return fade(out);
}

function chord(): Float32Array {
  const parts = [130.81, 164.81, 196].map((f) => note("organ", f, 1.5, 2));
  return parts[0].map((_, i) => (parts[0][i] + parts[1][i] + parts[2][i]) / 3);
}

interface Fm6Op {
  ratio: number;
  level: number; // log2 gain offset: 0 = gain 1 (a modulator index of one cycle), -1 = half
  decay?: number; // log2 gain lost per second
}

/** One note through the ported msfa core. `ops` is operator 1..6; algorithm is the DX7 number (1..32). */
function fm6Note(algorithm: number, ops: Fm6Op[], hz: number, seconds: number, feedbackShift = 16): Float32Array {
  const logHz = Math.round(Math.log2(hz) * 2 ** 24);
  // the core wants the sixth operator first
  const spec = [...ops].reverse();
  const state: Op[] = spec.map((o) => ({
    levelIn: 0,
    gainOut: 0,
    phase: 0,
    freq: fm6Freq(logHz + Math.round(Math.log2(o.ratio) * 2 ** 24)),
  }));
  const fb = new Int32Array(2);
  const buf = new Int32Array(CTL);
  const out = new Float32Array(Math.floor((SAMPLE_RATE * seconds) / CTL) * CTL);
  for (let b = 0; b * CTL < out.length; b++) {
    const t = (b * CTL) / SAMPLE_RATE;
    spec.forEach((o, k) => {
      const lv = o.level - (o.decay ?? 0) * t;
      state[k].levelIn = (14 << 24) + Math.round(lv * 2 ** 24);
    });
    buf.fill(0);
    fm6Render(buf, state, algorithm - 1, fb, feedbackShift);
    for (let i = 0; i < CTL; i++) out[b * CTL + i] = (buf[i] / 2 ** 24) * 0.4;
  }
  return fade(out);
}

/** Add one entry per iteration so earlier results stay audible. */
export const snippets: Snippet[] = [
  { step: "Step 2", title: "Operator: A4 sine (440 Hz)", render: () => sine(440, 1.5) },
  { step: "Step 2", title: "Operator: A2 sine (110 Hz)", render: () => sine(110, 1.5) },
  { step: "Step 3a", title: "Algorithm 5 · E-Piano, C4", render: () => note("epiano", 261.63, 1.5, 3) },
  { step: "Step 3a", title: "Algorithm 1 · FM Bass, C2", render: () => note("bass", 65.41, 1.0, 1.6) },
  { step: "Step 3a", title: "Algorithm 32 · Organ chord, C3 E3 G3", render: () => chord() },
  {
    step: "Step 3b",
    title: "msfa port · Algorithm 5, bell pair 1:14, C4",
    render: () => fm6Note(5, [
      { ratio: 1, level: -1, decay: 1.2 }, { ratio: 1, level: 0.2, decay: 1.5 },
      { ratio: 1, level: -2, decay: 2 }, { ratio: 14, level: -1, decay: 5 },
      { ratio: 1, level: -9 }, { ratio: 1, level: -9 },
    ], 261.63, 3),
  },
  {
    step: "Step 3b",
    title: "msfa port · Algorithm 1 stack with feedback, C2",
    render: () => fm6Note(1, [
      { ratio: 1, level: -0.5, decay: 0.6 }, { ratio: 1, level: -1, decay: 1.5 },
      { ratio: 0.5, level: -1, decay: 0.6 }, { ratio: 1, level: 0, decay: 2 },
      { ratio: 2, level: -1, decay: 2 }, { ratio: 1, level: -1.5, decay: 1 },
    ], 65.41, 2, 3),
  },
  {
    step: "Step 3b",
    title: "msfa port · Algorithm 32 additive, C3",
    render: () => fm6Note(32, [1, 2, 3, 4, 6, 8].map((r, i) => ({ ratio: r, level: -1 - i * 0.6, decay: 0.3 })), 130.81, 2.5, 4),
  },
];
