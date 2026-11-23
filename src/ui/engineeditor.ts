import { engineById } from "../engines/registry";
import { P_E0, Track } from "../engines/types";
import { LibraryEntry } from "../instruments";
import { Instrument } from "../synth/synth";

type EngineInstrument = Extract<Instrument, { kind: "engine" }>;

export interface EngineEditorDeps {
  onChange: (inst: EngineInstrument) => void;
  saveNew: (inst: EngineInstrument, name: string) => void;
}

const ENV_LABELS = ["Attack", "Decay", "Sustain", "Release"];
const FTYPES = ["Low-pass", "Band-pass", "High-pass"];

/** Editor for the eight parameters, the envelope and the filter amount of an engine instrument. */
export function mountEngineEditor(root: HTMLElement, deps: EngineEditorDeps) {
  let origin: LibraryEntry | undefined;
  let inst: EngineInstrument | undefined;
  let name = "";

  function render(): void {
    if (!inst || !origin) { root.innerHTML = ""; return; }
    const entry = engineById(inst.engine)!;
    const t = new Track();
    inst.params.forEach((v, k) => (t.p[P_E0 + k] = v));
    let h = `<div class="pe-top"><strong>${inst.engine}</strong>
      <span class="src">${entry.def.pageTitle.join(" / ")}</span>
      <label>Name <input id="ee-name" maxlength="16" value="${name.replace(/"/g, "&quot;")}"></label>
      <button id="ee-save">Save as new user preset</button></div><div class="two">`;
    for (let k = 0; k < 8; k++) {
      const d = entry.def.desc?.(t, k) ?? entry.def.edit[k];
      const v = inst.params[k];
      const shown = d.names ? (d.names[v - d.min] ?? v) : v;
      h += `<label class="prm"><span>${d.label}${d.unit ? ` (${d.unit})` : ""}</span><input type="range" data-p="${k}" min="${d.min}" max="${d.max}" value="${v}"><output>${shown}</output></label>`;
    }
    h += `</div><h4>Envelope</h4><div class="two">`;
    inst.env.forEach((v, i) => {
      h += `<label class="prm"><span>${ENV_LABELS[i]}</span><input type="range" data-e="${i}" min="0" max="127" value="${v}"><output>${v}</output></label>`;
    });
    h += `<label class="prm"><span>Env to filter</span><input type="range" data-fenv min="-64" max="63" value="${inst.fenv}"><output>${inst.fenv}</output></label>`;
    h += `<label class="prm"><span>Mono</span><input type="checkbox" data-mono${inst.mono ? " checked" : ""}></label>`;
    if (inst.engine === "ANALOG") {
      h += `<label class="prm"><span>Filter type</span><select data-ftype>${FTYPES.map((f, i) => `<option value="${i}"${(inst!.ftype ?? 0) === i ? " selected" : ""}>${f}</option>`).join("")}</select></label>`;
    }
    root.innerHTML = h + "</div>";
  }

  root.addEventListener("input", (e) => {
    if (!inst) return;
    const el = e.target as HTMLInputElement;
    if (el.id === "ee-name") { name = el.value; return; }
    const v = Number(el.value);
    if (el.dataset.p !== undefined) inst.params[Number(el.dataset.p)] = v;
    else if (el.dataset.e !== undefined) inst.env[Number(el.dataset.e)] = v;
    else if (el.hasAttribute("data-fenv")) inst.fenv = v;
    else if (el.hasAttribute("data-mono")) inst.mono = el.checked;
    else if (el.hasAttribute("data-ftype")) inst.ftype = v;
    else return;
    deps.onChange({ ...inst, params: [...inst.params], env: [...inst.env] });
    if (el.type === "range") {
      const out = el.parentElement?.querySelector("output");
      if (out) out.textContent = String(v);
    }
  });
  root.addEventListener("change", (e) => {
    const el = e.target as HTMLInputElement;
    if (el.dataset.p === "0" || el.hasAttribute("data-ftype") || el.hasAttribute("data-mono")) render(); // mode changes relabel the knobs
    else if (el.dataset.p !== undefined) render();
  });
  root.addEventListener("click", (e) => {
    if ((e.target as HTMLElement).id === "ee-save" && inst) deps.saveNew({ ...inst, params: [...inst.params], env: [...inst.env] }, name || "USER");
  });

  return {
    load(entry: LibraryEntry): void {
      origin = entry;
      const src = entry.instrument;
      if (src.kind !== "engine") { inst = undefined; render(); return; }
      inst = { ...src, params: [...src.params], env: [...src.env] }; // works on a copy
      name = entry.name;
      render();
    },
    clear(): void { inst = undefined; render(); },
  };
}
