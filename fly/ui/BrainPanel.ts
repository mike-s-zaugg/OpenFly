import { Connectome } from "../brain/Connectome";
import { maskedSoftmax } from "../brain/Readout";
import { HEADS } from "../game/Motor";
import { FlyDecisionTelemetry, FlyTelemetry } from "../game/Telemetry";
import { BrainRenderer, RenderQuality, TAG_READOUT } from "./BrainRenderer";

// The spectator's window into the fly: a 3D FlyWire brain replaying each
// decision's spikes in slow motion, what the fly senses, and how strongly
// its descending neurons vote for each motor program.

export const CHANNEL_COLORS: [number, number, number][] = [
  [1.0, 0.85, 0.2], // sugar
  [1.0, 0.45, 0.35], // touch
  [1.0, 0.2, 0.2], // looming
  [0.3, 0.9, 0.4], // pursuit
  [0.55, 1.0, 0.3], // prey
  [0.95, 0.35, 0.85], // rival
  [0.35, 0.75, 1.0], // wind
  [0.95, 0.6, 1.0], // song
  [1.0, 1.0, 0.75], // light
  [0.3, 1.0, 0.85], // energy
  [1.0, 0.7, 0.2], // wealth
  [0.6, 0.65, 1.0], // size
  [0.85, 0.85, 0.85], // strain
  [0.95, 0.8, 0.45], // hoard
  [0.3, 0.6, 0.95], // shore
  [0.7, 0.9, 0.4], // build
  [1.0, 0.3, 0.55], // sky
];
const READOUT_COLOR: [number, number, number] = [1.0, 0.35, 0.15];

const SHORT: Record<string, string> = {
  sugar: "Sugar",
  touch: "Touch",
  looming: "Looming",
  pursuit: "Pursuit",
  prey: "Prey",
  rival: "Collision",
  wind: "Wind",
  song: "Hearing",
  light: "Ocelli",
  energy: "Energy",
  wealth: "Gut",
  size: "Size",
  strain: "Effort",
  hoard: "Reserves",
  shore: "Shore",
  build: "Infra",
  sky: "Sky",
};

type Quality = RenderQuality | "off";
const QUALITY_LABEL: Record<Quality, string> = { high: "HQ", low: "Lite", off: "Off" };
const QUALITY_KEY = "openfly.quality";

function defaultQuality(): Quality {
  try {
    const saved = localStorage.getItem(QUALITY_KEY);
    if (saved === "high" || saved === "low" || saved === "off") return saved;
  } catch {
    // storage blocked: fall through to the hardware guess
  }
  const nav = navigator as Navigator & { deviceMemory?: number };
  const weak =
    (nav.hardwareConcurrency ?? 8) <= 4 || (nav.deviceMemory ?? 8) <= 4;
  return weak ? "low" : "high";
}

const css = (c: [number, number, number], a = 1) =>
  `rgba(${Math.round(c[0] * 255)},${Math.round(c[1] * 255)},${Math.round(c[2] * 255)},${a})`;

