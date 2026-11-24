// Standard MIDI File import: a file becomes a song. The drums (channel 10) go to the CR78 kit on track 1 and, as the MIDI track 1, out on channel 10;
// the bass, a chord / pad channel and the busiest remaining channel go to tracks 2-4; the other channels wait on the MIDI tracks 2-4 (muted) on their own
// channels. Notes are placed on a 1/32 grid (a bar of 4/4 is 32 steps = one pattern); identical bars share a pattern and repeat as one section.
import { ALL_TRACKS, MIDI_TRACKS, MidiTrackSetup, Song, Step, TRACKS, defaultMix, defaultSongFx, emptyPattern, MAX_ARRANGEMENT, MAX_PATTERNS, MAX_STEPS } from "./song";

interface Note { start: number; dur: number; note: number; vel: number }

export interface MidiImport { song: Song; info: string }

export function importMidi(bytes: Uint8Array): MidiImport {
  const d = bytes;
  const u16 = (p: number) => (d[p] << 8) | d[p + 1], u32 = (p: number) => ((d[p] << 24) | (d[p + 1] << 16) | (d[p + 2] << 8) | d[p + 3]) >>> 0;
  if (String.fromCharCode(...d.slice(0, 4)) !== "MThd") throw new Error("not a MIDI file");
  const ntracks = u16(10), division = u16(12);
  if (division & 0x8000) throw new Error("SMPTE time is not supported");
  const ppq = division;
  let p = 14, tempo = 500000, tsNum = 4, tsDen = 4, haveTempo = false;
  const byCh: Note[][] = Array.from({ length: 16 }, () => []);
  for (let t = 0; t < ntracks && p + 8 <= d.length; t++) {
    if (String.fromCharCode(...d.slice(p, p + 4)) !== "MTrk") break;
    const end = Math.min(d.length, p + 8 + u32(p + 4));
    p += 8;
    let tick = 0, run = 0;
    const on = new Map<number, { start: number; vel: number }>();
    const vlq = (): number => { let v = 0; for (;;) { const b = d[p++]; v = (v << 7) | (b & 127); if (!(b & 128)) return v; } };
    while (p < end) {
      tick += vlq();
      let b = d[p];
      if (b === 0xff) {
        const ty = d[p + 1]; p += 2; const l = vlq();
        if (ty === 0x51 && !haveTempo) { tempo = (d[p] << 16) | (d[p + 1] << 8) | d[p + 2]; haveTempo = true; }
        if (ty === 0x58 && tick === 0) { tsNum = d[p]; tsDen = 1 << d[p + 1]; }
        p += l; continue;
      }
      if (b === 0xf0 || b === 0xf7) { p++; p += vlq(); continue; }
      if (b & 128) { run = b; p++; } else b = run;
      const st = run & 0xf0, ch = run & 15;
      let a = 0, c = 0;
      if (st === 0x80 || st === 0x90 || st === 0xa0 || st === 0xb0 || st === 0xe0) { a = d[p]; c = d[p + 1]; p += 2; }
      else { a = d[p]; p += 1; }
      const key = ch * 128 + a;
      if (st === 0x90 && c > 0) { on.set(key, { start: tick, vel: c }); }
      else if (st === 0x80 || (st === 0x90 && c === 0)) {
        const o = on.get(key);
        if (o) { on.delete(key); byCh[ch].push({ start: o.start, dur: tick - o.start, note: a, vel: o.vel }); }
      }
    }
    p = end;
  }
  const bpm = Math.min(240, Math.max(40, 6e7 / tempo));
  const stepTicks = ppq / 8; // 1/32
  const barSteps = Math.round((32 * tsNum) / tsDen) || 32;
  const barLen = Math.min(MAX_STEPS, barSteps);
  const used = byCh.map((n, i) => ({ ch: i, n })).filter((x) => x.n.length > 0);
  const drum = used.find((x) => x.ch === 9);
  const median = (xs: number[]): number => xs.slice().sort((a, b) => a - b)[Math.floor(xs.length / 2)];
  const melodic = used.filter((x) => x.ch !== 9 && x.n.length >= 2);
  const bass = [...melodic].sort((a, b) => median(a.n.map((n) => n.note)) - median(b.n.map((n) => n.note)))[0];
  const rest = melodic.filter((x) => x !== bass);
  const sum = (x: { n: Note[] }): number => x.n.reduce((a, n) => a + n.dur, 0);
  const pad = [...rest].sort((a, b) => sum(b) - sum(a))[0];
  const lead = [...rest.filter((x) => x !== pad)].sort((a, b) => b.n.length - a.n.length)[0];
  const audio = [drum, bass, pad, lead];
  const left = rest.filter((x) => x !== pad && x !== lead).sort((a, b) => b.n.length - a.n.length).slice(0, MIDI_TRACKS - 1);
  const rows: ({ ch: number; n: Note[] } | undefined)[] = [...audio, drum, ...left, undefined, undefined, undefined].slice(0, ALL_TRACKS);

  let endTick = 0;
  for (const x of used) for (const n of x.n) endTick = Math.max(endTick, n.start + n.dur);
  const bars = Math.max(1, Math.ceil(endTick / (stepTicks * barSteps)));
  // one pattern per bar, rows in the song's order
  const perBar: string[] = [], uniq: string[] = [], pats = [] as ReturnType<typeof emptyPattern>[];
  const order: number[] = [];
  const grid: Step[][][] = Array.from({ length: bars }, () => Array.from({ length: ALL_TRACKS }, () => Array<Step>(MAX_STEPS).fill(null)));
  rows.forEach((r, ri) => {
    if (!r) return;
    for (const n of r.n) {
      const abs = Math.round(n.start / stepTicks), bar = Math.floor(abs / barSteps), s = abs % barSteps;
      if (bar >= bars || s >= MAX_STEPS) continue;
      const len = Math.max(0.5, Math.min(63, (n.dur / stepTicks) * 0.95));
      const cur = grid[bar][ri][s];
      grid[bar][ri][s] = cur
        ? { ...cur, notes: [...new Set([...cur.notes, n.note])].slice(0, 8), vel: Math.max(cur.vel ?? 0, n.vel), gate: Math.max(cur.gate ?? 0, len) }
        : { notes: [n.note], vel: n.vel, gate: r.ch === 9 ? 0.5 : len };
    }
  });
  for (let b = 0; b < bars; b++) {
    const key = JSON.stringify(grid[b]);
    let idx = perBar.indexOf(key) >= 0 ? uniq.indexOf(key) : -1;
    if (idx < 0) {
      if (uniq.length >= MAX_PATTERNS) idx = uniq.length - 1;
      else { idx = uniq.length; uniq.push(key); const pt = emptyPattern(`Bar ${b + 1}`, barLen); grid[b].forEach((row, ri) => row.forEach((st, j) => { pt.steps[ri][j] = st; })); pats.push(pt); }
    }
    perBar.push(key); order.push(idx);
  }
  // consecutive equal bars become one section with repeats
  const arrangement: number[] = [], repeats: number[] = [];
  for (const i of order) {
    if (arrangement.length && arrangement[arrangement.length - 1] === i && repeats[repeats.length - 1] < 16) repeats[repeats.length - 1]++;
    else { arrangement.push(i); repeats.push(1); }
  }
  const arr = arrangement.slice(0, MAX_ARRANGEMENT);
  const patch = ["DRUM/CR78 KIT", "ANALOG/SUB BASS", "ANALOG/PWM STR", "TINE EP"];
  const seq = { div: 3, swing: 0, gate: 115, quantize: 1 };
  const tracks = Array.from({ length: TRACKS }, (_, i) => ({ patch: patch[i], mute: !audio[i], ...defaultMix(), ...(i === 0 ? { level: 112, reverb: 25 } : i === 2 ? { level: 92, chorus: 40, reverb: 50 } : i === 3 ? { level: 100, delay: 60, reverb: 40 } : {}), seq }));
  const midi: MidiTrackSetup[] = Array.from({ length: MIDI_TRACKS }, (_, k) => {
    const r = rows[TRACKS + k];
    return { channel: r ? r.ch + 1 : k + 1, mute: k > 0 || !r, seq };
  });
  const song: Song = {
    bpm, swing: 0, tracks, fx: { ...defaultSongFx(), dtime: 10, dfdbk: 55, dmix: 80 }, patterns: pats, arrangement: arr,
    sections: arr.map((_, i) => (repeats[i] > 1 ? { repeat: repeats[i] } : {})), midi, loop: false,
  };
  const names = (r?: { ch: number }) => (r ? `ch ${r.ch + 1}` : "-");
  return { song, info: `${bars} bars at ${bpm.toFixed(0)} BPM, ${pats.length} patterns in ${arr.length} sections; drums ${names(drum)}, bass ${names(bass)}, pad ${names(pad)}, lead ${names(lead)}` };
}
