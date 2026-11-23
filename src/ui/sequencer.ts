import { LibraryEntry } from "../instruments";
import { Instrument } from "../synth/synth";
import { DTIME_NAMES, RTYPE_NAMES } from "../fx/fx";
import {
  clonePattern, defaultSong, MixSetup, emptyPattern, MAX_ARRANGEMENT, MAX_PATTERNS, MAX_STEPS, sanitizeSong, Song, Step, TRACKS,
} from "../seq/song";

const KEY = "websynth.song.v1";
const NAMES = ["C", "C#", "D", "D#", "E", "F", "F#", "G", "G#", "A", "A#", "B"];
const noteName = (n: number) => NAMES[n % 12] + (Math.floor(n / 12) - 1);
const isBlack = (n: number) => [1, 3, 6, 8, 10].includes(n % 12);
const VELS = [50, 80, 100, 127];
const GATES = [0.5, 0.9, 1.8, 3.6, 7.5];
const ROWS = 24;
const MIX_KEYS: [keyof MixSetup, string, number, number][] = [
  ["level", "Level", 0, 127], ["pan", "Pan", -64, 63], ["dist", "Dist", 0, 127], ["chorus", "Chorus", 0, 127], ["delay", "Delay", 0, 127], ["reverb", "Reverb", 0, 127],
];

export interface SequencerDeps {
  library: () => LibraryEntry[];
  send: (msg: Record<string, unknown>) => void;
}

function load(): Song {
  try {
    const raw = localStorage.getItem(KEY);
    if (raw) {
      const s = sanitizeSong(JSON.parse(raw));
      if (s) return s;
    }
  } catch {
    // fall through to the default song
  }
  return defaultSong();
}