const STYLE = `
.of-panel{position:fixed;top:64px;right:12px;width:390px;max-height:calc(100vh - 250px);z-index:40;
  background:rgba(8,10,16,.88);color:#dfe6f3;border:1px solid rgba(120,140,190,.35);border-radius:10px;
  font:12px/1.35 ui-sans-serif,system-ui,sans-serif;box-shadow:0 8px 30px rgba(0,0,0,.5);display:flex;flex-direction:column;
  overflow:hidden;user-select:none}
.of-panel.of-collapsed{width:auto}
.of-panel.of-collapsed .of-body{display:none}
.of-head{display:flex;align-items:center;gap:8px;padding:6px 10px;cursor:move;background:rgba(40,50,80,.35)}
.of-title{font-weight:600;flex:1;min-width:0}
.of-title .of-sub{font-weight:400;white-space:nowrap;overflow:hidden;text-overflow:ellipsis}
.of-status{white-space:nowrap;color:#cfe3ff;font-size:11px}
.of-sub{color:#8f9bb5;font-size:11px}
.of-btn{background:none;border:1px solid rgba(160,170,210,.35);color:#cdd6ea;border-radius:5px;padding:1px 7px;cursor:pointer}
.of-body{overflow-y:auto;padding:0 10px 10px}
.of-canvas-wrap{position:relative;margin:0 -10px 4px;height:200px}
.of-canvas{width:100%;height:100%;display:block;cursor:grab}
.of-tip{position:absolute;pointer-events:none;background:rgba(0,0,0,.8);border:1px solid #445;border-radius:5px;
  padding:4px 6px;font-size:11px;white-space:nowrap;display:none}
.of-legend{position:absolute;left:8px;bottom:6px;font-size:10px;color:#8f9bb5;pointer-events:none}
.of-sec{margin-top:6px;font-size:10px;letter-spacing:.08em;text-transform:uppercase;color:#8f9bb5;display:flex;justify-content:space-between}
.of-row{display:grid;grid-template-columns:168px 1fr 30px;align-items:center;gap:6px;margin-top:1px;line-height:16px}
.of-senses{display:grid;grid-template-columns:1fr 1fr;column-gap:12px}
.of-senses .of-row{grid-template-columns:58px 1fr 24px}
.of-name{white-space:nowrap;overflow:hidden;text-overflow:ellipsis}
.of-bar{height:8px;background:rgba(255,255,255,.07);border-radius:4px;overflow:hidden}
.of-fill{height:100%;border-radius:4px;transition:width .25s}
.of-val{text-align:right;color:#aab4c8;font-variant-numeric:tabular-nums}
.of-row.of-off{opacity:.35}
.of-row.of-chosen .of-name{color:#fff;font-weight:600}
.of-row.of-chosen .of-name:before{content:"▶ ";color:#ff7a3d}
.of-foot{margin-top:4px;color:#8f9bb5;font-size:11px}
.of-log{margin-top:4px;font-size:11px;color:#b9c3d8;max-height:48px;overflow:hidden}
.of-log div{white-space:nowrap;overflow:hidden;text-overflow:ellipsis}
.of-spark{width:100%;height:24px;display:block;margin-top:4px}
.of-teach{color:#8f9bb5}
`;

export class BrainPanel {
  private root: HTMLDivElement;
  private renderer: BrainRenderer | null = null;
  private raf = 0;
  private lastFrame = 0;
  private current: FlyDecisionTelemetry | null = null;
  private replayStart = 0;
  private replayDur = 1500;
  private replayCursor = 0;
  private lastArrival = 0;
  private senseRows: HTMLDivElement[] = [];
  private headRows: HTMLDivElement[][] = [];
  private quality: Quality = defaultQuality();
  private qualityBtn: HTMLButtonElement;
  private lastRender = 0;
  private slowFrames = 0;
  private autoLowered = false;
  private foot: HTMLDivElement;
  private log: HTMLDivElement;
  private spark: HTMLCanvasElement;
  private tip: HTMLDivElement;
  private status: HTMLSpanElement;
  private flyId: string | null = null;
  private readonly isReadout: Uint8Array;
  private decisionCount = 0;

