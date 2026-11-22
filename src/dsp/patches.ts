import { Patch } from "./voice";

const op = (ratio: number, level: number, env: [number, number, number, number]) => ({ ratio, level, env });
const OFF = op(1, 0, [0.001, 0.1, 0, 0.1]);

export const patches: Record<string, Patch> = {
  // Algorithm 5: three 2-op pairs. Bell-tine electric piano.
  epiano: {
    name: "E-Piano",
    algorithm: 5,
    feedback: 0.1,
    ops: [
      op(1, 0.6, [0.002, 1.8, 0.0, 0.3]), op(1, 0.9, [0.002, 0.5, 0.0, 0.2]),
      op(1, 0.4, [0.002, 2.5, 0.0, 0.3]), op(14, 0.5, [0.001, 0.15, 0.0, 0.1]),
      OFF, OFF,
    ],
  },
  // Algorithm 1: long stack into a sub carrier. Bass.
  bass: {
    name: "FM Bass",
    algorithm: 1,
    feedback: 0.35,
    ops: [
      op(1, 0.8, [0.002, 0.4, 0.5, 0.1]), op(1, 0.6, [0.002, 0.2, 0.2, 0.1]),
      op(0.5, 0.7, [0.002, 0.5, 0.6, 0.1]), op(1, 1.2, [0.002, 0.15, 0.1, 0.1]),
      op(2, 0.8, [0.002, 0.1, 0.1, 0.1]), op(1, 1.0, [0.002, 0.1, 0.0, 0.1]),
    ],
  },
  // Algorithm 32: six carriers, drawbar-style organ.
  organ: {
    name: "Organ",
    algorithm: 32,
    feedback: 0.15,
    ops: [1, 2, 3, 4, 6, 8].map((r, i) => op(r, [0.8, 0.6, 0.4, 0.3, 0.2, 0.15][i], [0.01, 0.05, 1, 0.08])),
  },
};