/** Mounts the step grid editor, the pattern bank and the pattern sequencer (arrangement) into root. */
export function mountSequencer(root: HTMLElement, deps: SequencerDeps) {
  let song = load();
  let track = 0;
  let pat = 0;
  let base = 48; // lowest row of the piano roll
  let arrSel = -1;
  let mode: "pattern" | "song" = "song";
  let playing = false;
  let playPattern = -1;
  let playStep = -1;
  let playArr = -1;

  root.innerHTML = `
    <div class="seq-bar">
      <button id="sq-play" disabled>Play</button>
      <select id="sq-mode"><option value="song">Song</option><option value="pattern">Pattern loop</option></select>
      <label>BPM <input id="sq-bpm" type="number" min="40" max="240"></label>
      <label>Swing <input id="sq-swing" type="range" min="0" max="50"></label>
      <button id="sq-export">Export song</button>
      <label class="file">Import song <input id="sq-import" type="file" accept=".json"></label>
      <button id="sq-reset">Reset to demo song</button>
    </div>
    <div id="sq-tracks" class="seq-tracks"></div>
    <details class="fxp"><summary>Effects</summary><div id="sq-fx" class="seq-bar"></div></details>
    <div class="seq-bar" id="sq-patbar"></div>
    <div class="seq-bar">
      <label>Name <input id="sq-name" maxlength="16"></label>
      <label>Length <select id="sq-len"><option>8</option><option>16</option><option>24</option><option>32</option></select></label>
      <button id="sq-add">New pattern</button>
      <button id="sq-dup">Duplicate</button>
      <button id="sq-clear">Clear track</button>
      <button id="sq-del">Delete</button>
      <button id="sq-oct-d">Octave −</button><button id="sq-oct-u">Octave +</button>
    </div>
    <div class="roll-wrap"><div id="sq-roll" class="roll"></div></div>
    <h3>Pattern sequencer</h3>
    <div class="seq-bar"><span id="sq-arr" class="arr"></span></div>
    <div class="seq-bar">
      <button id="sq-arr-add">Append selected pattern</button>
      <button id="sq-arr-left">◀ Move</button><button id="sq-arr-right">Move ▶</button>
      <button id="sq-arr-del">Remove</button>
    </div>`;

  const $ = <T extends HTMLElement>(id: string) => root.querySelector<T>("#" + id)!;

  function instruments(): Instrument[] {
    const lib = deps.library();
    return song.tracks.map((t) => (lib.find((p) => p.id === t.patch) ?? lib[0]).instrument);
  }
  function commit(sendPatches = false): void {
    try { localStorage.setItem(KEY, JSON.stringify(song)); } catch { /* storage unavailable */ }
    deps.send({ type: "song", song, instruments: sendPatches ? instruments() : undefined });
  }
  const cur = () => song.patterns[pat];

  function preview(note: number, vel = 100): void {
    deps.send({ type: "trackNoteOn", track, note, vel });
    setTimeout(() => deps.send({ type: "trackNoteOff", track, note }), 220);
  }

  function renderTracks(): void {
    const lib = deps.library();
    $("sq-tracks").innerHTML = song.tracks
      .map((t, i) => {
        const banks = [...new Set(lib.map((p) => p.bank))];
        const opts = banks
          .map((b) => `<optgroup label="${b}">${lib.filter((p) => p.bank === b).map((p) => `<option value="${p.id}"${p.id === t.patch ? " selected" : ""}>${p.name}</option>`).join("")}</optgroup>`)
          .join("");
        return `<div class="trk${i === track ? " sel" : ""}" data-t="${i}">
          <button data-act="sel">Track ${i + 1}</button>
          <select data-act="patch">${opts}</select>
          <button data-act="mute" class="${t.mute ? "off" : ""}">${t.mute ? "Muted" : "Mute"}</button>
          <div class="mix">${MIX_KEYS.map(([k, label, lo, hi]) => `<label>${label}<input type="range" data-mix="${k}" min="${lo}" max="${hi}" value="${t[k]}"></label>`).join("")}</div></div>`;
      })
      .join("");
  }

  function renderFx(): void {
    const f = song.fx;
    const sl = (k: keyof typeof f, label: string, lo: number, hi: number) => `<label>${label}<input type="range" data-fx="${k}" min="${lo}" max="${hi}" value="${f[k]}"></label>`;
    $("sq-fx").innerHTML = `
      <label>Delay time <select data-fx="dtime">${DTIME_NAMES.map((n, i) => `<option value="${i}"${f.dtime === i ? " selected" : ""}>${n}</option>`).join("")}</select></label>
      ${sl("dfdbk", "Feedback", 0, 120)}${sl("dcolor", "Color", 0, 127)}${sl("dmix", "Delay mix", 0, 127)}
      <label>Reverb <select data-fx="rtype">${RTYPE_NAMES.map((n, i) => `<option value="${i}"${f.rtype === i ? " selected" : ""}>${n}</option>`).join("")}</select></label>
      ${sl("rsize", "Size", 0, 127)}${sl("rdamp", "Damp", 0, 127)}${sl("crate", "Chorus rate", 0, 127)}${sl("cdepth", "Chorus depth", 0, 127)}`;
  }

  function renderPatterns(): void {
    $("sq-patbar").innerHTML =
      song.patterns.map((p, i) => `<button data-p="${i}" class="pbtn${i === pat ? " sel" : ""}">${i + 1}. ${p.name}</button>`).join("");
    ($<HTMLInputElement>("sq-name")).value = cur().name;
    ($<HTMLSelectElement>("sq-len")).value = String(cur().length);
    ($<HTMLInputElement>("sq-bpm")).value = String(song.bpm);
    ($<HTMLInputElement>("sq-swing")).value = String(Math.round(song.swing * 100));
  }

  const DRUM_LANES: Record<number, string> = { 36: "KICK", 37: "RIM", 38: "SNARE", 39: "CLAP", 42: "HAT CL", 45: "TOM", 46: "HAT OP", 56: "BELL" };

  function renderRoll(): void {
    const isDrum = deps.library().find((p) => p.id === song.tracks[track].patch)?.instrument.kind === "drum";
    const len = cur().length;
    const steps = cur().steps[track];
    let html = `<div class="rl" style="--cols:${len}">`;
    for (let r = ROWS - 1; r >= 0; r--) {
      const n = base + r;
      const label = isDrum ? DRUM_LANES[n] ?? "" : n % 12 === 0 ? noteName(n) : "";
      html += `<div class="lab${isBlack(n) ? " blk" : ""}">${label}</div>`;
      for (let s = 0; s < len; s++) {
        const on = steps[s]?.notes.includes(n);
        html += `<div class="c${on ? " on" : ""}${isBlack(n) ? " blk" : ""}${s % 4 === 0 ? " beat" : ""}" data-n="${n}" data-s="${s}"></div>`;
      }
    }
    html += `<div class="lab small">vel</div>`;
    for (let s = 0; s < len; s++) {
      const st = steps[s];
      html += `<div class="v" data-vs="${s}">${st ? `<i style="height:${Math.round(((st.vel ?? 100) / 127) * 100)}%"></i>` : ""}</div>`;
    }
    html += `<div class="lab small">gate</div>`;
    for (let s = 0; s < len; s++) html += `<div class="g" data-gs="${s}">${steps[s] ? (steps[s]!.gate ?? 0.9) : ""}</div>`;
    root.querySelector("#sq-roll")!.innerHTML = html + "</div>";
    markPlayhead();
  }

  function renderArr(): void {
    $("sq-arr").innerHTML = song.arrangement
      .map((p, i) => `<button data-a="${i}" class="chip${i === arrSel ? " sel" : ""}${playing && mode === "song" && i === playArr ? " now" : ""}">${i + 1}: ${song.patterns[p]?.name ?? "?"}</button>`)
      .join("");
  }

  function markPlayhead(): void {
    root.querySelectorAll(".play").forEach((el) => el.classList.remove("play"));
    if (!playing || playStep < 0) return;
    const showing = mode === "song" ? playPattern === pat : pat === playPattern;
    if (showing) root.querySelectorAll(`[data-s="${playStep}"],[data-vs="${playStep}"],[data-gs="${playStep}"]`).forEach((el) => el.classList.add("play"));
    renderArrNow();
  }
  function renderArrNow(): void {
    root.querySelectorAll<HTMLElement>(".chip").forEach((el) => el.classList.toggle("now", playing && mode === "song" && Number(el.dataset.a) === playArr));
  }

  function renderAll(): void {
    renderFx();
    renderTracks();
    renderPatterns();
    renderRoll();
    renderArr();
  }

  // ---- events ----
  root.addEventListener("click", (e) => {
    const el = e.target as HTMLElement;
    const cell = el.closest<HTMLElement>(".c");
    if (cell) {
      const n = Number(cell.dataset.n), s = Number(cell.dataset.s);
      const steps = cur().steps[track];
      const st = steps[s];
      if (st?.notes.includes(n)) {
        st.notes = st.notes.filter((x) => x !== n);
        if (!st.notes.length) steps[s] = null;
      } else {
        if (st) st.notes.push(n);
        else steps[s] = { notes: [n], vel: 100, gate: 0.9 };
        preview(n, steps[s]!.vel);
      }
      commit();
      renderRoll();
      return;
    }
    const v = el.closest<HTMLElement>("[data-vs]");
    if (v) {
      const st = cur().steps[track][Number(v.dataset.vs)];
      if (st) { st.vel = VELS[(VELS.findIndex((x) => x >= (st.vel ?? 100)) + 1) % VELS.length]; commit(); renderRoll(); }
      return;
    }
    const g = el.closest<HTMLElement>("[data-gs]");
    if (g) {
      const st = cur().steps[track][Number(g.dataset.gs)];
      if (st) { st.gate = GATES[(GATES.findIndex((x) => x >= (st.gate ?? 0.9)) + 1) % GATES.length]; commit(); renderRoll(); }
      return;
    }
    const trk = el.closest<HTMLElement>(".trk");
    if (trk && el.dataset.act) {
      const i = Number(trk.dataset.t);
      if (el.dataset.act === "sel") { track = i; renderTracks(); renderRoll(); }
      if (el.dataset.act === "mute") { song.tracks[i].mute = !song.tracks[i].mute; commit(); renderTracks(); }
      return;
    }
    const pb = el.closest<HTMLElement>("[data-p]");
    if (pb) { pat = Number(pb.dataset.p); if (mode === "pattern") deps.send({ type: "mode", mode, pattern: pat }); renderPatterns(); renderRoll(); return; }
    const chip = el.closest<HTMLElement>("[data-a]");
    if (chip) { arrSel = Number(chip.dataset.a); pat = song.arrangement[arrSel]; renderAll(); return; }
  });

  root.addEventListener("input", (e) => {
    const el = e.target as HTMLInputElement;
    const trk = el.closest<HTMLElement>(".trk");
    if (trk && el.dataset.mix) {
      (song.tracks[Number(trk.dataset.t)] as unknown as Record<string, number>)[el.dataset.mix] = Number(el.value);
      commit();
    } else if (el.dataset.fx && el.type === "range") {
      (song.fx as unknown as Record<string, number>)[el.dataset.fx] = Number(el.value);
      commit();
    }
  });

  root.addEventListener("change", (e) => {
    const el = e.target as HTMLElement;
    const trk = el.closest<HTMLElement>(".trk");
    if (trk && el.dataset.act === "patch") {
      const i = Number(trk.dataset.t);
      const id = (el as HTMLSelectElement).value;
      song.tracks[i].patch = id;
      const inst = deps.library().find((p) => p.id === id)?.instrument;
      if (inst?.kind === "drum") base = 36;
      if ((inst?.kind === "engine" || inst?.kind === "drum") && inst.fx) {
        // a preset brings its own distortion and sends (as in Felucca)
        const [dist, chorus, delay, reverb] = inst.fx;
        Object.assign(song.tracks[i], { dist, chorus, delay, reverb });
        renderTracks();
      }
      commit(true);
    } else if (el.dataset.fx && (el as HTMLSelectElement).tagName === "SELECT") {
      (song.fx as unknown as Record<string, number>)[el.dataset.fx] = Number((el as HTMLSelectElement).value);
      commit();
    }
  });

  $("sq-play").onclick = () => {
    playing = !playing;
    $("sq-play").textContent = playing ? "Stop" : "Play";
    if (playing) { commit(true); deps.send({ type: "mode", mode, pattern: pat }); deps.send({ type: "play" }); }
    else { deps.send({ type: "stop" }); markPlayhead(); renderArr(); }
  };
  ($<HTMLSelectElement>("sq-mode")).onchange = (e) => {
    mode = (e.target as HTMLSelectElement).value as "pattern" | "song";
    deps.send({ type: "mode", mode, pattern: pat });
  };
  ($<HTMLInputElement>("sq-bpm")).onchange = (e) => { song.bpm = Math.min(240, Math.max(40, Number((e.target as HTMLInputElement).value) || 104)); commit(); };
  ($<HTMLInputElement>("sq-swing")).oninput = (e) => { song.swing = Number((e.target as HTMLInputElement).value) / 100; commit(); };
  ($<HTMLInputElement>("sq-name")).onchange = (e) => { cur().name = (e.target as HTMLInputElement).value || "Pattern"; commit(); renderPatterns(); renderArr(); };
  ($<HTMLSelectElement>("sq-len")).onchange = (e) => { cur().length = Number((e.target as HTMLSelectElement).value); commit(); renderRoll(); };
  $("sq-add").onclick = () => {
    if (song.patterns.length >= MAX_PATTERNS) return;
    song.patterns.push(emptyPattern(`New ${song.patterns.length + 1}`));
    pat = song.patterns.length - 1;
    commit(); renderAll();
  };
  $("sq-dup").onclick = () => {
    if (song.patterns.length >= MAX_PATTERNS) return;
    song.patterns.push(clonePattern(cur(), `${cur().name} copy`.slice(0, 16)));
    pat = song.patterns.length - 1;
    commit(); renderAll();
  };
  $("sq-clear").onclick = () => { cur().steps[track] = Array<Step>(MAX_STEPS).fill(null); commit(); renderRoll(); };
  $("sq-del").onclick = () => {
    if (song.patterns.length <= 1) return;
    song.patterns.splice(pat, 1);
    song.arrangement = song.arrangement.filter((p) => p !== pat).map((p) => (p > pat ? p - 1 : p));
    if (!song.arrangement.length) song.arrangement = [0];
    pat = Math.min(pat, song.patterns.length - 1);
    arrSel = -1;
    commit(); renderAll();
  };
  $("sq-oct-d").onclick = () => { base = Math.max(12, base - 12); renderRoll(); };
  $("sq-oct-u").onclick = () => { base = Math.min(96, base + 12); renderRoll(); };
  $("sq-arr-add").onclick = () => {
    if (song.arrangement.length >= MAX_ARRANGEMENT) return;
    song.arrangement.push(pat);
    arrSel = song.arrangement.length - 1;
    commit(); renderArr();
  };
  $("sq-arr-del").onclick = () => {
    if (arrSel < 0 || song.arrangement.length <= 1) return;
    song.arrangement.splice(arrSel, 1);
    arrSel = Math.min(arrSel, song.arrangement.length - 1);
    commit(); renderArr();
  };
  const move = (d: number) => {
    const j = arrSel + d;
    if (arrSel < 0 || j < 0 || j >= song.arrangement.length) return;
    [song.arrangement[arrSel], song.arrangement[j]] = [song.arrangement[j], song.arrangement[arrSel]];
    arrSel = j;
    commit(); renderArr();
  };
  $("sq-arr-left").onclick = () => move(-1);
  $("sq-arr-right").onclick = () => move(1);
  $("sq-export").onclick = () => {
    const a = document.createElement("a");
    a.href = URL.createObjectURL(new Blob([JSON.stringify(song, null, 1)], { type: "application/json" }));
    a.download = "websynth-song.json";
    a.click();
  };
  ($<HTMLInputElement>("sq-import")).onchange = async (e) => {
    const f = (e.target as HTMLInputElement).files?.[0];
    if (!f) return;
    try {
      const s = sanitizeSong(JSON.parse(await f.text()));
      if (!s) return;
      song = s; pat = 0; track = 0; arrSel = -1;
      commit(true); renderAll();
    } catch { /* not a song file */ }
  };
  $("sq-reset").onclick = () => { song = defaultSong(); pat = 0; track = 0; arrSel = -1; commit(true); renderAll(); };

  renderAll();

  return {
    /** Sends the song and patches to a freshly started engine. */
    sync(): void { commit(true); deps.send({ type: "mode", mode, pattern: pat }); },
    /** Re-reads the patch list (after an import). */
    refreshLibrary(): void { renderTracks(); },
    onMessage(m: { type: string; pattern?: number; step?: number; arrPos?: number }): void {
      if (m.type === "pos") {
        playPattern = m.pattern ?? 0; playStep = m.step ?? 0; playArr = m.arrPos ?? 0;
        markPlayhead();
      } else if (m.type === "stopped") {
        playing = false; playStep = -1;
        $("sq-play").textContent = "Play";
        markPlayhead();
      }
    },
    TRACKS,
  };
}
