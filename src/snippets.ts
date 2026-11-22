import { Operator } from "./dsp/operator";

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

/** Add one entry per iteration so earlier results stay audible. */
export const snippets: Snippet[] = [
  { step: "Step 2", title: "Operator: A4 sine (440 Hz)", render: () => sine(440, 1.5) },
  { step: "Step 2", title: "Operator: A2 sine (110 Hz)", render: () => sine(110, 1.5) },
];
