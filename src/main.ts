import workletUrl from "./worklet/processor.ts?worker&url";
import { mountSequencer } from "./ui/sequencer";
import { mountPatchEditor } from "./ui/patcheditor";
import { patchName } from "./fm6/patch";
import { exportBank, loadSysex, loadUserPatches, saveUserPatches, toLibraryPatch } from "./fm6/library";
import { factoryEntries, fm6Entry, LibraryEntry, loadUserEngineEntries, saveUserEngineEntries, userEngineEntry } from "./instruments";
import { mountEngineEditor } from "./ui/engineeditor";
import { mountKnobs } from "./ui/knobs";
import { PF_NAMES } from "./fx/perform";
import { defaultMod, ModSetup } from "./mod/setup";
import type { Instrument } from "./synth/synth";

const PAD_NAMES = [...PF_NAMES, "MUTE 1", "MUTE 2", "MUTE 3", "MUTE 4"];
const app = document.querySelector<HTMLDivElement>("#app")!;
app.innerHTML = `
  <header class="face">
    <div class="logo">WEB<b>SYNTH</b><small>FM6 · 8 ENGINES · DRUM</small></div>
    <div class="lcd" id="lcd">
      <div class="l1" id="lcd1">--</div>
      <div class="l2"><span id="lcd2"></span><span id="lcd3"></span></div>
    </div>
    <div class="ctl">
      <button id="start">Start audio</button>
      <div class="oct"><button id="octd" title="Octave down (Z)">&minus;</button><span id="octv">C3</span><button id="octu" title="Octave up (X)">+</button></div>
    </div>
  </header>
  <nav class="tabs" id="tabs"><button data-tab="sound" class="sel">Sound</button><button data-tab="seq">Sequencer</button><button data-tab="perf">Perform</button></nav>
  <div id="status" class="statusbar"></div>
  <main>
    <div class="tab" data-tab="sound">
      <section><h2>Patch library</h2>
        <select id="patch" size="12" disabled></select>
        <div>
          <label>Import DX7 .syx <input id="syx" type="file" accept=".syx"></label>
          <button id="export">Export bank (.syx)</button>
          <button id="delete">Delete user patch</button>
        </div>
      </section>
      <section><h2>Patch editor</h2><div id="pe"></div><div id="ee"></div></section>
    </div>
    <div class="tab" data-tab="seq" hidden><div id="seq"></div></div>
    <div class="tab" data-tab="perf" hidden>
      <section class="module"><h4>FX hold layer <small>(hold a pad; with Latch a press toggles it)</small></h4>
        <div class="pads" id="pads">${PAD_NAMES.map((n, e) => `<button class="pad${e >= 14 ? " mutepad" : ""}" data-e="${e}">${n}</button>`).join("")}</div>
        <div class="knobs">
          <label class="kc"><span>Filter</span><input type="range" data-pk="0" min="-100" max="100" value="0"><output>0</output></label>
          <label class="kc"><span>Crush</span><input type="range" data-pk="1" min="0" max="100" value="0"><output>0</output></label>
          <label class="kc"><span>Throw</span><input type="range" data-pk="2" min="0" max="100" value="0"><output>0</output></label>
          <label class="kc"><span>Depth</span><input type="range" data-pk="3" min="0" max="100" value="0"><output>0</output></label>
          <label class="kc"><span>Latch</span><input type="checkbox" id="pf-latch"></label>
          <label class="kc"><span>All off</span><button id="pf-off">Off</button></label>
        </div>
      </section>
    </div>
  </main>
  <footer class="kbd"><div class="keys" id="keys"></div><p>Keys A W S E D F T G Y H U J K, Z / X for the octave, the mouse or a MIDI keyboard. Further down the key, louder.</p></footer>`;

const $ = <T extends HTMLElement>(id: string) => app.querySelector<T>("#" + id)!;
const startBtn = $<HTMLButtonElement>("start");
const select = $<HTMLSelectElement>("patch");
const syx = $<HTMLInputElement>("syx");
const status = $("status");

