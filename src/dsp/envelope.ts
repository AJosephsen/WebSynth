/** Linear ADSR envelope. Times in seconds, sustain is a level 0..1. */
export class Envelope {
  private stage: "idle" | "attack" | "decay" | "sustain" | "release" = "idle";
  private value = 0;

  constructor(
    private readonly sampleRate: number,
    public attack = 0.003,
    public decay = 0.3,
    public sustain = 0.7,
    public release = 0.15,
  ) {}

  gateOn(): void {
    this.stage = "attack";
  }

  gateOff(): void {
    if (this.stage !== "idle") this.stage = "release";
  }

  get active(): boolean {
    return this.stage !== "idle";
  }

  next(): number {
    const sr = this.sampleRate;
    switch (this.stage) {
      case "attack":
        this.value += 1 / Math.max(1, this.attack * sr);
        if (this.value >= 1) { this.value = 1; this.stage = "decay"; }
        break;
      case "decay":
        this.value -= (1 - this.sustain) / Math.max(1, this.decay * sr);
        if (this.value <= this.sustain) { this.value = this.sustain; this.stage = "sustain"; }
        break;
      case "release":
        this.value -= 1 / Math.max(1, this.release * sr);
        if (this.value <= 0) { this.value = 0; this.stage = "idle"; }
        break;
    }
    return this.value;
  }
}
