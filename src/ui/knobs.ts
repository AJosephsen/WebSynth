// Turns every range input under root into a rotary knob. The input stays in the DOM (hidden), so the existing handlers
// keep working: the knob sets its value and dispatches a bubbling "input" event.
const SIZE = 38;
const A0 = -135, A1 = 135; // degrees from straight up

function polar(r: number, deg: number): [number, number] {
  const a = ((deg - 90) * Math.PI) / 180;
  return [SIZE / 2 + r * Math.cos(a), SIZE / 2 + r * Math.sin(a)];
}
function arc(r: number, d0: number, d1: number): string {
  if (Math.abs(d1 - d0) < 0.5) return "";
  const [x0, y0] = polar(r, d0), [x1, y1] = polar(r, d1);
  return `M${x0.toFixed(2)} ${y0.toFixed(2)}A${r} ${r} 0 ${Math.abs(d1 - d0) > 180 ? 1 : 0} ${d1 > d0 ? 1 : 0} ${x1.toFixed(2)} ${y1.toFixed(2)}`;
}

function labelOf(input: HTMLInputElement): string {
  const lab = input.closest("label");
  if (lab) {
    const span = lab.querySelector(":scope > span");
    if (span?.textContent) return span.textContent.trim();
    let t = "";
    lab.childNodes.forEach((n) => { if (n.nodeType === Node.TEXT_NODE) t += n.textContent; });
    if (t.trim()) return t.trim();
  }
  const d = input.dataset;
  return (d.mix ?? d.mod ?? d.slot ?? d.p ?? d.e ?? d.fx ?? "value").toString();
}

function upgrade(input: HTMLInputElement, show: (name: string, value: string) => void): void {
  if (input.dataset.knob) return;
  input.dataset.knob = "1";
  const min = Number(input.min || 0), max = Number(input.max || 100), step = Number(input.step || 1);
  const initial = Number(input.defaultValue || input.value);
  const el = document.createElement("span");
  el.className = "knob";
  el.tabIndex = 0;
  el.setAttribute("role", "slider");
  el.setAttribute("aria-valuemin", String(min));
  el.setAttribute("aria-valuemax", String(max));
  el.innerHTML = `<svg viewBox="0 0 ${SIZE} ${SIZE}" width="${SIZE}" height="${SIZE}"><path class="trk" fill="none"/><path class="val" fill="none"/><line class="ptr"/></svg>`;
  const trk = el.querySelector<SVGPathElement>(".trk")!, val = el.querySelector<SVGPathElement>(".val")!, ptr = el.querySelector<SVGLineElement>(".ptr")!;
  trk.setAttribute("d", arc(15, A0, A1));
  const bipolar = min < 0 && max > 0;
  const frac = (v: number) => (v - min) / (max - min || 1);
  const draw = () => {
    const v = Number(input.value);
    const deg = A0 + frac(v) * (A1 - A0);
    const from = bipolar ? A0 + frac(0) * (A1 - A0) : A0;
    val.setAttribute("d", arc(15, Math.min(from, deg), Math.max(from, deg)));
    const [x0, y0] = polar(6, deg), [x1, y1] = polar(13, deg);
    ptr.setAttribute("x1", String(x0)); ptr.setAttribute("y1", String(y0)); ptr.setAttribute("x2", String(x1)); ptr.setAttribute("y2", String(y1));
    el.setAttribute("aria-valuenow", String(v));
  };
  const set = (v: number) => {
    v = Math.min(max, Math.max(min, Math.round(v / step) * step));
    if (v === Number(input.value)) return;
    input.value = String(v);
    input.dispatchEvent(new Event("input", { bubbles: true }));
    draw();
    const out = input.parentElement?.querySelector("output")?.textContent;
    show(labelOf(input), out ?? String(v));
  };
  let startY = 0, startV = 0, dragging = false;
  el.addEventListener("pointerdown", (e) => {
    e.preventDefault();
    el.setPointerCapture(e.pointerId);
    dragging = true; startY = e.clientY; startV = Number(input.value);
    el.focus();
    show(labelOf(input), input.parentElement?.querySelector("output")?.textContent ?? input.value);
  });
  el.addEventListener("pointermove", (e) => {
    if (!dragging) return;
    const range = max - min;
    set(startV + ((startY - e.clientY) / (e.shiftKey ? 600 : 150)) * range);
  });
  const end = () => { dragging = false; };
  el.addEventListener("pointerup", end);
  el.addEventListener("pointercancel", end);
  el.addEventListener("dblclick", () => set(initial));
  el.addEventListener("wheel", (e) => { e.preventDefault(); set(Number(input.value) + (e.deltaY < 0 ? 1 : -1) * Math.max(step, (max - min) / 100)); }, { passive: false });
  el.addEventListener("keydown", (e) => {
    const d = e.key === "ArrowUp" || e.key === "ArrowRight" ? 1 : e.key === "ArrowDown" || e.key === "ArrowLeft" ? -1 : 0;
    if (!d) return;
    e.preventDefault();
    e.stopPropagation();
    set(Number(input.value) + d * Math.max(step, (max - min) / (e.shiftKey ? 10 : 100)));
  });
  input.hidden = true;
  input.style.display = "none";
  input.before(el);
  draw();
}

/** Upgrades the range inputs now under root and any added later. show: the display's readout. */
export function mountKnobs(root: HTMLElement, show: (name: string, value: string) => void): void {
  const run = () => root.querySelectorAll<HTMLInputElement>('input[type="range"]:not([data-knob])').forEach((i) => upgrade(i, show));
  run();
  let queued = false;
  new MutationObserver(() => {
    if (queued) return;
    queued = true;
    queueMicrotask(() => { queued = false; run(); });
  }).observe(root, { childList: true, subtree: true });
}
