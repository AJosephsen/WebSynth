import { DK_NAMES } from "../drum/drumsynth";
import { engineById } from "../engines/registry";
import { P_E0, Track } from "../engines/types";
import { LibraryEntry } from "../instruments";
import { cloneMod, ModSetup } from "../mod/setup";
import { Instrument, VoiceParams } from "../synth/synth";
import { applyModInput, modPanelHtml } from "./modpanel";

type Editable = Extract<Instrument, { kind: "engine" | "drum" }>;

export interface EngineEditorDeps {
  onChange: (inst: Editable) => void;
  saveNew: (inst: Editable, name: string) => void;
  /** The LFO and matrix of the live keyboard's synth. */
  getMod: () => ModSetup;
  onMod: (m: ModSetup) => void;
  onMidi: (status: number, d1: number, d2: number) => void;
}

const ENV_LABELS = ["Attack", "Decay", "Sustain", "Release"];
const FTYPES = ["Low-pass", "Band-pass", "High-pass"];
const DRUM_LABELS = ["Kit", "Tune", "Tone", "Decay", "Snap", "Accent", "Kick", "Drive"];
const DRUM_KITS = [0, 4, 5, 6, 7, 8, 9, 10, 11, 12, 13, 14, 15, 16]; // the kits a user can pick (1..3 are retired aliases; 12..15: Melodee's 808, 909, CR78, FM)
const VOICE_MODES = ["Poly", "Mono", "Legato", "Unison"];
const defaultVp = (mono: boolean): VoiceParams => ({ voice: mono ? 1 : 0, glide: 0, glmode: 0, prio: 0, alloc: 0, detune: 40, spread: 0 });
const FX_LABELS = ["Dist", "Chorus", "Delay", "Reverb"];

const copy = (i: Editable): Editable => (i.kind === "engine" ? { ...i, params: [...i.params], env: [...i.env], fx: i.fx && [...i.fx], vp: i.vp && { ...i.vp } } : { ...i, params: [...i.params], fx: i.fx && [...i.fx] });

const knob = (label: string, attr: string, lo: number, hi: number, v: number, shown: string | number = v): string =>
  `<label class="kc"><span>${label}</span><input type="range" ${attr} min="${lo}" max="${hi}" value="${v}"><output>${shown}</output></label>`;
const module = (title: string, body: string, cls = ""): string => `<section class="module ${cls}"><h4>${title}</h4><div class="knobs">${body}</div></section>`;

