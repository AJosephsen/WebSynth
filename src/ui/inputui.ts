// The chord-key and key-map controls (CHRD, VOIC, ROOT, SCL, QNT, TRN, STRUM, STROKE) as markup, for the live keyboard and for each track's MIDI input.
import { CHORD_MODES } from "../synth/harmony";
import { STROKE_NAMES, STRUM_NAMES } from "../synth/harmony";
import { QUANT_NAMES } from "../synth/keymap";
import { N_SCALE, SCALE_FAMILY, SCALE_FAMILY_TITLE, SCALE_TITLE } from "../synth/scales";
import { VOICING_NAMES } from "../synth/chord";
import type { ChordSetting } from "../synth/noteinput";

const NOTE_NAMES = ["C", "C#", "D", "D#", "E", "F", "F#", "G", "G#", "A", "A#", "B"];
const opts = (names: readonly string[], sel: number): string => names.map((n, i) => `<option value="${i}"${i === sel ? " selected" : ""}>${n}</option>`).join("");

/** The scale list: the Western scales first, then each family of microtonal ones under its heading. */
function scaleOptions(sel: number): string {
  let html = "";
  for (let f = 0; f < 8; f++) {
    const items = N_SCALE.map((n, i) => ({ n, i })).filter((x) => SCALE_FAMILY[x.i] === f);
    html += `<optgroup label="${SCALE_FAMILY_TITLE[f + 1]}">${items.map((x) => `<option value="${x.i}"${x.i === sel ? " selected" : ""} title="${SCALE_TITLE[x.i]}">${x.n}</option>`).join("")}</optgroup>`;
  }
  return html;
}

/**
 * @param attr the data attribute the page listens for ("data-in" or "data-tin")
 * @param wide a class for the labels
 */
export function chordControls(attr: string, c: Partial<ChordSetting>, wide = ""): string {
  const L = (name: string, key: string, body: string) => `<label class="kc ${wide}"><span>${name}</span><select ${attr}="chord.${key}">${body}</select></label>`;
  return [
    L("Chord", "chrd", opts(CHORD_MODES, c.chrd ?? 0)),
    L("Voicing", "voic", opts(VOICING_NAMES, c.voic ?? 0)),
    L("Key", "root", opts(NOTE_NAMES, c.root ?? 0)),
    L("Scale", "scale", scaleOptions(c.scale ?? 1)),
    L("Keys", "quant", opts(QUANT_NAMES, c.quant ?? 0)),
    `<label class="kc ${wide}"><span>Transpose</span><input type="range" ${attr}="chord.trans" min="-12" max="12" value="${c.trans ?? 0}"><output>${c.trans ?? 0}</output></label>`,
    L("Strum", "strum", opts(STRUM_NAMES, c.strum ?? 0)),
    L("Stroke", "stroke", opts(STROKE_NAMES, c.stroke ?? 0)),
  ].join("");
}
