import workletUrl from "./worklet/processor.ts?worker&url";
import { mountSequencer } from "./ui/sequencer";
import { mountPatchEditor } from "./ui/patcheditor";
import { patchName } from "./fm6/patch";
import { exportBank, loadSysex, loadUserPatches, saveUserPatches, toLibraryPatch } from "./fm6/library";
import { factoryEntries, fm6Entry, LibraryEntry, loadUserEngineEntries, saveUserEngineEntries, userEngineEntry } from "./instruments";
import { mountEngineEditor } from "./ui/engineeditor";

const app = document.querySelector<HTMLDivElement>("#app")!;
app.innerHTML = `
  <h1>WebSynth</h1>
  <section><h2>Live</h2>
    <button id="start">Start audio</button>
    <span id="status"></span>
    <p>Play with the keys A W S E D F T G Y H U J K (C4 upward), Z and X shift the octave, or use a MIDI keyboard.</p>
  </section>
  <section><h2>Patch library</h2>
    <select id="patch" size="12" disabled></select>
    <div>
      <label>Import DX7 .syx <input id="syx" type="file" accept=".syx"></label>
      <button id="export">Export bank (.syx)</button>
      <button id="delete">Delete user patch</button>
    </div>
  </section>
  <section><h2>Patch editor</h2><div id="pe"></div><div id="ee"></div></section>
  <section><h2>Sequencer</h2><div id="seq"></div></section>`;

const $ = <T extends HTMLElement>(id: string) => app.querySelector<T>("#" + id)!;
const startBtn = $<HTMLButtonElement>("start");
const select = $<HTMLSelectElement>("patch");
const syx = $<HTMLInputElement>("syx");
const status = $("status");

// ---- library ----
let library: LibraryEntry[] = [...factoryEntries, ...loadUserPatches().map(fm6Entry), ...loadUserEngineEntries()];
let current = library.find((e) => e.id === "TINE EP") ?? library[0];
let node: AudioWorkletNode | undefined;

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
  node?.port.postMessage({ type: "instrument", instrument: e.instrument });
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
  onChange: (patch) => node?.port.postMessage({ type: "instrument", instrument: { kind: "fm6", patch } }),
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
  onChange: (inst) => node?.port.postMessage({ type: "instrument", instrument: inst }),
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

// ---- live input ----
const KEYS = "awsedftgyhujk";
let octave = 0;
const down = new Map<string, number>();
function noteOn(note: number, vel = 100): void { node?.port.postMessage({ type: "noteOn", note, vel }); }
function noteOff(note: number): void { node?.port.postMessage({ type: "noteOff", note }); }
addEventListener("keydown", (e) => {
  if (e.repeat || e.metaKey || e.ctrlKey || (e.target as HTMLElement).matches("input, select")) return;
  const k = e.key.toLowerCase();
  if (k === "z") octave = Math.max(-3, octave - 1);
  else if (k === "x") octave = Math.min(3, octave + 1);
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
  node.port.onmessage = (e) => seq.onMessage(e.data);
  seq.sync();
  startBtn.disabled = true;
  select.disabled = false;
  $<HTMLButtonElement>("sq-play").disabled = false;
  void connectMidi();
};
