import { LibraryEntry } from "../instruments";
import { Instrument } from "../synth/synth";
import { DTIME_NAMES, RTYPE_NAMES } from "../fx/fx";
import { INSERT_NAMES, insertLabels } from "../fx/insert";
import { engineById } from "../engines/registry";
import { defaultMod } from "../mod/setup";
import { demoSongs } from "../seq/songs";
import { ARP_RATES } from "../synth/arp";
import { applyModInput, modPanelHtml } from "./modpanel";
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
const NUDGES = [0, -4, -2, 2, 4];
const PROBS = [0, 75, 50, 25, 102, 103, 104, 105, 106, 107, 108, 109, 110, 111, 112];
const COND_TXT = ["1:2", "2:2", "1:3", "2:3", "3:3", "1:4", "2:4", "3:4", "4:4", "FILL", "!FILL"];
const probText = (p?: number): string => (!p ? "·" : p >= 102 ? COND_TXT[p - 102] : `${p}%`);
const cycle = <T,>(list: T[], v: T): T => list[(list.indexOf(v) + 1) % list.length];
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
  const modOpen = new Set<number>();

  root.innerHTML = `
    <section class="module transport"><h4>Transport</h4>
      <div class="tp">
        <button id="sq-play" class="playbtn" disabled>Play</button>
        <label class="kc"><span>Mode</span><select id="sq-mode"><option value="song">Song</option><option value="pattern">Pattern loop</option></select></label>
        <label class="kc"><span>Tempo</span><input id="sq-bpm" type="range" min="40" max="240"><output id="sq-bpmo"></output></label>
        <label class="kc"><span>Swing</span><input id="sq-swing" type="range" min="0" max="50"><output id="sq-swingo"></output></label>
        <div class="tpfile">
          <button id="sq-export">Export song</button>
          <label class="file">Import song <input id="sq-import" type="file" accept=".json"></label>
          <label class="file">Demo songs <select id="sq-demo"><option value="">Load a demo song…</option>${demoSongs.map((d) => `<option value="${d.id}">${d.title} · ${d.genre}</option>`).join("")}</select></label>
          <button id="sq-reset">Reset to default song</button>
        </div>
      </div>
    </section>
    <section class="module"><h4>Channels</h4><div id="sq-tracks" class="seq-tracks"></div></section>
    <details class="fxp module"><summary>Master effects</summary><div id="sq-fx" class="knobs"></div></details>
    <section class="module"><h4>Patterns</h4>
      <div class="seq-bar" id="sq-patbar"></div>
      <div class="seq-bar">
        <label>Name <input id="sq-name" maxlength="16"></label>
        <label>Track length <select id="sq-tlen">${Array.from({ length: 32 }, (_, k) => `<option>${k + 1}</option>`).join("")}</select></label>
        <label>Length <select id="sq-len"><option>8</option><option>16</option><option>24</option><option>32</option></select></label>
        <button id="sq-add">New pattern</button>
        <button id="sq-dup">Duplicate</button>
        <button id="sq-clear">Clear track</button>
        <button id="sq-del">Delete</button>
        <button id="sq-oct-d">Octave −</button><button id="sq-oct-u">Octave +</button>
      </div>
      <div class="roll-wrap"><div id="sq-roll" class="roll"></div></div>
    </section>
    <section class="module"><h4>Pattern sequencer</h4>
      <div class="seq-bar"><span id="sq-arr" class="arr"></span></div>
      <div class="seq-bar">
        <button id="sq-arr-add">Append selected pattern</button>
        <button id="sq-arr-left">◀ Move</button><button id="sq-arr-right">Move ▶</button>
        <button id="sq-arr-del">Remove</button>
      </div>
    </section>`;

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

  function seqRow(t: Song["tracks"][number], i: number): string {
    void i;
    const q = t.seq ?? {};
    return `<div class="mix ins"><label class="kc wideSel"><span>Step div</span><select data-seq="div">${ARP_RATES.map((n, k) => `<option value="${k}"${(q.div ?? 2) === k ? " selected" : ""}>${n}</option>`).join("")}</select></label>
      <label class="kc"><span>Swing</span><input type="range" data-seq="swing" min="0" max="100" value="${q.swing ?? 0}"></label>
      <label class="kc"><span>Gate</span><input type="range" data-seq="gate" min="0" max="127" value="${q.gate ?? 115}"></label>
      <label class="kc"><span>Quantize</span><input type="checkbox" data-seq="quantize"${(q.quantize ?? 1) ? " checked" : ""}></label></div>`;
  }

  function modSection(t: Song["tracks"][number], i: number, lib: LibraryEntry[]): string {
    const inst = lib.find((p) => p.id === t.patch)?.instrument;
    const open = modOpen.has(i) ? " open" : "";
    if (inst?.kind !== "engine") return `<details class="modp" data-mod-t="${i}"${open}><summary>Modulation</summary><p class="hint">The LFO and modulation matrix act on the engine instruments (not FM6 or DRUM).</p></details>`;
    const labels = engineById(inst.engine)?.def.edit.map((d) => d.label) ?? [];
    return `<details class="modp" data-mod-t="${i}"${open}><summary>Modulation${t.mod ? " &bull;" : ""}</summary>${modPanelHtml(t.mod ?? defaultMod(), labels)}</details>`;
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
          <div class="mix">${MIX_KEYS.map(([k, label, lo, hi]) => `<label class="kc"><span>${label}</span><input type="range" data-mix="${k}" min="${lo}" max="${hi}" value="${t[k]}"></label>`).join("")}</div>
          <div class="mix ins"><label class="kc wideSel"><span>Insert</span><select data-mix="itype">${INSERT_NAMES.map((n, k) => `<option value="${k}"${t.itype === k ? " selected" : ""}>${n}</option>`).join("")}</select></label>${
            t.itype
              ? `<label class="kc"><span>Mix</span><input type="range" data-mix="imix" min="0" max="127" value="${t.imix}"></label>` +
                (["ia", "ib", "ic"] as const).map((k, n) => `<label class="kc"><span>${insertLabels(t.itype)[n]}</span><input type="range" data-mix="${k}" min="0" max="127" value="${t[k]}"></label>`).join("")
              : ""
          }</div>${seqRow(t, i)}${modSection(t, i, lib)}</div>`;
      })
      .join("");
  }

  function renderFx(): void {
    const f = song.fx;
    const sl = (k: keyof typeof f, label: string, lo: number, hi: number) => `<label class="kc"><span>${label}</span><input type="range" data-fx="${k}" min="${lo}" max="${hi}" value="${f[k]}"></label>`;
    $("sq-fx").innerHTML = `
      <label class="kc"><span>Delay time</span><select data-fx="dtime">${DTIME_NAMES.map((n, i) => `<option value="${i}"${f.dtime === i ? " selected" : ""}>${n}</option>`).join("")}</select></label>
      ${sl("dfdbk", "Feedback", 0, 120)}${sl("dcolor", "Color", 0, 127)}${sl("dmix", "Delay mix", 0, 127)}
      <label class="kc"><span>Reverb</span><select data-fx="rtype">${RTYPE_NAMES.map((n, i) => `<option value="${i}"${f.rtype === i ? " selected" : ""}>${n}</option>`).join("")}</select></label>
      ${sl("rsize", "Size", 0, 127)}${sl("rdamp", "Damp", 0, 127)}${sl("crate", "Chorus rate", 0, 127)}${sl("cdepth", "Chorus depth", 0, 127)}`;
  }

  function renderPatterns(): void {
    $("sq-patbar").innerHTML =
      song.patterns.map((p, i) => `<button data-p="${i}" class="pbtn${i === pat ? " sel" : ""}">${i + 1}. ${p.name}</button>`).join("");
    ($<HTMLInputElement>("sq-name")).value = cur().name;
    ($<HTMLSelectElement>("sq-len")).value = String(cur().length);
    const tl = $<HTMLSelectElement>("sq-tlen");
    tl.innerHTML = Array.from({ length: cur().length }, (_, k) => `<option>${k + 1}</option>`).join("");
    tl.value = String(Math.min(cur().length, cur().lens?.[track] ?? cur().length));
    ($<HTMLInputElement>("sq-bpm")).value = String(song.bpm);
    $("sq-bpmo").textContent = String(Math.round(song.bpm));
    ($<HTMLInputElement>("sq-swing")).value = String(Math.round(song.swing * 100));
    $("sq-swingo").textContent = `${Math.round(song.swing * 100)}%`;
  }

  const DRUM_LANES: Record<number, string> = { 36: "KICK", 37: "RIM", 38: "SNARE", 39: "CLAP", 42: "HAT CL", 45: "TOM", 46: "HAT OP", 56: "BELL" };

  function renderRoll(): void {
    const isDrum = deps.library().find((p) => p.id === song.tracks[track].patch)?.instrument.kind === "drum";
    const len = cur().length;
    const steps = cur().steps[track];
    let html = `<div class="rl" style="--cols:${len}">`;
    html += `<div class="lab small">step</div>`;
    for (let s = 0; s < len; s++) html += `<div class="led${s % 4 === 0 ? " beat" : ""}" data-s="${s}"></div>`;
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
    const fxRow = (key: string, label: string, show: (st: NonNullable<Step>) => string, onClass: (st: NonNullable<Step>) => boolean, always = false): void => {
      html += `<div class="lab small">${label}</div>`;
      for (let s = 0; s < len; s++) {
        const st = steps[s];
        html += `<div class="g f${st && onClass(st) ? " fon" : ""}" data-fs="${key}" data-s2="${s}">${st ? show(st) : always ? "·" : ""}</div>`;
      }
    };
    fxRow("acc", "acc", (st) => (st.accent ? "A" : "·"), (st) => !!st.accent);
    fxRow("sld", "slide", (st) => (st.slide ? "S" : "·"), (st) => !!st.slide);
    fxRow("tie", "tie", (st) => (st.tie ? "T" : "·"), (st) => !!st.tie, true);
    fxRow("rat", "ratch", (st) => (st.ratchet && st.ratchet > 1 ? `×${st.ratchet}` : "·"), (st) => !!(st.ratchet && st.ratchet > 1));
    fxRow("nud", "nudge", (st) => (st.nudge ? String(st.nudge) : "·"), (st) => !!st.nudge);
    fxRow("prb", "chance", (st) => probText(st.prob), (st) => !!st.prob);
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
    const f = el.closest<HTMLElement>("[data-fs]");
    if (f) {
      const idx = Number(f.dataset.s2), steps = cur().steps[track], st = steps[idx], key = f.dataset.fs;
      if (key === "tie") {
        if (st?.tie) steps[idx] = null;
        else if (!st) {
          const prev = steps.slice(0, idx).reverse().find((x) => x);
          if (prev) steps[idx] = { notes: [...prev.notes], tie: true };
        }
      } else if (st) {
        if (key === "acc") st.accent = !st.accent || undefined;
        else if (key === "sld") st.slide = !st.slide || undefined;
        else if (key === "rat") st.ratchet = cycle([1, 2, 3, 4], st.ratchet ?? 1) || undefined;
        else if (key === "nud") st.nudge = cycle(NUDGES, st.nudge ?? 0) || undefined;
        else if (key === "prb") st.prob = cycle(PROBS, st.prob ?? 0) || undefined;
        if (st.ratchet === 1) delete st.ratchet;
      }
      commit();
      renderRoll();
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
      if (el.dataset.act === "sel") { track = i; renderTracks(); renderPatterns(); renderRoll(); }
      if (el.dataset.act === "mute") { song.tracks[i].mute = !song.tracks[i].mute; commit(); renderTracks(); }
      return;
    }
    const pb = el.closest<HTMLElement>("[data-p]");
    if (pb) { pat = Number(pb.dataset.p); if (mode === "pattern") deps.send({ type: "mode", mode, pattern: pat }); renderPatterns(); renderRoll(); return; }
    const chip = el.closest<HTMLElement>("[data-a]");
    if (chip) { arrSel = Number(chip.dataset.a); pat = song.arrangement[arrSel]; renderAll(); return; }
  });

  root.addEventListener("toggle", (e) => {
    const d = e.target as HTMLDetailsElement;
    if (d.dataset?.modT === undefined) return;
    const i = Number(d.dataset.modT);
    if (d.open) modOpen.add(i); else modOpen.delete(i);
  }, true);

  root.addEventListener("input", (e) => {
    const el = e.target as HTMLInputElement;
    const trk = el.closest<HTMLElement>(".trk");
    if (trk && el.closest(".modp")) {
      const i = Number(trk.dataset.t);
      if (el.dataset.live) {
        const v = Number(el.value);
        deps.send(el.dataset.live === "at"
          ? { type: "midi", track: i, status: 0xd0, d1: v, d2: 0 }
          : { type: "midi", track: i, status: 0xb0, d1: Number(el.dataset.live), d2: v });
        return;
      }
      song.tracks[i].mod ??= defaultMod();
      if (applyModInput(song.tracks[i].mod!, el)) {
        const out = el.parentElement?.querySelector("output");
        if (out && el.type === "range" && el.dataset.mod) out.textContent = el.value;
        commit();
      }
      return;
    }
    if (trk && el.dataset.seq) {
      const i = Number(trk.dataset.t);
      const q = (song.tracks[i].seq ??= {}) as Record<string, number>;
      q[el.dataset.seq] = el.type === "checkbox" ? (el.checked ? 1 : 0) : Number(el.value);
      commit();
      return;
    }
    if (trk && el.dataset.mix) {
      (song.tracks[Number(trk.dataset.t)] as unknown as Record<string, number>)[el.dataset.mix] = Number(el.value);
      commit();
      if (el.dataset.mix === "itype") renderTracks();
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
  ($<HTMLInputElement>("sq-bpm")).oninput = (e) => { song.bpm = Math.min(240, Math.max(40, Number((e.target as HTMLInputElement).value) || 104)); $("sq-bpmo").textContent = String(song.bpm); commit(); };
  ($<HTMLInputElement>("sq-swing")).oninput = (e) => { song.swing = Number((e.target as HTMLInputElement).value) / 100; $("sq-swingo").textContent = `${Math.round(song.swing * 100)}%`; commit(); };
  ($<HTMLInputElement>("sq-name")).onchange = (e) => { cur().name = (e.target as HTMLInputElement).value || "Pattern"; commit(); renderPatterns(); renderArr(); };
  ($<HTMLSelectElement>("sq-tlen")).onchange = (e) => {
    const v = Number((e.target as HTMLSelectElement).value);
    const p = cur();
    p.lens ??= Array.from({ length: TRACKS }, () => p.length);
    p.lens[track] = v;
    if (p.lens.every((x) => x === p.length)) delete p.lens;
    commit(); renderRoll();
  };
  ($<HTMLSelectElement>("sq-len")).onchange = (e) => {
    const p = cur();
    p.length = Number((e.target as HTMLSelectElement).value);
    if (p.lens) { p.lens = p.lens.map((x) => Math.min(x, p.length)); if (p.lens.every((x) => x === p.length)) delete p.lens; }
    commit(); renderPatterns(); renderRoll();
  };
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
  ($<HTMLSelectElement>("sq-demo")).onchange = (e) => {
    const sel = e.target as HTMLSelectElement;
    const d = demoSongs.find((x) => x.id === sel.value);
    sel.value = "";
    if (!d) return;
    song = d.build(); pat = 0; track = 0; arrSel = -1;
    const first = deps.library().find((p) => p.id === song.tracks[0].patch)?.instrument;
    base = first?.kind === "drum" ? 36 : 48;
    commit(true); renderAll();
  };
  $("sq-reset").onclick = () => { song = defaultSong(); pat = 0; track = 0; arrSel = -1; commit(true); renderAll(); };

  renderAll();

  return {
    /** Sends the song and patches to a freshly started engine. */
    sync(): void { commit(true); deps.send({ type: "mode", mode, pattern: pat }); },
    /** Re-reads the patch list (after an import). */
    refreshLibrary(): void { renderTracks(); },
    onMessage(m: { type: string; pattern?: number; step?: number; arrPos?: number; track?: number }): void {
      if (m.type === "pos") {
        playPattern = m.pattern ?? 0; playArr = m.arrPos ?? 0;
        if (m.step !== undefined && track === 0) playStep = m.step;
        markPlayhead();
      } else if (m.type === "tpos") {
        if (m.track === track) { playPattern = m.pattern ?? 0; playStep = m.step ?? 0; playArr = m.arrPos ?? 0; markPlayhead(); }
      } else if (m.type === "stopped") {
        playing = false; playStep = -1;
        $("sq-play").textContent = "Play";
        markPlayhead();
      }
    },
    TRACKS,
  };
}