// ---- display, tabs ----
const noteNames = ["C", "C#", "D", "D#", "E", "F", "F#", "G", "G#", "A", "A#", "B"];
const noteName = (n: number) => noteNames[n % 12] + (Math.floor(n / 12) - 1);
function lcdUpdate(): void {
  $("lcd1").textContent = current.name;
  $("lcd2").textContent = `${current.bank}${current.instrument.kind === "engine" ? " · engine" : current.instrument.kind === "drum" ? " · drum" : " · FM6"}`;
}
function lcdNote(text: string): void { $("lcd3").textContent = text; }
$("tabs").addEventListener("click", (e) => {
  const t = (e.target as HTMLElement).closest<HTMLElement>("button[data-tab]")?.dataset.tab;
  if (!t) return;
  app.querySelectorAll<HTMLElement>("#tabs button").forEach((b) => b.classList.toggle("sel", b.dataset.tab === t));
  app.querySelectorAll<HTMLElement>(".tab").forEach((d) => (d.hidden = d.dataset.tab !== t));
});

// ---- library ----
let library: LibraryEntry[] = [...factoryEntries, ...loadUserPatches().map(fm6Entry), ...loadUserEngineEntries()];
let current = library.find((e) => e.id === "TINE EP") ?? library[0];
let node: AudioWorkletNode | undefined;

let liveMod: ModSetup = defaultMod();
/** Sends the instrument to the worklet along with its effect sends (a preset brings its own, as in Felucca). */
function sendInstrument(inst: Instrument): void {
  node?.port.postMessage({ type: "instrument", instrument: inst });
  const [dist, chorus, delay, reverb] = inst.kind !== "fm6" && inst.fx ? inst.fx : [0, 0, 0, 25];
  node?.port.postMessage({ type: "liveMix", dist, chorus, delay, reverb });
}
function persist(): void {
  saveUserPatches(library.filter((e) => e.fm6 && e.source === "user").map((e) => e.fm6!));
  saveUserEngineEntries(library);
}
function fillSelect(): void {
  const banks = [...new Set(library.map((p) => p.bank))];
  select.innerHTML = banks
    .map((b) => `<optgroup label="${b}">${library.map((p, i) => (p.bank === b ? `<option value="${i}">${p.name}</option>` : "")).join("")}</optgroup>`)
    .join("");
  select.value = String(library.indexOf(current));
}
function choose(e: LibraryEntry): void {
  current = e;
  if (e.fm6) { fm6Editor.load(e.fm6); engineEditor.clear(); }
  else { fm6Editor.clear(); engineEditor.load(e); }
  sendInstrument(e.instrument);
  lcdUpdate();
}
function select_(e: LibraryEntry): void {
  current = e;
  fillSelect();
  seq.refreshLibrary();
  choose(e);
}
select.onchange = () => choose(library[Number(select.value)]);
syx.onchange = async () => {
  const file = syx.files?.[0];
  if (!file) return;
  const voices = loadSysex(new Uint8Array(await file.arrayBuffer()));
  if (!voices.length) { status.textContent = "No DX7 voices found in that file."; return; }
  library = [...library, ...voices.map(fm6Entry)];
  persist();
  fillSelect();
  seq.refreshLibrary();
  status.textContent = `Imported ${voices.length} voice${voices.length > 1 ? "s" : ""}.`;
};
$<HTMLButtonElement>("export").onclick = () => {
  const fm6 = library.filter((e) => e.fm6).map((e) => e.fm6!);
  const user = fm6.filter((p) => p.source === "user");
  const bytes = exportBank(user.length ? user : fm6);
  const a = document.createElement("a");
  a.href = URL.createObjectURL(new Blob([bytes as BlobPart], { type: "application/octet-stream" }));
  a.download = "websynth-bank.syx";
  a.click();
};
$<HTMLButtonElement>("delete").onclick = () => {
  if (current.source !== "user") { status.textContent = "Factory patches cannot be deleted."; return; }
  library = library.filter((p) => p !== current);
  persist();
  select_(library.find((e) => e.id === "TINE EP") ?? library[0]);
};

