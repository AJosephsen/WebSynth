import workletUrl from "./worklet/processor.ts?worker&url";
import { encodeWav } from "./wav";
import { SAMPLE_RATE, snippets } from "./snippets";
import { mountSequencer } from "./ui/sequencer";
import { exportBank, factoryPatches, LibraryPatch, loadSysex, loadUserPatches, saveUserPatches } from "./fm6/library";

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
  <section><h2>Sequencer</h2><div id="seq"></div></section>
  <section><h2>Snippets</h2><div id="snips"></div></section>`;

const $ = <T extends HTMLElement>(id: string) => app.querySelector<T>("#" + id)!;
const startBtn = $<HTMLButtonElement>("start");
const select = $<HTMLSelectElement>("patch");
const syx = $<HTMLInputElement>("syx");
const status = $("status");

// ---- snippets ----
const snips = $("snips");
for (const s of snippets) {
  const url = URL.createObjectURL(encodeWav(s.render(), SAMPLE_RATE));
  const row = document.createElement("div");
  row.style.margin = "8px 0";
  row.innerHTML = `<strong>${s.step}</strong> — ${s.title}<br><audio controls src="${url}"></audio>`;
  snips.append(row);
}

// ---- library ----
let library: LibraryPatch[] = [...factoryPatches, ...loadUserPatches()];
let current = library[1];
let node: AudioWorkletNode | undefined;

function fillSelect(): void {
  const banks = [...new Set(library.map((p) => p.bank))];
  select.innerHTML = banks
    .map((b) => `<optgroup label="${b}">${library.map((p, i) => (p.bank === b ? `<option value="${i}">${p.name}</option>` : "")).join("")}</optgroup>`)
    .join("");
  select.value = String(library.indexOf(current));
}
function choose(p: LibraryPatch): void {
  current = p;
  node?.port.postMessage({ type: "patch", patch: p.patch });
}
fillSelect();
select.onchange = () => choose(library[Number(select.value)]);
syx.onchange = async () => {
  const file = syx.files?.[0];
  if (!file) return;
  const voices = loadSysex(new Uint8Array(await file.arrayBuffer()));
  if (!voices.length) { status.textContent = "No DX7 voices found in that file."; return; }
  library = [...library, ...voices];
  saveUserPatches(library);
  fillSelect();
  seq.refreshLibrary();
  status.textContent = `Imported ${voices.length} voice${voices.length > 1 ? "s" : ""}.`;
};
$<HTMLButtonElement>("export").onclick = () => {
  const bytes = exportBank(library.filter((p) => p.source === "user").length ? library.filter((p) => p.source === "user") : library);
  const a = document.createElement("a");
  a.href = URL.createObjectURL(new Blob([bytes as BlobPart], { type: "application/octet-stream" }));
  a.download = "websynth-bank.syx";
  a.click();
};
$<HTMLButtonElement>("delete").onclick = () => {
  if (current.source !== "user") { status.textContent = "Factory patches cannot be deleted."; return; }
  library = library.filter((p) => p !== current);
  current = library[1];
  saveUserPatches(library);
  fillSelect();
  seq.refreshLibrary();
  choose(current);
};

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
  node = new AudioWorkletNode(ctx, "synth");
  node.connect(ctx.destination);
  choose(current);
  node.port.onmessage = (e) => seq.onMessage(e.data);
  seq.sync();
  startBtn.disabled = true;
  select.disabled = false;
  $<HTMLButtonElement>("sq-play").disabled = false;
  void connectMidi();
};
