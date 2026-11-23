import { DK_NAMES } from "../drum/drumsynth";
import { engineById } from "../engines/registry";
import { P_E0, Track } from "../engines/types";
import { LibraryEntry } from "../instruments";
import { Instrument } from "../synth/synth";

type Editable = Extract<Instrument, { kind: "engine" | "drum" }>;

export interface EngineEditorDeps {
  onChange: (inst: Editable) => void;
  saveNew: (inst: Editable, name: string) => void;
}

const ENV_LABELS = ["Attack", "Decay", "Sustain", "Release"];
const FTYPES = ["Low-pass", "Band-pass", "High-pass"];
const DRUM_LABELS = ["Kit", "Tune", "Tone", "Decay", "Snap", "Accent", "Kick", "Drive"];
const DRUM_KITS = [0, 4, 5, 6, 7, 8, 9, 10, 11]; // the kits a user can pick (1..3 are retired aliases)

const copy = (i: Editable): Editable => (i.kind === "engine" ? { ...i, params: [...i.params], env: [...i.env], fx: i.fx && [...i.fx] } : { ...i, params: [...i.params], fx: i.fx && [...i.fx] });

/** Editor for the parameters (and, for the synth engines, envelope and filter amount) of an engine or drum instrument. */
export function mountEngineEditor(root: HTMLElement, deps: EngineEditorDeps) {
  let inst: Editable | undefined;
  let name = "";

  function head(title: string, sub: string): string {
    return `<div class="pe-top"><strong>${title}</strong><span class="src">${sub}</span>
      <label>Name <input id="ee-name" maxlength="16" value="${name.replace(/"/g, "&quot;")}"></label>
      <button id="ee-save">Save as new user preset</button></div>`;
  }

  function renderDrum(i: Extract<Editable, { kind: "drum" }>): void {
    let h = head("DRUM", "KIT / HIT") + '<div class="two">';
    h += `<label class="prm"><span>Kit</span><select data-p="0">${DRUM_KITS.map((k) => `<option value="${k}"${i.params[0] === k ? " selected" : ""}>${DK_NAMES[k]}${k === 5 ? " (10)" : ""}</option>`).join("")}</select></label>`;
    for (let k = 1; k < 8; k++) {
      if (k === 6) {
        h += `<label class="prm"><span>Kick</span><select data-p="6"><option value="0"${i.params[6] ? "" : " selected"}>PUNCH</option><option value="1"${i.params[6] ? " selected" : ""}>ROUND</option></select></label>`;
        continue;
      }
      h += `<label class="prm"><span>${DRUM_LABELS[k]}</span><input type="range" data-p="${k}" min="0" max="127" value="${i.params[k]}"><output>${i.params[k]}</output></label>`;
    }
    root.innerHTML = h + "</div>";
  }

  function renderEngine(i: Extract<Editable, { kind: "engine" }>): void {
    const entry = engineById(i.engine)!;
    const t = new Track();
    i.params.forEach((v, k) => (t.p[P_E0 + k] = v));
    let h = head(i.engine, entry.def.pageTitle.join(" / ")) + '<div class="two">';
    for (let k = 0; k < 8; k++) {
      const d = entry.def.desc?.(t, k) ?? entry.def.edit[k];
      const v = i.params[k];
      const shown = d.names ? (d.names[v - d.min] ?? v) : v;
      h += `<label class="prm"><span>${d.label}${d.unit ? ` (${d.unit})` : ""}</span><input type="range" data-p="${k}" min="${d.min}" max="${d.max}" value="${v}"><output>${shown}</output></label>`;
    }
    h += `</div><h4>Envelope</h4><div class="two">`;
    i.env.forEach((v, n) => {
      h += `<label class="prm"><span>${ENV_LABELS[n]}</span><input type="range" data-e="${n}" min="0" max="127" value="${v}"><output>${v}</output></label>`;
    });
    h += `<label class="prm"><span>Env to filter</span><input type="range" data-fenv min="-64" max="63" value="${i.fenv}"><output>${i.fenv}</output></label>`;
    h += `<label class="prm"><span>Mono</span><input type="checkbox" data-mono${i.mono ? " checked" : ""}></label>`;
    if (i.engine === "ANALOG") {
      h += `<label class="prm"><span>Filter type</span><select data-ftype>${FTYPES.map((f, n) => `<option value="${n}"${(i.ftype ?? 0) === n ? " selected" : ""}>${f}</option>`).join("")}</select></label>`;
    }
    root.innerHTML = h + "</div>";
  }

  function render(): void {
    if (!inst) { root.innerHTML = ""; return; }
    if (inst.kind === "drum") renderDrum(inst);
    else renderEngine(inst);
  }

  root.addEventListener("input", (e) => {
    if (!inst) return;
    const el = e.target as HTMLInputElement;
    if (el.id === "ee-name") { name = el.value; return; }
    const v = Number(el.value);
    if (el.dataset.p !== undefined) inst.params[Number(el.dataset.p)] = v;
    else if (inst.kind === "engine" && el.dataset.e !== undefined) inst.env[Number(el.dataset.e)] = v;
    else if (inst.kind === "engine" && el.hasAttribute("data-fenv")) inst.fenv = v;
    else if (inst.kind === "engine" && el.hasAttribute("data-mono")) inst.mono = el.checked;
    else if (inst.kind === "engine" && el.hasAttribute("data-ftype")) inst.ftype = v;
    else return;
    deps.onChange(copy(inst));
    if (el.type === "range") {
      const out = el.parentElement?.querySelector("output");
      if (out) out.textContent = String(v);
    }
  });
  root.addEventListener("change", (e) => {
    const el = e.target as HTMLInputElement;
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
