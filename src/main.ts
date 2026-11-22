import workletUrl from "./worklet/processor.ts?worker&url";
import { encodeWav } from "./wav";
import { SAMPLE_RATE, snippets } from "./snippets";

const app = document.querySelector<HTMLDivElement>("#app")!;
app.innerHTML = `
  <h1>WebSynth</h1>
  <section><h2>Live</h2>
    <button id="start">Start audio</button>
    <button id="note" disabled>Hold to play A4</button>
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
const startBtn = app.querySelector<HTMLButtonElement>("#start")!;
const noteBtn = app.querySelector<HTMLButtonElement>("#note")!;

startBtn.onclick = async () => {
  const ctx = new AudioContext();
  await ctx.audioWorklet.addModule(workletUrl);
  node = new AudioWorkletNode(ctx, "synth");
  node.connect(ctx.destination);
  startBtn.disabled = true;
  noteBtn.disabled = false;
};
noteBtn.onpointerdown = () => node?.port.postMessage({ type: "noteOn", freq: 440 });
noteBtn.onpointerup = noteBtn.onpointerleave = () => node?.port.postMessage({ type: "noteOff" });