  constructor(private c: Connectome) {
    if (document.getElementById("openfly-style") === null) {
      const st = document.createElement("style");
      st.id = "openfly-style";
      st.textContent = STYLE;
      document.head.appendChild(st);
    }
    this.isReadout = new Uint8Array(c.nAll);
    for (const i of c.readout) this.isReadout[i] = 1;

    const root = document.createElement("div");
    root.className = "of-panel";
    root.innerHTML = `
      <div class="of-head">
        <span>🪰</span>
        <div class="of-title">Fly brain <span class="of-status">waking up…</span><div class="of-sub">FlyWire 783 · ${c.nSim.toLocaleString()} of ${c.nAll.toLocaleString()} neurons spiking</div></div>
        <button class="of-btn of-quality" title="3D view quality: HQ draws the whole brain, Lite only the simulated neurons at 30 fps, Off hides it">HQ</button>
        <button class="of-btn of-collapse" title="Collapse">–</button>
      </div>
      <div class="of-body">
        <div class="of-canvas-wrap">
          <canvas class="of-canvas"></canvas>
          <div class="of-tip"></div>
          <div class="of-legend">drag to rotate · wheel to zoom · click a neuron for Virtual Fly Brain</div>
        </div>
        <div class="of-sec"><span>Senses → sensory neurons (Hz)</span><span>hover for details</span></div>
        <div class="of-senses"></div>
        <div class="of-motor"></div>
        <canvas class="of-spark"></canvas>
        <div class="of-foot"></div>
        <div class="of-log"></div>
      </div>`;
    this.root = root;
    document.body.appendChild(root);
    this.foot = root.querySelector(".of-foot")!;
    this.log = root.querySelector(".of-log")!;
    this.spark = root.querySelector(".of-spark")!;
    this.tip = root.querySelector(".of-tip")!;
    this.status = root.querySelector(".of-status")!;

    const senses = root.querySelector(".of-senses")!;
    c.meta.channels.forEach((ch, i) => {
      const row = this.row(SHORT[ch.key] ?? ch.label, css(CHANNEL_COLORS[i]));
      row.title = `${ch.game}\n\n${ch.label}, ${ch.neurons.length} neurons. ${ch.why}`;
      senses.appendChild(row);
      this.senseRows.push(row);
    });
    const motor = root.querySelector(".of-motor")!;
    HEADS.forEach((head) => {
      const sec = document.createElement("div");
      sec.className = "of-sec";
      sec.innerHTML = `<span>Descending neurons → ${head.label.toLowerCase()}</span><span>vote</span>`;
      motor.appendChild(sec);
      this.headRows.push(
        head.programs.map((a) => {
          const row = this.row(`${a.label} · ${a.bio}`, css(READOUT_COLOR));
          motor.appendChild(row);
          return row;
        }),
      );
    });
    this.qualityBtn = root.querySelector<HTMLButtonElement>(".of-quality")!;
    this.qualityBtn.addEventListener("click", () => {
      const order: Quality[] = ["high", "low", "off"];
      this.setQuality(order[(order.indexOf(this.quality) + 1) % order.length], true);
    });

    root.querySelector(".of-collapse")!.addEventListener("click", () => {
      root.classList.toggle("of-collapsed");
    });
    this.makeDraggable(root.querySelector(".of-head")!);

    const canvas = root.querySelector<HTMLCanvasElement>(".of-canvas")!;
    try {
      this.renderer = new BrainRenderer(canvas, c);
      this.renderer.setTagColors([
        [1, 1, 1],
        ...CHANNEL_COLORS,
        [1, 1, 1],
        READOUT_COLOR,
      ]);
      c.channelNeurons.forEach((list, ch) => {
        for (const i of list) this.renderer!.tag[i] = ch + 1;
      });
      for (const i of c.readout) this.renderer.tag[i] = TAG_READOUT;
      this.renderer.markTagsDirty();
      this.bindCanvas(canvas);
      this.setQuality(this.quality, false);
    } catch (e) {
      canvas.replaceWith(
        Object.assign(document.createElement("div"), {
          textContent: `3D view unavailable: ${String(e)}`,
          style: "padding:20px;color:#8f9bb5",
        }),
      );
    }
    this.raf = requestAnimationFrame((t) => this.frame(t));
  }

  private row(label: string, color: string): HTMLDivElement {
    const row = document.createElement("div");
    row.className = "of-row";
    row.innerHTML = `<div class="of-name"></div><div class="of-bar"><div class="of-fill" style="width:0;background:${color}"></div></div><div class="of-val">–</div>`;
    row.querySelector(".of-name")!.textContent = label;
    return row;
  }