/** The front panel of an engine or drum instrument: modules of knobs for the sound, envelope, LFO and matrix, effects. */
export function mountEngineEditor(root: HTMLElement, deps: EngineEditorDeps) {
  let inst: Editable | undefined;
  let name = "";
  let pointerDown = false;
  let relabel = 0;

  function head(title: string, sub: string): string {
    return `<div class="pe-top"><strong>${title}</strong><span class="src">${sub}</span>
      <label>Name <input id="ee-name" maxlength="16" value="${name.replace(/"/g, "&quot;")}"></label>
      <button id="ee-save">Save as new user preset</button></div>`;
  }

  function fxModule(i: Editable): string {
    const fx = (i.fx ??= [0, 0, 0, 25]);
    return module("Effects", FX_LABELS.map((l, k) => knob(l, `data-fx="${k}"`, 0, 127, fx[k])).join(""));
  }

  function renderDrum(i: Extract<Editable, { kind: "drum" }>): void {
    let k = `<label class="kc"><span>Kit</span><select data-p="0">${DRUM_KITS.map((n) => `<option value="${n}"${i.params[0] === n ? " selected" : ""}>${DK_NAMES[n]}${n === 5 ? " (10)" : ""}</option>`).join("")}</select></label>`;
    const hats = i.params[0] === 14; // KIT CR78: its KICK knob picks the hats (HAT, METAL)
    k += `<label class="kc"><span>${hats ? "Hats" : "Kick"}</span><select data-p="6"><option value="0"${i.params[6] ? "" : " selected"}>${hats ? "HAT" : "PUNCH"}</option><option value="1"${i.params[6] ? " selected" : ""}>${hats ? "METAL" : "ROUND"}</option></select></label>`;
    for (const n of [1, 2, 3, 4, 5, 7]) k += knob(DRUM_LABELS[n], `data-p="${n}"`, 0, 127, i.params[n]);
    root.innerHTML = head("DRUM", "KIT / HIT") + `<div class="panel">${module("Drums", k)}${fxModule(i)}</div>`;
  }

  function renderEngine(i: Extract<Editable, { kind: "engine" }>): void {
    const entry = engineById(i.engine)!;
    const t = new Track();
    i.params.forEach((v, k) => (t.p[P_E0 + k] = v));
    let sound = "";
    for (let k = 0; k < 8; k++) {
      const d = entry.def.desc?.(t, k) ?? entry.def.edit[k];
      const v = i.params[k];
      const shown = d.names ? (d.names[v - d.min] ?? v) : v;
      sound += knob(`${d.label}${d.unit ? ` (${d.unit})` : ""}`, `data-p="${k}"`, d.min, d.max, v, shown);
    }
    let env = i.env.map((v, n) => knob(ENV_LABELS[n], `data-e="${n}"`, 0, 127, v)).join("");
    env += knob("Env &gt; filter", "data-fenv", -64, 63, i.fenv);
    if (i.engine === "ANALOG") {
      env += `<label class="kc"><span>Filter</span><select data-ftype>${FTYPES.map((f, n) => `<option value="${n}"${(i.ftype ?? 0) === n ? " selected" : ""}>${f}</option>`).join("")}</select></label>`;
    }
    const vp = i.vp ?? defaultVp(i.mono);
    const sel = (label: string, key: keyof VoiceParams, names: string[]) =>
      `<label class="kc"><span>${label}</span><select data-vp="${key}">${names.map((n, k) => `<option value="${k}"${vp[key] === k ? " selected" : ""}>${n}</option>`).join("")}</select></label>`;
    const voice = sel("Mode", "voice", VOICE_MODES) + knob("Glide", 'data-vp="glide"', 0, 127, vp.glide) + sel("Glide", "glmode", ["Rate", "Time"]) +
      sel("Priority", "prio", ["Last", "Low", "High"]) + sel("Alloc", "alloc", ["Rotate", "Reuse"]) + knob("Detune", 'data-vp="detune"', 0, 127, vp.detune) +
      knob("Spread", 'data-vp="spread"', 0, 127, vp.spread);
    const labels = entry.def.edit.map((d) => d.label);
    root.innerHTML = head(i.engine, entry.def.pageTitle.join(" / ")) +
      `<div class="panel">${module(entry.def.pageTitle.join(" / "), sound, "wide")}${module("Envelope", env)}${module("Voice", voice)}${fxModule(i)}` +
      `<section class="module full"><h4>LFO &middot; Modulation <small>(live keyboard)</small></h4><div class="modp-body">${modPanelHtml(deps.getMod(), labels)}</div></section></div>`;
  }

  function render(): void {
    if (!inst) { root.innerHTML = ""; return; }
    if (inst.kind === "drum") renderDrum(inst);
    else renderEngine(inst);
  }

  /** A mode-dependent engine relabels its knobs (and may change their ranges): redraw once the knob is let go. */
  function scheduleRelabel(): void {
    if (inst?.kind !== "engine" || !engineById(inst.engine)?.def.desc) return;
    clearTimeout(relabel);
    relabel = window.setTimeout(function again() {
      if (pointerDown) { relabel = window.setTimeout(again, 200); return; }
      render();
    }, 300);
  }

  document.addEventListener("pointerdown", () => (pointerDown = true), true);
  document.addEventListener("pointerup", () => (pointerDown = false), true);
  document.addEventListener("pointercancel", () => (pointerDown = false), true);

  root.addEventListener("input", (e) => {
    const el = e.target as HTMLInputElement;
    if (el.id === "ee-name") { name = el.value; return; }
    if (el.closest(".modp-body")) {
      if (el.dataset.live) {
        const v = Number(el.value);
        if (el.dataset.live === "at") deps.onMidi(0xd0, v, 0);
        else deps.onMidi(0xb0, Number(el.dataset.live), v);
        return;
      }
      const m = cloneMod(deps.getMod());
      if (applyModInput(m, el)) {
        const out = el.parentElement?.querySelector("output");
        if (out && el.type === "range" && el.dataset.mod) out.textContent = el.value;
        deps.onMod(m);
      }
      return;
    }
    if (!inst) return;
    const v = Number(el.value);
    if (el.dataset.p !== undefined) { inst.params[Number(el.dataset.p)] = v; scheduleRelabel(); }
    else if (el.dataset.fx !== undefined) (inst.fx ??= [0, 0, 0, 25])[Number(el.dataset.fx)] = v;
    else if (inst.kind === "engine" && el.dataset.vp !== undefined) {
      inst.vp ??= defaultVp(inst.mono);
      (inst.vp as unknown as Record<string, number>)[el.dataset.vp] = v;
      inst.mono = inst.vp.voice === 1;
    } else if (inst.kind === "engine" && el.dataset.e !== undefined) inst.env[Number(el.dataset.e)] = v;
    else if (inst.kind === "engine" && el.hasAttribute("data-fenv")) inst.fenv = v;
    else if (inst.kind === "engine" && el.hasAttribute("data-mono")) inst.mono = el.checked;
    else if (inst.kind === "engine" && el.hasAttribute("data-ftype")) inst.ftype = v;
    else return;
    deps.onChange(copy(inst));
    if (el.type === "range") {
      const out = el.parentElement?.querySelector("output");
      if (out && el.dataset.p === undefined) out.textContent = String(v);
      else if (out) out.textContent = el.dataset.p !== undefined && inst.kind === "engine" ? shownFor(inst, Number(el.dataset.p), v) : String(v);
    }
  });
  function shownFor(i: Extract<Editable, { kind: "engine" }>, k: number, v: number): string {
    const entry = engineById(i.engine)!;
    const t = new Track();
    i.params.forEach((x, n) => (t.p[P_E0 + n] = x));
    const d = entry.def.desc?.(t, k) ?? entry.def.edit[k];
    return String(d.names ? (d.names[v - d.min] ?? v) : v);
  }
  root.addEventListener("change", (e) => {
    const el = e.target as HTMLInputElement;
    if (el.closest(".modp-body")) return;
    if (el.dataset.p !== undefined || el.hasAttribute("data-ftype") || el.hasAttribute("data-mono")) render(); // a mode change relabels the knobs
  });
  root.addEventListener("click", (e) => {
    if ((e.target as HTMLElement).id === "ee-save" && inst) deps.saveNew(copy(inst), name || "USER");
  });

  return {
    load(entry: LibraryEntry): void {
      const src = entry.instrument;
      if (src.kind !== "engine" && src.kind !== "drum") { inst = undefined; render(); return; }
      inst = copy(src); // works on a copy
      name = entry.name;
      render();
    },
    clear(): void { inst = undefined; render(); },
  };
}