// ---- patch editors: FM6 voices and the other engines ----
const fm6Editor = mountPatchEditor($("pe"), {
  onChange: (patch) => sendInstrument({ kind: "fm6", patch }),
  saveNew: (patch) => {
    const entry = fm6Entry(toLibraryPatch(patch, "user"));
    library = [...library, entry];
    persist();
    select_(entry);
  },
  overwrite: (target, patch) => {
    const entry = library.find((e) => e.fm6 === target);
    if (!entry) return;
    target.patch = patch;
    target.name = patchName(patch);
    entry.name = target.name;
    entry.id = target.name;
    entry.instrument = { kind: "fm6", patch };
    persist();
    select_(entry);
  },
});
const engineEditor = mountEngineEditor($("ee"), {
  onChange: (inst) => sendInstrument(inst),
  getMod: () => liveMod,
  onMod: (m) => { liveMod = m; node?.port.postMessage({ type: "liveMod", mod: m }); },
  onMidi: (status, d1, d2) => node?.port.postMessage({ type: "midi", track: -1, status, d1, d2 }),
  saveNew: (inst, name) => {
    const entry = userEngineEntry(inst, name);
    library = [...library, entry];
    persist();
    select_(entry);
  },
});
fillSelect();
choose(current);

// ---- sequencer ----
const seq = mountSequencer($("seq"), { library: () => library, send: (m) => node?.port.postMessage(m) });

// ---- knobs: every slider becomes a rotary control; the LCD shows its name and value while it moves ----
let lcdTimer = 0;
mountKnobs(app, (name, value) => {
  $("lcd3").textContent = `${name}: ${value}`;
  clearTimeout(lcdTimer);
  lcdTimer = window.setTimeout(() => ($("lcd3").textContent = ""), 1800);
});

// ---- performance layer ----
const padLit = new Set<number>();
function padShow(e: number, on: boolean): void {
  if (on) padLit.add(e); else padLit.delete(e);
  app.querySelector(`.pad[data-e="${e}"]`)?.classList.toggle("on", on);
}
const padsEl = $("pads");
const latch = () => $<HTMLInputElement>("pf-latch").checked;
padsEl.addEventListener("pointerdown", (ev) => {
  const b = (ev.target as HTMLElement).closest<HTMLElement>(".pad");
  if (!b) return;
  const e = Number(b.dataset.e);
  node?.port.postMessage({ type: "perf", effect: e, down: true });
  if (latch()) { padShow(e, !padLit.has(e)); return; }
  padsEl.setPointerCapture(ev.pointerId);
  b.dataset.pid = String(ev.pointerId);
  padShow(e, true);
});
const padUp = (ev: PointerEvent) => {
  padsEl.querySelectorAll<HTMLElement>(".pad").forEach((b) => {
    if (b.dataset.pid === String(ev.pointerId)) {
      delete b.dataset.pid;
      node?.port.postMessage({ type: "perf", effect: Number(b.dataset.e), down: false });
      padShow(Number(b.dataset.e), false);
    }
  });
};
padsEl.addEventListener("pointerup", padUp);
padsEl.addEventListener("pointercancel", padUp);
app.querySelectorAll<HTMLInputElement>("[data-pk]").forEach((el) =>
  el.addEventListener("input", () => node?.port.postMessage({ type: "perfK", index: Number(el.dataset.pk), value: Number(el.value) })));
$<HTMLInputElement>("pf-latch").addEventListener("change", (ev) => {
  node?.port.postMessage({ type: "perfLatch", on: (ev.target as HTMLInputElement).checked });
  if (!(ev.target as HTMLInputElement).checked) { node?.port.postMessage({ type: "perfKill" }); [...padLit].forEach((e) => padShow(e, false)); }
});
$("pf-off").addEventListener("click", () => { node?.port.postMessage({ type: "perfKill" }); [...padLit].forEach((e) => padShow(e, false)); });

