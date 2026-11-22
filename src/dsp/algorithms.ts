/**
 * FM algorithms, numbered as on the DX7. Operators are 0-based (op1 = index 0).
 * `mods[i]` lists the operators that phase-modulate operator i.
 * Operators are computed from highest index to lowest, so a modulator
 * always has a higher index than the operator it feeds.
 */
export interface Algorithm {
  id: number;
  carriers: number[];
  mods: number[][];
  feedback: number; // operator with self-feedback
}

const alg = (id: number, carriers: number[], links: [number, number][], feedback = 5): Algorithm => {
  const mods: number[][] = [[], [], [], [], [], []];
  for (const [src, dst] of links) mods[dst].push(src);
  return { id, carriers, mods, feedback };
};

export const algorithms: Record<number, Algorithm> = {
  // 2->1 and 6->5->4->3 : two stacks
  1: alg(1, [0, 2], [[1, 0], [5, 4], [4, 3], [3, 2]]),
  // three 2-op pairs
  5: alg(5, [0, 2, 4], [[1, 0], [3, 2], [5, 4]]),
  // six carriers, additive (organ)
  32: alg(32, [0, 1, 2, 3, 4, 5], []),
};
