// Checks the user sample pipeline (WAV read, mono mix, resample, normalise, IMA ADPCM, key split) against output of Felucca's
// tools/sampleio.py on three WAV files (tests/user-wavs, tests/user-gold.json), then plays them through SAMPLE, GRAIN and SLICE.
import { createHash } from "node:crypto";
import { readFileSync, readdirSync } from "node:fs";
import { CTL, EngVoice, P_E0, Track, Vmod } from "../src/engines/types";
import { buildUserSlot, noteFromName, readAnyWav, resample, SampleFile, toInt16 } from "../src/sampler/user";
import { loadUserSlot, SMP_NSETS, usrNz } from "../src/sampler/base";
import { ENG_SAMPLE } from "../src/sampler/sample";
import { ENG_GRAIN } from "../src/sampler/grain";
import { ENG_SLICE } from "../src/sampler/slice";

let fails = 0;
const check = (ok: boolean, msg: string): void => { if (!ok) { fails++; console.error("FAIL " + msg); } };
const gold = JSON.parse(readFileSync("tests/user-gold.json", "utf8"));
const files: SampleFile[] = [];
for (const name of readdirSync("tests/user-wavs").filter((n) => n.endsWith(".wav")).sort()) {
  const b = readFileSync(`tests/user-wavs/${name}`);
  const [sr, x] = readAnyWav(b.buffer.slice(b.byteOffset, b.byteOffset + b.byteLength));
  const s = toInt16(resample(x, sr, 22050));
  const g = gold[name];
  const sum = s.reduce((a, v) => a + v, 0);
  check(sr === g.rate && s.length === g.n && sum === g.sum && s.slice(0, 8).join() === g.first.join(), `${name}: resampled samples match (n ${s.length}/${g.n}, sum ${sum}/${g.sum})`);
  check(noteFromName(name) === g.root, `${name}: root note from the file name`);
  files.push({ name, samples: s, root: noteFromName(name) });
}
const slot = buildUserSlot(files);
check(createHash("sha256").update(slot.data).digest("hex") === gold.dataSha && slot.data.length === gold.dataLen, "the ADPCM data matches byte for byte");
slot.zones.forEach((z, i) => {
  const g = gold.zones[i];
  const mine = [z.off, z.n, z.ls, z.le, z.rate, z.root16, z.pred, z.idx, z.lo, z.hi, z.looped];
  check(mine.join() === [g[0], g[1], g[2], g[3], g[4], g[5], g[6], g[7], g[8], g[9], g[10]].join(), `zone ${i} matches (${mine} vs ${g})`);
});

// the engines play the slot
const render = (def: typeof ENG_SAMPLE, params: number[], note: number, blocks = 40): Int32Array => {
  const t = new Track();
  params.forEach((v, k) => (t.p[P_E0 + k] = v));
  const v = new EngVoice();
  v.note = note; v.vel = 100; v.gate = 1; v.active = 1; v.stage = 2; v.pitch16 = v.pitchCur = note * 16;
  def.noteOn(t, v);
  const out = new Int32Array(CTL * blocks);
  const buf = new Int32Array(CTL);
  for (let b = 0; b < blocks; b++) {
    buf.fill(0);
    const m: Vmod = { pitch16: note * 16, inc: 0, fine: 0, amp0: 24000, amp1: 24000, envq15: 20000, cutoff: 0, shape: 64 << 8 };
    def.block?.(t);
    def.render(t, v, buf, CTL, m);
    out.set(buf, b * CTL);
  }
  return out;
};
const peak = (a: Int32Array): number => a.reduce((m, x) => Math.max(m, Math.abs(x)), 0);
const missing = render(ENG_SAMPLE, [SMP_NSETS, 0, 0, 0, 0, 0, 0, 0], 60); // slot 1 empty: the sine
check(loadUserSlot(0, slot) && usrNz[0] === 3, "the slot loads with three zones");
const sample = render(ENG_SAMPLE, [SMP_NSETS, 0, 0, 0, 0, 0, 0, 0], 60);
check(peak(sample) > 0 && sample.join() !== missing.join(), "SAMPLE plays the user slot instead of the sine");
const g1 = render(ENG_GRAIN, [SMP_NSETS, 64, 64, 64, 64, 0, 64, 64], 60, 80);
check(peak(g1) > 0, "GRAIN plays the user slot");
const sl = render(ENG_SLICE, [1, 2, 0, 0, 0, 0, 0, 0], 60);
check(peak(sl) > 0, "SLICE plays slices of the user slot");
check(loadUserSlot(0, null) === false && usrNz[0] === 0, "an emptied slot is missing again");
if (fails) process.exit(1);
console.log("OK user samples: pipeline matches sampleio.py, SAMPLE / GRAIN / SLICE play the slot");
