import { DK_NAMES } from "../drum/drumsynth";
import { engineById } from "../engines/registry";
import { P_E0, Track } from "../engines/types";
import { LibraryEntry } from "../instruments";
import { cloneMod, ModSetup } from "../mod/setup";
import { Instrument } from "../synth/synth";
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
const DRUM_KITS = [0, 4, 5, 6, 7, 8, 9, 10, 11]; // the kits a user can pick (1..3 are retired aliases)
const FX_LABELS = ["Dist", "Chorus", "Delay", "Reverb"];

const copy = (i: Editable): Editable => (i.kind === "engine" ? { ...i, params: [...i.params], env: [...i.env], fx: i.fx && [...i.fx] } : { ...i, params: [...i.params], fx: i.fx && [...i.fx] });

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
    k += `<label class="kc"><span>Kick</span><select data-p="6"><option value="0"${i.params[6] ? "" : " selected"}>PUNCH</option><option value="1"${i.params[6] ? " selected" : ""}>ROUND</option></select></label>`;
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
    env += `<label class="kc"><span>Mono</span><input type="checkbox" data-mono${i.mono ? " checked" : ""}></label>`;
    if (i.engine === "ANALOG") {
      env += `<label class="kc"><span>Filter</span><select data-ftype>${FTYPES.map((f, n) => `<option value="${n}"${(i.ftype ?? 0) === n ? " selected" : ""}>${f}</option>`).join("")}</select></label>`;
    }
    const labels = entry.def.edit.map((d) => d.label);
    root.innerHTML = head(i.engine, entry.def.pageTitle.join(" / ")) +
      `<div class="panel">${module(entry.def.pageTitle.join(" / "), sound, "wide")}${module("Envelope", env)}${fxModule(i)}` +
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
    else if (inst.kind === "engine" && el.dataset.e !== undefined) inst.env[Number(el.dataset.e)] = v;
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