  private setRow(row: HTMLDivElement, frac: number, text: string): void {
    (row.querySelector(".of-fill") as HTMLDivElement).style.width =
      `${Math.round(Math.max(0, Math.min(1, frac)) * 100)}%`;
    row.querySelector(".of-val")!.textContent = text;
  }

  private makeDraggable(handle: HTMLElement): void {
    let sx = 0;
    let sy = 0;
    let ox = 0;
    let oy = 0;
    const move = (e: PointerEvent) => {
      this.root.style.left = `${ox + e.clientX - sx}px`;
      this.root.style.top = `${oy + e.clientY - sy}px`;
      this.root.style.right = "auto";
    };
    handle.addEventListener("pointerdown", (e) => {
      if ((e.target as HTMLElement).tagName === "BUTTON") return;
      const r = this.root.getBoundingClientRect();
      sx = e.clientX;
      sy = e.clientY;
      ox = r.left;
      oy = r.top;
      handle.setPointerCapture(e.pointerId);
      handle.addEventListener("pointermove", move);
      handle.addEventListener(
        "pointerup",
        () => handle.removeEventListener("pointermove", move),
        { once: true },
      );
    });
  }

  private bindCanvas(canvas: HTMLCanvasElement): void {
    const r = this.renderer!;
    let dragging = false;
    let moved = false;
    let lx = 0;
    let ly = 0;
    let lastPick = 0;
    canvas.addEventListener("pointerdown", (e) => {
      dragging = true;
      moved = false;
      lx = e.clientX;
      ly = e.clientY;
      canvas.setPointerCapture(e.pointerId);
    });
    canvas.addEventListener("pointerup", (e) => {
      dragging = false;
      if (!moved) {
        const rect = canvas.getBoundingClientRect();
        const n = r.pick(e.clientX - rect.left, e.clientY - rect.top);
        const vfb = n === null ? null : this.c.vfbId(n);
        if (vfb !== null) {
          window.open(
            `https://v2.virtualflybrain.org/org.geppetto.frontend/geppetto?id=VFB_${vfb}`,
            "_blank",
            "noopener",
          );
        }
      }
    });
    canvas.addEventListener("pointermove", (e) => {
      const rect = canvas.getBoundingClientRect();
      if (dragging) {
        const dx = e.clientX - lx;
        const dy = e.clientY - ly;
        if (Math.abs(dx) + Math.abs(dy) > 2) moved = true;
        r.yaw += dx * 0.01;
        r.pitch = Math.max(-1.4, Math.min(1.4, r.pitch + dy * 0.01));
        r.autoRotate = false;
        lx = e.clientX;
        ly = e.clientY;
        this.tip.style.display = "none";
        return;
      }
      const now = performance.now();
      if (now - lastPick < 60) return;
      lastPick = now;
      const x = e.clientX - rect.left;
      const y = e.clientY - rect.top;
      const n = r.pick(x, y);
      if (n === null) {
        this.tip.style.display = "none";
        return;
      }
      const type = this.c.cellTypeName(n) || "unnamed";
      const cls = this.c.superClassName(n).replace("_", " ");
      const nt = this.c.meta.neurotransmitters[this.c.nt[n]];
      const ch = this.c.meta.channels.findIndex((c) => c.neurons.includes(n));
      const role =
        ch >= 0
          ? ` · senses: ${this.c.meta.channels[ch].label}`
          : this.isReadout[n]
            ? " · motor readout"
            : "";
      this.tip.textContent = `${type} · ${cls} · ${nt}${role}`;
      this.tip.style.display = "block";
      this.tip.style.left = `${Math.min(x + 12, rect.width - 200)}px`;
      this.tip.style.top = `${y + 12}px`;
    });
    canvas.addEventListener(
      "pointerleave",
      () => (this.tip.style.display = "none"),
    );
    canvas.addEventListener(
      "wheel",
      (e) => {
        e.preventDefault();
        r.zoom = Math.max(
          0.6,
          Math.min(6, r.zoom * Math.exp(-e.deltaY * 0.001)),
        );
      },
      { passive: false },
    );
  }

