import { ALG } from "../fm6/algorithms";

export interface AlgoGraph {
  carriers: number[]; // operator numbers 1..6
  edges: [from: number, to: number][]; // modulator -> modulated, operator numbers
  feedback: number; // operator number with self-feedback
  level: Record<number, number>; // 0 = carrier row, higher = further up the stack
}

/** Decodes an algorithm (1..32) of the FM6 table into a graph of operators 1..6. */
export function algoGraph(algorithm: number): AlgoGraph {
  const row = ALG[(algorithm - 1) & 31];
  const bus: number[][] = [[], [], []];
  const edges: [number, number][] = [];
  const carriers: number[] = [];
  let feedback = 0;
  for (let k = 0; k < 6; k++) {
    const op = 6 - k; // the table lists the sixth operator first
    const f = row[k];
    const inb = (f >> 4) & 3;
    const outb = f & 3;
    if (inb) for (const src of bus[inb]) edges.push([src, op]);
    if ((f & 0xc0) === 0xc0) feedback = op;
    if (outb === 0) carriers.push(op);
    else bus[outb] = f & 4 ? [...bus[outb], op] : [op];
  }
  const level: Record<number, number> = {};
  for (const c of carriers) level[c] = 0;
  for (let pass = 0; pass < 6; pass++)
    for (const [from, to] of edges) if (level[to] !== undefined) level[from] = Math.max(level[from] ?? 0, level[to] + 1);
  for (let op = 1; op <= 6; op++) level[op] ??= 0;
  return { carriers: carriers.sort(), edges, feedback, level };
}

/** SVG markup of the operator diagram. */
export function algoSvg(algorithm: number, selected: number): string {
  const g = algoGraph(algorithm);
  const rows = Math.max(...Object.values(g.level)) + 1;
  const W = 260, H = 28 + rows * 44;
  const pos: Record<number, [number, number]> = {};
  for (let r = 0; r < rows; r++) {
    const ops = [1, 2, 3, 4, 5, 6].filter((o) => g.level[o] === r);
    ops.forEach((o, i) => (pos[o] = [(W * (i + 1)) / (ops.length + 1), H - 24 - r * 44]));
  }
  let s = `<svg viewBox="0 0 ${W} ${H}" class="algo" role="img" aria-label="Algorithm ${algorithm}">`;
  for (const [a, b] of g.edges) s += `<line x1="${pos[a][0]}" y1="${pos[a][1] + 10}" x2="${pos[b][0]}" y2="${pos[b][1] - 10}" stroke="currentColor" stroke-width="1.5"/>`;
  if (g.feedback) {
    const [x, y] = pos[g.feedback];
    s += `<path d="M ${x + 11} ${y - 4} q 14 -4 14 -14 q 0 -10 -14 -6" fill="none" stroke="currentColor" stroke-width="1.5"/>`;
  }
  for (let o = 1; o <= 6; o++) {
    const [x, y] = pos[o];
    const car = g.carriers.includes(o);
    s += `<g data-op="${o}" class="node${o === selected ? " sel" : ""}${car ? " car" : ""}"><circle cx="${x}" cy="${y}" r="12"/><text x="${x}" y="${y + 4}" text-anchor="middle">${o}</text></g>`;
  }
  return s + "</svg>";
}

/** Points of a DX7-style EG: rates 0..99 set segment length, levels 0..99 set height. */
export function envPoints(r: number[], l: number[], w: number, h: number): string {
  const seg = (rate: number) => 8 + ((99 - rate) / 99) * (w / 4 - 8);
  const y = (lv: number) => h - 2 - (lv / 99) * (h - 4);
  let x = 0;
  const pts = [[0, y(l[3])]];
  for (let i = 0; i < 3; i++) { x += seg(r[i]); pts.push([x, y(l[i])]); }
  x += w / 6; pts.push([x, y(l[2])]); // sustain hold
  x += seg(r[3]); pts.push([x, y(l[3])]);
  const k = w / Math.max(x, w);
  return pts.map(([px, py]) => `${(px * k).toFixed(1)},${py.toFixed(1)}`).join(" ");
}
