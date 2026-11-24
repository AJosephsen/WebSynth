// A small toolkit for rendering songs offline with the WebSynth engine (not part of the app): note notation, a song builder, a WAV writer.
import { writeFileSync } from "node:fs";
import { factoryInstrument } from "../../src/instruments";
import { createEngine } from "../../src/seq/engine";
import { defaultMix, defaultSongFx, emptyPattern, MixSetup, Pattern, Song, SongFx, Step, TrackSetup } from "../../src/seq/song";
import { Instrument } from "../../src/synth/synth";
import { ModSetup, defaultMod } from "../../src/mod/setup";

const PC: Record<string, number> = { c: 0, d: 2, e: 4, f: 5, g: 7, a: 9, b: 11 };
const DRUM: Record<string, number> = { k: 36, r: 37, s: 38, c: 39, h: 42, t: 45, o: 46, b: 56 };
export function midi(tok: string): number {
  if (tok in DRUM) return DRUM[tok];
  const m = /^([a-g])(#|b|)(-?\d)$/.exec(tok);
  if (!m) throw new Error(`bad note ${tok}`);
  return 12 * (Number(m[3]) + 1) + PC[m[1]] + (m[2] === "#" ? 1 : m[2] === "b" ? -1 : 0);
}

/**
 * Events to steps. Each event is "note:steps/velocity" ("e5:2/90"), notes joined with "+" for a chord, "r:4" a rest. A drum token
 * without ":" lasts one step. Returns one Step per grid step.
 */
export function line(...events: (string | string[])[]): Step[] {
  const out: Step[] = [];
  for (const e of events.flat()) {
    const m = /^([^:/]+)(?::(\d+(?:\.\d+)?))?(?:\/(\d+))?$/.exec(e.trim());
    if (!m) throw new Error(`bad event ${e}`);
    const dur = m[2] ? Number(m[2]) : 1;
    if (m[1] === "r" || m[1] === ".") { for (let i = 0; i < dur; i++) out.push(null); continue; }
    out.push({ notes: m[1].split("+").map(midi), vel: m[3] ? Number(m[3]) : undefined, gate: dur > 1 ? dur * 0.95 : 0.8 });
    for (let i = 1; i < dur; i++) out.push(null);
  }
  return out;
}

export const repeat = <T,>(x: T[], n: number): T[] => Array.from({ length: n }, () => x).flat();
export const pad = (x: Step[], n: number): Step[] => (x.length >= n ? x.slice(0, n) : [...x, ...Array<Step>(n - x.length).fill(null)]);

export interface TrackDef {
  patch: string;
  mix?: Partial<MixSetup>;
  mod?: Partial<ModSetup>;
  /** the track's step division (0 1/4, 1 1/8, 2 1/16, 3 1/32, 4 8T, 5 16T), swing, gate */
  seq?: { div?: number; swing?: number; gate?: number };
  /** the track's full line, cut into patterns of `len` steps */
  steps: Step[];
}

/** Builds a song whose tracks each hold one long line; it is cut into patterns of `len` steps played in order. */
export function build(bpm: number, swing: number, len: number, tracks: TrackDef[], fx: Partial<SongFx> = {}): Song {
  const total = Math.max(...tracks.map((t) => t.steps.length));
  const n = Math.ceil(total / len);
  const patterns: Pattern[] = Array.from({ length: n }, (_, k) => {
    const p = emptyPattern(`P${k + 1}`, len);
    tracks.slice(0, 4).forEach((t, i) => {
      const slice = t.steps.slice(k * len, (k + 1) * len);
      slice.forEach((s, j) => (p.steps[i][j] = s));
    });
    return p;
  });
  const setups: TrackSetup[] = Array.from({ length: 4 }, (_, i): TrackSetup => {
    const t = tracks[i];
    if (!t) return { patch: "INIT", mute: true, ...defaultMix() };
    return {
      patch: t.patch, mute: false, ...defaultMix(), ...t.mix,
      mod: t.mod ? { ...defaultMod(), ...t.mod } : undefined,
      seq: t.seq,
    };
  });
  return { bpm, swing, tracks: setups, fx: { ...defaultSongFx(), ...fx }, patterns, arrangement: patterns.map((_, i) => i) };
}

export interface Stereo { l: Float32Array; r: Float32Array }

/** Renders the song once through (plus a tail) to raw stereo floats. */
export function renderBuf(song: Song, tail = 4, instrumentFor: (id: string) => Instrument = factoryInstrument, sampleRate = 44100): Stereo {
  const e = createEngine(sampleRate, song, instrumentFor, 8);
  e.mode = "song";
  const quarter = (sampleRate * 60) / song.bpm;
  const clock = Math.max(0, song.tracks.findIndex((t) => !t.mute));
  const den = [1, 2, 4, 8, 3, 6][song.tracks[clock].seq?.div ?? 2] ?? 4;
  let frames = 0;
  for (const pi of song.arrangement) {
    const pat = song.patterns[pi];
    frames += (pat.lens?.[clock] ?? pat.length) * (quarter / den);
  }
  const total = Math.ceil(frames + tail * sampleRate);
  const l = new Float32Array(total), r = new Float32Array(total);
  e.play();
  const bl = new Float32Array(1024), br = new Float32Array(1024);
  let stopped = false;
  for (let i = 0; i < total; i += 1024) {
    if (!stopped && i >= frames) { e.stop(); stopped = true; }
    e.renderStereo(bl, br);
    const n = Math.min(1024, total - i);
    l.set(bl.subarray(0, n), i);
    r.set(br.subarray(0, n), i);
  }
  return { l, r };
}

/** Sums stems (each with a gain). */
export function mix(stems: { buf: Stereo; gain: number }[]): Stereo {
  const total = Math.max(...stems.map((s) => s.buf.l.length));
  const l = new Float32Array(total), r = new Float32Array(total);
  for (const { buf, gain } of stems) for (let i = 0; i < buf.l.length; i++) { l[i] += buf.l[i] * gain; r[i] += buf.r[i] * gain; }
  return { l, r };
}

/** Peak-normalises to -1 dBFS and writes a stereo 16-bit WAV. Returns the seconds. */
export function writeWav(path: string, { l, r }: Stereo, sampleRate = 44100): number {
  const total = l.length;
  let peak = 0;
  for (let i = 0; i < total; i++) peak = Math.max(peak, Math.abs(l[i]), Math.abs(r[i]));
  const g = peak > 0 ? 0.89 / peak : 1;
  const buf = Buffer.alloc(44 + total * 4);
  buf.write("RIFF", 0); buf.writeUInt32LE(36 + total * 4, 4); buf.write("WAVEfmt ", 8);
  buf.writeUInt32LE(16, 16); buf.writeUInt16LE(1, 20); buf.writeUInt16LE(2, 22); buf.writeUInt32LE(sampleRate, 24);
  buf.writeUInt32LE(sampleRate * 4, 28); buf.writeUInt16LE(4, 32); buf.writeUInt16LE(16, 34); buf.write("data", 36); buf.writeUInt32LE(total * 4, 40);
  for (let i = 0; i < total; i++) {
    buf.writeInt16LE(Math.max(-32768, Math.min(32767, Math.round(l[i] * g * 32767))), 44 + i * 4);
    buf.writeInt16LE(Math.max(-32768, Math.min(32767, Math.round(r[i] * g * 32767))), 46 + i * 4);
  }
  writeFileSync(path, buf);
  return total / sampleRate;
}

export function render(path: string, song: Song, tail = 4, instrumentFor: (id: string) => Instrument = factoryInstrument, sampleRate = 44100): number {
  return writeWav(path, renderBuf(song, tail, instrumentFor, sampleRate), sampleRate);
}