  onTelemetry(t: FlyTelemetry): void {
    if (this.flyId === null) this.flyId = t.flyId;
    if (t.flyId !== this.flyId) return;
    if (t.type === "openfly_status") {
      this.status.textContent =
        t.status === "spawned"
          ? "· landed"
          : t.status === "died"
            ? "· died ✝"
            : "· won 🏆";
      this.addLog(
        `${this.clock(t.tick)} ${t.status === "spawned" ? "landed on the map" : t.status}`,
      );
      return;
    }
    const now = performance.now();
    if (this.lastArrival > 0) {
      // Replay each 100 ms window across the time until the next decision.
      const gap = now - this.lastArrival;
      this.replayDur = Math.max(
        250,
        Math.min(2500, 0.8 * this.replayDur + 0.2 * gap * 0.95),
      );
    }
    this.lastArrival = now;
    this.current = t;
    this.replayStart = now;
    this.replayCursor = 0;
    this.decisionCount++;
    this.updateBars(t);
  }

  private clock(tick: number): string {
    const s = Math.floor(tick / 10);
    return `${Math.floor(s / 60)}:${String(s % 60).padStart(2, "0")}`;
  }

  private addLog(text: string): void {
    const d = document.createElement("div");
    d.textContent = text;
    this.log.prepend(d);
    while (this.log.childElementCount > 6) this.log.lastElementChild!.remove();
  }

  private updateBars(t: FlyDecisionTelemetry): void {
    this.status.textContent = t.stats.alive
      ? `· ${(100 * t.stats.landShare).toFixed(1)}% of the land`
      : "· died ✝";
    t.senses.forEach((v, i) =>
      this.setRow(this.senseRows[i], v, `${Math.round(t.rates[i])}`),
    );
    const picks: string[] = [];
    t.heads.forEach((h, hi) => {
      const programs = HEADS[hi].programs;
      const mask = Uint8Array.from(h.mask);
      const probs =
        h.scores === null ? null : maskedSoftmax(Float32Array.from(h.scores), mask);
      programs.forEach((_, i) => {
        const row = this.headRows[hi][i];
        row.classList.toggle("of-off", mask[i] === 0);
        row.classList.toggle("of-chosen", i === h.action);
        const p = probs === null ? (i === h.action ? 1 : 0) : probs[i];
        this.setRow(row, p, mask[i] ? `${Math.round(100 * p)}%` : "–");
        row.title =
          i === h.teacher
            ? "The hand-written teacher would pick this one"
            : mask[i] === 0
              ? "Not possible right now"
              : "";
      });
      // Idle programs (wait, save) only make the log when both heads idle.
      if (h.action !== 0 || hi === t.heads.length - 1 && picks.length === 0) {
        const agree =
          h.action === h.teacher ? "" : ` (teacher: ${programs[h.teacher].label})`;
        picks.push(
          `${programs[h.action].label}${h.executed ? "" : " (nothing to do)"}${agree}`,
        );
      }
    });
    this.addLog(`${this.clock(t.tick)} ${picks.join(" + ")}`);
    this.foot.innerHTML = `${t.totalSpikes.toLocaleString()} spikes in ${t.windowMs} ms · ${t.computeMs.toFixed(0)} ms CPU · decision ${this.decisionCount} · ${t.policy === "brain" ? "brain in control" : `<span class="of-teach">${t.policy}</span>`}`;
    this.drawSpark(t);
  }

