/** Single FM operator: a sine oscillator with phase-modulation input. */
export class Operator {
  private phase = 0;
  frequency = 440;
  level = 1;

  constructor(private readonly sampleRate: number) {}

  /** @param pm phase modulation in cycles (0..1 = one full period). */
  next(pm = 0): number {
    const out = Math.sin(2 * Math.PI * (this.phase + pm)) * this.level;
    this.phase += this.frequency / this.sampleRate;
    if (this.phase >= 1) this.phase -= 1;
    return out;
  }

  reset(): void {
    this.phase = 0;
  }
}