// ---- live input and the on-screen keyboard ----
const KEYS = "awsedftgyhujk";
let octave = 0;
const down = new Map<string, number>();
const keysEl = $("keys");
const KEY_BASE = 48; // C3 at octave 0; two octaves and a C
const NKEYS = 25;
function buildKeys(): void {
  const white = [0, 2, 4, 5, 7, 9, 11];
  let html = "", wi = 0;
  const nw = Array.from({ length: NKEYS }, (_, i) => i).filter((i) => white.includes(i % 12)).length;
  for (let i = 0; i < NKEYS; i++) {
    const black = !white.includes(i % 12);
    if (!black) html += `<div class="k w" data-i="${i}" style="left:${(wi / nw) * 100}%;width:${100 / nw}%"><span>${i % 12 === 0 ? "C" + (Math.floor((KEY_BASE + i) / 12) - 1) : ""}</span></div>`;
    else html += `<div class="k b" data-i="${i}" style="left:${((wi - 0.3) / nw) * 100}%;width:${(0.6 / nw) * 100}%"></div>`;
    if (!black) wi++;
  }
  keysEl.innerHTML = html;
}
buildKeys();
const base = () => KEY_BASE + octave * 12;
function lit(note: number, on: boolean): void {
  const i = note - base();
  keysEl.querySelector(`[data-i="${i}"]`)?.classList.toggle("on", on);
}
function noteOn(note: number, vel = 100): void { node?.port.postMessage({ type: "noteOn", note, vel }); lit(note, true); lcdNote(`${noteName(note)}  v${vel}`); }
function noteOff(note: number): void { node?.port.postMessage({ type: "noteOff", note }); lit(note, false); }
function setOctave(o: number): void {
  octave = Math.max(-3, Math.min(3, o));
  $("octv").textContent = noteName(base());
}
setOctave(0);
$("octd").onclick = () => setOctave(octave - 1);
$("octu").onclick = () => setOctave(octave + 1);
const held = new Map<number, number>(); // pointer id -> note
keysEl.addEventListener("pointerdown", (e) => {
  const k = (e.target as HTMLElement).closest<HTMLElement>(".k");
  if (!k) return;
  e.preventDefault();
  keysEl.setPointerCapture(e.pointerId);
  const r = k.getBoundingClientRect();
  const vel = Math.round(40 + 87 * Math.min(1, Math.max(0, (e.clientY - r.top) / r.height)));
  const note = base() + Number(k.dataset.i);
  held.set(e.pointerId, note);
  noteOn(note, vel);
});
const release = (e: PointerEvent) => {
  const n = held.get(e.pointerId);
  if (n !== undefined) { held.delete(e.pointerId); noteOff(n); }
};
keysEl.addEventListener("pointerup", release);
keysEl.addEventListener("pointercancel", release);
addEventListener("keydown", (e) => {
  if (e.repeat || e.metaKey || e.ctrlKey || (e.target as HTMLElement).matches("input, select")) return;
  const k = e.key.toLowerCase();
  if (k === "z") setOctave(octave - 1);
  else if (k === "x") setOctave(octave + 1);
  const i = KEYS.indexOf(k);
  if (i >= 0 && !down.has(k)) {
    const note = 60 + octave * 12 + i;
    down.set(k, note);
    noteOn(note);
  }
});
addEventListener("keyup", (e) => {
  const k = e.key.toLowerCase();
  const note = down.get(k);
  if (note !== undefined) { down.delete(k); noteOff(note); }
});

async function connectMidi(): Promise<void> {
  if (!navigator.requestMIDIAccess) return;
  try {
    const access = await navigator.requestMIDIAccess();
    const hook = () => access.inputs.forEach((input) => {
      input.onmidimessage = (m) => {
        const [st, d1, d2] = m.data!;
        const cmd = st & 0xf0;
        if (cmd === 0x90 && d2 > 0) noteOn(d1, d2);
        else if (cmd === 0x80 || (cmd === 0x90 && d2 === 0)) noteOff(d1);
      };
    });
    hook();
    access.onstatechange = hook;
    status.textContent = access.inputs.size ? "MIDI connected." : "No MIDI input found.";
  } catch {
    status.textContent = "MIDI access was not granted.";
  }
}

startBtn.onclick = async () => {
  const ctx = new AudioContext();
  await ctx.audioWorklet.addModule(workletUrl);
  node = new AudioWorkletNode(ctx, "synth", { outputChannelCount: [2] });
  node.connect(ctx.destination);
  choose(current);
  node.port.postMessage({ type: "liveMod", mod: liveMod });
  node.port.onmessage = (e) => seq.onMessage(e.data);
  seq.sync();
  startBtn.disabled = true;
  select.disabled = false;
  $<HTMLButtonElement>("sq-play").disabled = false;
  void connectMidi();
};