  private drawSpark(t: FlyDecisionTelemetry): void {
    const cv = this.spark;
    const dpr = Math.min(2, window.devicePixelRatio || 1);
    cv.width = cv.clientWidth * dpr;
    cv.height = cv.clientHeight * dpr;
    const g = cv.getContext("2d")!;
    const steps = Math.max(1, Math.round(t.windowMs / t.dtMs));
    const hist = new Float32Array(steps);
    const dn = new Float32Array(steps);
    for (let k = 0; k < t.spikeStep.length; k++) {
      hist[t.spikeStep[k]]++;
      if (this.isReadout[t.spikeNeuron[k]]) dn[t.spikeStep[k]]++;
    }
    const max = Math.max(1, ...hist);
    const maxDn = Math.max(1, ...dn);
    g.clearRect(0, 0, cv.width, cv.height);
    const bw = cv.width / steps;
    for (let s = 0; s < steps; s++) {
      const h = (hist[s] / max) * cv.height;
      g.fillStyle = "rgba(140,160,220,.55)";
      g.fillRect(s * bw, cv.height - h, Math.max(1, bw - 0.5), h);
      const h2 = (dn[s] / maxDn) * cv.height * 0.6;
      g.fillStyle = css(READOUT_COLOR, 0.9);
      g.fillRect(
        s * bw,
        cv.height - h2,
        Math.max(1, bw - 0.5),
        Math.min(h2, 2 * dpr),
      );
    }
    g.fillStyle = "#8f9bb5";
    g.font = `${10 * dpr}px sans-serif`;
    g.fillText(
      "population spikes / ms (orange: descending)",
      4 * dpr,
      11 * dpr,
    );
  }

  private frame(time: number): void {
    const dt = this.lastFrame === 0 ? 16 : Math.min(100, time - this.lastFrame);
    this.lastFrame = time;
    const r = this.renderer;
    if (r !== null) {
      const decay = Math.exp(-dt / 180);
      const heat = r.heat;
      for (let i = 0; i < this.c.nSim; i++) {
        if (heat[i] > 0.003) heat[i] *= decay;
        else heat[i] = 0;
      }
      const t = this.current;
      if (t !== null) {
        const steps = Math.round(t.windowMs / t.dtMs);
        const upTo = Math.min(
          steps,
          ((time - this.replayStart) / this.replayDur) * steps,
        );
        const sn = t.spikeNeuron;
        const ss = t.spikeStep;
        while (this.replayCursor < sn.length && ss[this.replayCursor] <= upTo) {
          heat[sn[this.replayCursor]] = 1;
          this.replayCursor++;
        }
      }
      const visible =
        this.quality !== "off" && !this.root.classList.contains("of-collapsed");
      const minGap = this.quality === "low" ? 33 : 0;
      if (visible && time - this.lastRender >= minGap) {
        r.render(time - this.lastRender);
        this.lastRender = time;
      }
      if (visible) this.watchFrameRate(dt);
    }
    this.raf = requestAnimationFrame((tt) => this.frame(tt));
  }

  private setQuality(q: Quality, remember: boolean): void {
    this.quality = q;
    this.qualityBtn.textContent = QUALITY_LABEL[q];
    const wrap = this.root.querySelector<HTMLDivElement>(".of-canvas-wrap");
    if (wrap !== null) wrap.style.display = q === "off" ? "none" : "";
    if (this.renderer !== null && q !== "off") this.renderer.quality = q;
    this.slowFrames = 0;
    if (remember) {
      try {
        localStorage.setItem(QUALITY_KEY, q);
      } catch {
        // storage blocked: the choice lasts for this game only
      }
    }
  }

  /**
   * Drop to Lite once if the page keeps running below ~25 fps with the full
   * brain on screen (typical for integrated or software GPUs).
   */
  private watchFrameRate(frameMs: number): void {
    if (this.quality !== "high" || this.autoLowered) return;
    this.slowFrames =
      frameMs > 40 ? this.slowFrames + 1 : Math.max(0, this.slowFrames - 2);
    if (this.slowFrames > 75) {
      this.autoLowered = true;
      this.setQuality("low", false);
      this.addLog("3D view switched to Lite to keep the game smooth");
    }
  }

  dispose(): void {
    cancelAnimationFrame(this.raf);
    this.renderer?.dispose();
    this.root.remove();
  }
}
