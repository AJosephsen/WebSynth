// Step automation and parameter locks, after Felucca's motion.c (GPL-3.0-only). An automation event sets a parameter at its
// step and the value holds (until another event, the loop's restart, a stop); a lock sets it for that step only, when the step
// plays (its chance passed), and the next step puts back what would sound without it. See NOTICE.

/** One record of a track: a parameter value at a step (a lock lasts that step only). */
export interface MotionEvent { step: number; param: number; value: number; lock?: boolean }

/** Where the values go: the synth's parameters. */
export interface ParamStore {
  read(id: number): number;
  /** Sets the sounding value (it overrides what the instrument sets until released). */
  write(id: number, v: number): void;
  /** Puts the sound's own value back. */
  release(id: number, v: number): void;
}

export class Motion {
  events: MotionEvent[] = [];
  private base = new Map<number, number>();
  private active = new Set<number>();
  private locked = new Set<number>();
  private baseValid = false;

  constructor(private readonly store: () => ParamStore | undefined) {}

  private capture(): void {
    const st = this.store();
    this.base.clear();
    if (st) for (const e of this.events) if (!this.base.has(e.param)) this.base.set(e.param, st.read(e.param));
    this.baseValid = true;
  }

  /** The transport starts: the sound's own values are the base. */
  begin(): void {
    this.restore();
    this.capture();
  }

  /** Every changed parameter back to the sound's own value. */
  restore(): void {
    const st = this.store();
    if (st) for (const id of this.active) st.release(id, this.base.get(id) ?? st.read(id));
    this.active.clear();
    this.locked.clear();
  }

  end(): void {
    this.restore();
    this.baseValid = false;
  }

  /** The locks of the step before go back to what sounds without them: the latest automation event up to this step, else the base. */
  private unlock(step: number): void {
    const st = this.store();
    if (!st) return;
    for (const id of this.locked) {
      let best = -1;
      let v = this.base.get(id) ?? st.read(id);
      for (const e of this.events) {
        if (e.param !== id || e.lock || e.step > step || e.step <= best) continue;
        best = e.step;
        v = e.value;
      }
      st.write(id, v);
    }
    this.locked.clear();
  }

  /** Step `step` starts; played: it plays (its chance passed), so its locks apply. */
  step(step: number, played: boolean): void {
    if (!this.events.length) return;
    const st = this.store();
    if (!st) return;
    if (!this.baseValid) this.capture();
    if (!step) this.restore();
    else if (this.locked.size) this.unlock(step);
    for (const e of this.events) {
      if (e.step !== step || (e.lock && !played)) continue;
      st.write(e.param, e.value);
      this.active.add(e.param);
      if (e.lock) this.locked.add(e.param);
    }
  }
}
