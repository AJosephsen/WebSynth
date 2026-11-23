import { FP, maxValue, patchName } from "../fm6/patch";
import { LibraryPatch } from "../fm6/library";
import { algoSvg, envPoints } from "./algo";

const NOTE = ["C", "C#", "D", "D#", "E", "F", "F#", "G", "G#", "A", "A#", "B"];
const noteName = (n: number) => NOTE[n % 12] + (Math.floor(n / 12) - 1);
const CURVES = ["-LIN", "-EXP", "+EXP", "+LIN"];
const WAVES = ["Triangle", "Saw down", "Saw up", "Square", "Sine", "Sample & hold"];
const opBase = (n: number) => (6 - n) * FP.OP; // operator 1 is stored last

export interface EditorDeps {
  /** Called with the edited voice after every change (send it to the live synth). */
  onChange: (patch: Uint8Array) => void;
  /** Adds a voice to the user library. */
  saveNew: (patch: Uint8Array) => void;
  /** Overwrites a user voice. */
  overwrite: (target: LibraryPatch, patch: Uint8Array) => void;
}

interface Param {
  label: string;
  index: number; // absolute byte index
  fmt?: (v: number) => string;
  min?: number;
}

export function mountPatchEditor(root: HTMLElement, deps: EditorDeps) {
  let origin: LibraryPatch | undefined;
  let work = new Uint8Array(FP.SIZE);
  let op = 1; // selected operator, 1..6

  function ratioText(base: number): string {
    const mode = work[base + FP.MODE];
    const fc = work[base + FP.FC];
    const ff = work[base + FP.FF];
    if (mode === 0) return `${((fc === 0 ? 0.5 : fc) * (1 + ff / 100)).toFixed(2)} ×`;
    return `${(10 ** (fc & 3) * (1 + (ff / 99) * 8.772)).toFixed(1)} Hz`;
  }

  const row = (p: Param, extra = "") => {
    const v = work[p.index];
    return `<label class="prm"><span>${p.label}</span><input type="range" data-i="${p.index}" min="${p.min ?? 0}" max="${maxValue(p.index)}" value="${v}"${extra}><output data-o="${p.index}">${p.fmt ? p.fmt(v) : v}</output></label>`;
  };

  function envBlock(base: number): string {
    const rates = [0, 1, 2, 3].map((i) => work[base + FP.R1 + i]);
    const levels = [0, 1, 2, 3].map((i) => work[base + FP.L1 + i]);
    let h = `<svg viewBox="0 0 200 70" class="env"><polyline points="${envPoints(rates, levels, 200, 70)}" fill="none" stroke="currentColor" stroke-width="2"/></svg><div class="two">`;
    for (let i = 0; i < 4; i++) h += row({ label: `R${i + 1}`, index: base + FP.R1 + i });
    for (let i = 0; i < 4; i++) h += row({ label: `L${i + 1}`, index: base + FP.L1 + i });
    return h + "</div>";
  }

  function pitchEnvBlock(): string {
    const rates = [0, 1, 2, 3].map((i) => work[FP.PR1 + i]);
    const levels = [0, 1, 2, 3].map((i) => work[FP.PL1 + i]);
    let h = `<svg viewBox="0 0 200 70" class="env"><polyline points="${envPoints(rates, levels, 200, 70)}" fill="none" stroke="currentColor" stroke-width="2"/><line x1="0" x2="200" y1="35" y2="35" stroke="currentColor" stroke-opacity=".3"/></svg><div class="two">`;
    for (let i = 0; i < 4; i++) h += row({ label: `PR${i + 1}`, index: FP.PR1 + i });
    for (let i = 0; i < 4; i++) h += row({ label: `PL${i + 1}`, index: FP.PL1 + i, fmt: (v) => String(v - 50) });
    return h + "</div>";
  }

  function render(): void {
    if (!origin) return;
    const alg = work[FP.ALG] + 1;
    const base = opBase(op);
    const tabs = [1, 2, 3, 4, 5, 6]
      .map((n) => `<button data-op="${n}" class="optab${n === op ? " sel" : ""}">OP${n}<small>${ratioText(opBase(n))} · ${work[opBase(n) + FP.OL]}</small></button>`)
      .join("");
    root.innerHTML = `
      <div class="pe-top">
        <label>Name <input id="pe-name" maxlength="10" value="${patchName(work).replace(/"/g, "&quot;")}"></label>
        <span class="src">${origin.bank}: ${origin.name}</span>
        <button id="pe-save">Save as new user patch</button>
        <button id="pe-over"${origin.source === "user" ? "" : " disabled"}>Overwrite user patch</button>
        <button id="pe-reset">Revert to original</button>
      </div>
      <div class="pe-grid">
        <div class="pe-voice">
          <h4>Algorithm ${alg}</h4>
          ${algoSvg(alg, op)}
          ${row({ label: "Algorithm", index: FP.ALG, fmt: (v) => String(v + 1) })}
          ${row({ label: "Feedback", index: FP.FB })}
          ${row({ label: "Transpose", index: FP.TRNSP, fmt: (v) => `${v - 24 >= 0 ? "+" : ""}${v - 24} st` })}
          <h4>LFO</h4>
          ${row({ label: "Speed", index: FP.LFS })}${row({ label: "Delay", index: FP.LFD })}
          ${row({ label: "Pitch depth", index: FP.LPMD })}${row({ label: "Amp depth", index: FP.LAMD })}
          ${row({ label: "Pitch sens", index: FP.LPMS })}
          <label class="prm"><span>Wave</span><select data-i="${FP.LFW}">${WAVES.map((w, i) => `<option value="${i}"${work[FP.LFW] === i ? " selected" : ""}>${w}</option>`).join("")}</select></label>
          <label class="prm"><span>Key sync</span><input type="checkbox" data-i="${FP.LKS}"${work[FP.LKS] ? " checked" : ""}></label>
          <h4>Pitch envelope</h4>
          ${pitchEnvBlock()}
        </div>
        <div class="pe-op">
          <div class="optabs">${tabs}</div>
          <h4>Operator ${op}</h4>
          ${row({ label: "Output level", index: base + FP.OL })}
          <label class="prm"><span>Mode</span><select data-i="${base + FP.MODE}"><option value="0"${work[base + FP.MODE] ? "" : " selected"}>Ratio</option><option value="1"${work[base + FP.MODE] ? " selected" : ""}>Fixed Hz</option></select><output>${ratioText(base)}</output></label>
          ${row({ label: "Coarse", index: base + FP.FC })}${row({ label: "Fine", index: base + FP.FF })}
          ${row({ label: "Detune", index: base + FP.DET, fmt: (v) => String(v - 7) })}
          ${row({ label: "Velocity sens", index: base + FP.KVS })}${row({ label: "Rate scaling", index: base + FP.RS })}
          ${row({ label: "Amp mod sens", index: base + FP.AMS })}
          <h4>Envelope</h4>
          ${envBlock(base)}
          <h4>Level scaling</h4>
          ${row({ label: "Break point", index: base + FP.BP, fmt: (v) => noteName(v + 21) })}
          ${row({ label: "Left depth", index: base + FP.LD })}${row({ label: "Right depth", index: base + FP.RD })}
          ${[["Left curve", FP.LC], ["Right curve", FP.RC]].map(([l, o]) => `<label class="prm"><span>${l}</span><select data-i="${base + (o as number)}">${CURVES.map((c, i) => `<option value="${i}"${work[base + (o as number)] === i ? " selected" : ""}>${c}</option>`).join("")}</select></label>`).join("")}
        </div>
      </div>`;
  }

  function changed(rerender: boolean): void {
    deps.onChange(Uint8Array.from(work));
    if (rerender) render();
  }

  root.addEventListener("input", (e) => {
    const el = e.target as HTMLInputElement | HTMLSelectElement;
    if (el.id === "pe-name") {
      const name = (el as HTMLInputElement).value.toUpperCase().replace(/[^\x20-\x7e]/g, "").padEnd(10).slice(0, 10);
      for (let i = 0; i < 10; i++) work[FP.NAME + i] = name.charCodeAt(i);
      return;
    }
    if (el.dataset.i === undefined) return;
    const i = Number(el.dataset.i);
    const v = el.type === "checkbox" ? ((el as HTMLInputElement).checked ? 1 : 0) : Math.min(maxValue(i), Number(el.value));
    work[i] = v;
    const out = root.querySelector<HTMLElement>(`[data-o="${i}"]`);
    if (el.type === "range") {
      // cheap update while dragging: only the number; the diagrams redraw when the drag ends
      if (out) out.textContent = el.dataset.fmt ? "" : String(v);
      changed(false);
    } else {
      changed(true);
    }
  });

  // redraw formatted values, graphs and the algorithm diagram when a drag ends
  root.addEventListener("change", (e) => {
    const el = e.target as HTMLInputElement;
    if (el.type === "range") render();
  });

  root.addEventListener("click", (e) => {
    const t = e.target as HTMLElement;
    const tab = t.closest<HTMLElement>("[data-op]");
    if (tab) { op = Number(tab.dataset.op); render(); return; }
    if (t.id === "pe-save") deps.saveNew(Uint8Array.from(work));
    else if (t.id === "pe-over" && origin) deps.overwrite(origin, Uint8Array.from(work));
    else if (t.id === "pe-reset" && origin) { work = Uint8Array.from(origin.patch); changed(true); }
  });

  return {
    clear(): void {
      origin = undefined;
      root.innerHTML = "";
    },
    /** Loads a library voice into the editor (works on a copy). */
    load(p: LibraryPatch): void {
      origin = p;
      work = Uint8Array.from(p.patch);
      render();
    },
  };
}
