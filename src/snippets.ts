import { Operator } from "./dsp/operator";
import { patches } from "./dsp/patches";
import { Voice } from "./dsp/voice";

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

/** Add one entry per iteration so earlier results stay audible. */
export const snippets: Snippet[] = [
  { step: "Step 2", title: "Operator: A4 sine (440 Hz)", render: () => sine(440, 1.5) },
  { step: "Step 2", title: "Operator: A2 sine (110 Hz)", render: () => sine(110, 1.5) },
  { step: "Step 3", title: "Algorithm 5 · E-Piano, C4", render: () => note("epiano", 261.63, 1.5, 3) },
  { step: "Step 3", title: "Algorithm 1 · FM Bass, C2", render: () => note("bass", 65.41, 1.0, 1.6) },
  { step: "Step 3", title: "Algorithm 32 · Organ chord, C3 E3 G3", render: () => chord() },
];
