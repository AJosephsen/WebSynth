// The LFO and modulation matrix of a track, as a panel of controls (Felucca's LFO, LFO DEST, ENV DEST and MOD pages).
import { N_LSYNC, N_LWAVE, N_MDST, N_MSRC } from "../mod/mod";
import { ModSetup } from "../mod/setup";

type Field = [key: keyof ModSetup, label: string, lo: number, hi: number];
const LFO: Field[] = [["rate", "Rate", 0, 127], ["fade", "Fade in", 0, 127], ["phase", "Start phase", 0, 127]];
const DEST: Field[] = [
  ["ldPit", "LFO > pitch", -64, 63], ["ldFlt", "LFO > filter", -64, 63], ["ldShp", "LFO > shape", -64, 63], ["ldAmp", "LFO > amp", 0, 127],
  ["edPit", "Env > pitch", -64, 63], ["edShp", "Env > shape", -64, 63],
];

const sel = (attr: string, names: readonly string[], v: number): string =>
  `<select ${attr}>${names.map((n, k) => `<option value="${k}"${k === v ? " selected" : ""}>${n}</option>`).join("")}</select>`;
const range = (attr: string, lo: number, hi: number, v: number): string => `<input type="range" ${attr} min="${lo}" max="${hi}" value="${v}">`;

/** engineLabels: the names of the engine's eight parameters (E1..E8). */
export function modPanelHtml(m: ModSetup, engineLabels: string[]): string {
  const dst = N_MDST.map((n, k) => (k >= 12 && k < 20 ? `${n} ${engineLabels[k - 12] ?? ""}`.trim() : n));
  let h = `<div class="modp-grid">`;
  h += `<label>Wave${sel('data-mod="wave"', N_LWAVE, m.wave)}</label>`;
  h += `<label>Sync${sel('data-mod="sync"', N_LSYNC, m.sync)}</label>`;
  h += `<label>Trigger${sel('data-mod="trig"', ["NOTE", "FREE"], m.trig)}</label>`;
  h += `<label>Polarity${sel('data-mod="pol"', ["BI", "UNI"], m.pol)}</label>`;
  for (const [k, label, lo, hi] of [...LFO, ...DEST]) h += `<label>${label}${range(`data-mod="${k}"`, lo, hi, m[k] as number)}</label>`;
  h += `</div><div class="modp-slots">`;
  m.slots.forEach((s, i) => {
    h += `<div class="slot"><span>Slot ${i + 1}</span>${sel(`data-slot="${i}.src"`, N_MSRC, s.src)}<span>&rarr;</span>${sel(`data-slot="${i}.dst"`, dst, s.dst)}${range(`data-slot="${i}.amt"`, -64, 63, s.amt)}<output>${s.amt}</output></div>`;
  });
  h += `<div class="slot"><span>Touch</span><span>AT</span><span>&rarr;</span>${sel('data-mod="atDst"', dst, m.atDst)}${range('data-mod="atAmt"', -64, 63, m.atAmt)}<output>${m.atAmt}</output></div></div>`;
  h += `<div class="modp-live"><span>Play with it:</span><label>Mod wheel${range('data-live="1"', 0, 127, 0)}</label><label>Aftertouch${range('data-live="at"', 0, 127, 0)}</label><label>Expression${range('data-live="11"', 0, 127, 127)}</label></div>`;
  return h;
}

/** Applies a changed control to the setup; true when it changed something. */
export function applyModInput(m: ModSetup, el: HTMLInputElement | HTMLSelectElement): boolean {
  const v = Number(el.value);
  if (el.dataset.mod) {
    (m as unknown as Record<string, number>)[el.dataset.mod] = v;
    return true;
  }
  if (el.dataset.slot) {
    const [i, k] = el.dataset.slot.split(".");
    (m.slots[Number(i)] as unknown as Record<string, number>)[k] = v;
    const out = el.parentElement?.querySelector("output");
    if (k === "amt" && out) out.textContent = String(v);
    return true;
  }
  return false;
}
