// The punch-in FX pad (Melodee's punch layer, see fx/punch.ts): 27 pads, hold one to punch the master mix, release to return.
// A pad sends { type: "punch", fx } to the audio worklet (fx -1 releases); the last pad pressed wins, as the keys do on the hardware.
import { PUNCH_NAME, PUNCH_NFX } from "../fx/punch";

/** Adds the PUNCH-IN FX module to the end of a tab. */
export function mountPunch(tab: HTMLElement, send: (m: { type: "punch"; fx: number }) => void): void {
  const sec = document.createElement("section");
  sec.className = "module";
  sec.innerHTML = `<h4>PUNCH-IN FX <small>(hold a pad: the whole mix goes through the effect; release it and the mix comes back)</small></h4>
    <div class="pads" id="punch-pads">${PUNCH_NAME.map((n, e) => `<button class="pad${e >= 16 ? " blackpad" : ""}" data-fx="${e}">${n}</button>`).join("")}</div>`;
  tab.appendChild(sec);
  const pads = sec.querySelector<HTMLElement>("#punch-pads")!;
  const down = new Map<number, number>(); // pointer -> effect
  const show = (): void => {
    const on = new Set(down.values());
    pads.querySelectorAll<HTMLElement>(".pad").forEach((b) => b.classList.toggle("on", on.has(Number(b.dataset.fx))));
  };
  pads.addEventListener("pointerdown", (ev) => {
    const b = (ev.target as HTMLElement).closest<HTMLElement>(".pad");
    if (!b) return;
    const fx = Number(b.dataset.fx);
    if (!(fx >= 0 && fx < PUNCH_NFX)) return;
    pads.setPointerCapture(ev.pointerId);
    down.set(ev.pointerId, fx);
    send({ type: "punch", fx });
    show();
  });
  const up = (ev: PointerEvent): void => {
    if (!down.delete(ev.pointerId)) return;
    const rest = [...down.values()];
    send({ type: "punch", fx: rest.length ? rest[rest.length - 1] : -1 }); // an older pad still held takes over
    show();
  };
  pads.addEventListener("pointerup", up);
  pads.addEventListener("pointercancel", up);
}
