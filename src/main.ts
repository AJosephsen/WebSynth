import workletUrl from "./worklet/processor.ts?worker&url";
import { encodeWav } from "./wav";
import { SAMPLE_RATE, snippets } from "./snippets";
import { factoryPatches, loadSysex, LibraryPatch } from "./fm6/library";

const app = document.querySelector<HTMLDivElement>("#app")!;
app.innerHTML = `
  <h1>WebSynth</h1>
  <section><h2>Live</h2>
    <button id="start">Start audio</button>
    <select id="patch" disabled></select>
    <button id="note" disabled>Hold to play</button>
    <label>Load DX7 .syx <input id="syx" type="file" accept=".syx"></label>
  </section>
  <section><h2>Snippets</h2><div id="snips"></div></section>`;

const snips = app.querySelector<HTMLDivElement>("#snips")!;
for (const s of snippets) {
  const samples = s.render();
  const url = URL.createObjectURL(encodeWav(samples, SAMPLE_RATE));
  const row = document.createElement("div");
  row.style.margin = "8px 0";
  row.innerHTML = `<strong>${s.step}</strong> — ${s.title}<br><audio controls src="${url}"></audio>`;
  snips.append(row);
}

let node: AudioWorkletNode | undefined;
let library: LibraryPatch[] = [...factoryPatches];
let current = library[1];
const startBtn = app.querySelector<HTMLButtonElement>("#start")!;
const noteBtn = app.querySelector<HTMLButtonElement>("#note")!;
const select = app.querySelector<HTMLSelectElement>("#patch")!;
const syx = app.querySelector<HTMLInputElement>("#syx")!;

function fillSelect(): void {
  select.innerHTML = library.map((p, i) => `<option value="${i}">${p.name}</option>`).join("");
  select.value = String(library.indexOf(current));
}
function choose(p: LibraryPatch): void {
  current = p;
  node?.port.postMessage({ type: "patch", patch: p.patch });
}
fillSelect();

startBtn.onclick = async () => {
  const ctx = new AudioContext();
  await ctx.audioWorklet.addModule(workletUrl);
  node = new AudioWorkletNode(ctx, "synth");
  node.connect(ctx.destination);
  choose(current);
  startBtn.disabled = true;
  noteBtn.disabled = false;
  select.disabled = false;
};
select.onchange = () => choose(library[Number(select.value)]);
syx.onchange = async () => {
  const file = syx.files?.[0];
  if (!file) return;
  const voices = loadSysex(new Uint8Array(await file.arrayBuffer()));
  if (voices.length) {
    library = [...factoryPatches, ...voices];
    fillSelect();
  }
};
noteBtn.onpointerdown = () => node?.port.postMessage({ type: "noteOn", note: current.note });
noteBtn.onpointerup = noteBtn.onpointerleave = () => node?.port.postMessage({ type: "noteOff" });
