import { Connectome } from "../brain/Connectome";

// WebGL2 point-cloud renderer for the whole FlyWire brain. Every neuron is a
// point at its FlyWire anchor position; simulated neurons glow when they
// spike, the optic lobes (not simulated) stay as a dim outline.

const VERT = `#version 300 es
precision highp float;
layout(location=0) in vec3 aPos;
layout(location=1) in float aClass;
layout(location=2) in float aHeat;
layout(location=3) in float aTag;
uniform mat4 uMVP;
uniform float uScale;
uniform vec3 uClassColor[10];
uniform vec3 uTagColor[16];
out vec3 vColor;
out float vAlpha;
void main() {
  gl_Position = uMVP * vec4(aPos, 1.0);
  int c = int(aClass + 0.5);
  int t = int(aTag + 0.5);
  vec3 base = uClassColor[c];
  vec3 hot = t > 0 ? uTagColor[t] : vec3(1.0, 0.93, 0.55);
  float h = clamp(aHeat, 0.0, 1.0);
  float optic = c == 9 ? 1.0 : 0.0;
  vColor = base * (0.55 - 0.3 * optic) + hot * h * 1.6;
  vAlpha = mix(0.35 - 0.2 * optic, 1.0, h);
  gl_PointSize = uScale * (1.4 - 0.4 * optic + 4.5 * h);
}`;

const FRAG = `#version 300 es
precision highp float;
in vec3 vColor;
in float vAlpha;
out vec4 outColor;
void main() {
  vec2 d = gl_PointCoord - 0.5;
  float r = dot(d, d) * 4.0;
  if (r > 1.0) discard;
  float a = vAlpha * (1.0 - r);
  outColor = vec4(vColor * a, a);
}`;

// Super classes in brain-file order, then optic last (see build_brain.py).
export const CLASS_COLORS: [number, number, number][] = [
  [0.3, 0.42, 0.68], // central
  [0.25, 0.7, 0.55], // sensory
  [0.55, 0.42, 0.8], // visual_projection
  [0.8, 0.62, 0.25], // ascending
  [0.9, 0.3, 0.35], // descending
  [0.3, 0.65, 0.75], // sensory_ascending
  [0.5, 0.5, 0.75], // visual_centrifugal
  [1.0, 0.35, 0.25], // motor
  [0.75, 0.75, 0.3], // endocrine
  [0.22, 0.27, 0.4], // optic
];

export const TAG_READOUT = 15;

type Mat4 = Float32Array;

function perspective(
  fovy: number,
  aspect: number,
  near: number,
  far: number,
): Mat4 {
  const f = 1 / Math.tan(fovy / 2);
  const m = new Float32Array(16);
  m[0] = f / aspect;
  m[5] = f;
  m[10] = (far + near) / (near - far);
  m[11] = -1;
  m[14] = (2 * far * near) / (near - far);
  return m;
}

function multiply(a: Mat4, b: Mat4): Mat4 {
  const o = new Float32Array(16);
  for (let i = 0; i < 4; i++) {
    for (let j = 0; j < 4; j++) {
      let s = 0;
      for (let k = 0; k < 4; k++) s += a[k * 4 + j] * b[i * 4 + k];
      o[i * 4 + j] = s;
    }
  }
  return o;
}

function rotationView(yaw: number, pitch: number, dist: number): Mat4 {
  const cy = Math.cos(yaw);
  const sy = Math.sin(yaw);
  const cp = Math.cos(pitch);
  const sp = Math.sin(pitch);
  // Rotate around y (yaw) then x (pitch), then push back along z.
  const m = new Float32Array(16);
  m[0] = cy;
  m[1] = sy * sp;
  m[2] = -sy * cp;
  m[4] = 0;
  m[5] = cp;
  m[6] = sp;
  m[8] = sy;
  m[9] = -cy * sp;
  m[10] = cy * cp;
  m[14] = -dist;
  m[15] = 1;
  return m;
}

export class BrainRenderer {
  readonly heat: Float32Array;
  readonly tag: Float32Array;
  yaw = 0;
  pitch = 0.12;
  zoom = 1.9;
  autoRotate = true;
  private gl: WebGL2RenderingContext;
  private prog: WebGLProgram;
  private heatBuf: WebGLBuffer;
  private tagBuf: WebGLBuffer;
  private tagDirty = true;
  private positions: Float32Array;
  private mvp: Mat4 = new Float32Array(16);
  private uMVP: WebGLUniformLocation;
  private uScale: WebGLUniformLocation;
  private vao: WebGLVertexArrayObject;

  constructor(
    private canvas: HTMLCanvasElement,
    private c: Connectome,
  ) {
    const gl = canvas.getContext("webgl2", {
      antialias: false,
      premultipliedAlpha: true,
    });
    if (gl === null) throw new Error("WebGL2 unavailable");
    this.gl = gl;
    this.heat = new Float32Array(c.nAll);
    this.tag = new Float32Array(c.nAll);

    const sh = (type: number, src: string) => {
      const s = gl.createShader(type)!;
      gl.shaderSource(s, src);
      gl.compileShader(s);
      if (!gl.getShaderParameter(s, gl.COMPILE_STATUS)) {
        throw new Error(gl.getShaderInfoLog(s) ?? "shader");
      }
      return s;
    };
    const prog = gl.createProgram()!;
    gl.attachShader(prog, sh(gl.VERTEX_SHADER, VERT));
    gl.attachShader(prog, sh(gl.FRAGMENT_SHADER, FRAG));
    gl.linkProgram(prog);
    if (!gl.getProgramParameter(prog, gl.LINK_STATUS)) {
      throw new Error(gl.getProgramInfoLog(prog) ?? "link");
    }
    this.prog = prog;

    // Positions in micrometres, dorsal up, anterior toward the viewer.
    const s = c.meta.posScale;
    this.positions = new Float32Array(c.nAll * 3);
    for (let i = 0; i < c.nAll; i++) {
      this.positions[i * 3] = c.pos[i * 3] * s;
      this.positions[i * 3 + 1] = -c.pos[i * 3 + 1] * s;
      this.positions[i * 3 + 2] = -c.pos[i * 3 + 2] * s;
    }
    const cls = new Float32Array(c.nAll);
    for (let i = 0; i < c.nAll; i++) cls[i] = c.superClass[i];

    this.vao = gl.createVertexArray()!;
    gl.bindVertexArray(this.vao);
    const attr = (
      loc: number,
      data: Float32Array,
      size: number,
      usage: number,
    ) => {
      const b = gl.createBuffer()!;
      gl.bindBuffer(gl.ARRAY_BUFFER, b);
      gl.bufferData(gl.ARRAY_BUFFER, data, usage);
      gl.enableVertexAttribArray(loc);
      gl.vertexAttribPointer(loc, size, gl.FLOAT, false, 0, 0);
      return b;
    };
    attr(0, this.positions, 3, gl.STATIC_DRAW);
    attr(1, cls, 1, gl.STATIC_DRAW);
    this.heatBuf = attr(2, this.heat, 1, gl.DYNAMIC_DRAW);
    this.tagBuf = attr(3, this.tag, 1, gl.DYNAMIC_DRAW);
    gl.bindVertexArray(null);

    gl.useProgram(prog);
    this.uMVP = gl.getUniformLocation(prog, "uMVP")!;
    this.uScale = gl.getUniformLocation(prog, "uScale")!;
    gl.uniform3fv(
      gl.getUniformLocation(prog, "uClassColor"),
      CLASS_COLORS.flat(),
    );
  }

  setTagColors(colors: [number, number, number][]): void {
    const flat = new Float32Array(16 * 3);
    colors.slice(0, 16).forEach((col, i) => flat.set(col, i * 3));
    this.gl.useProgram(this.prog);
    this.gl.uniform3fv(
      this.gl.getUniformLocation(this.prog, "uTagColor"),
      flat,
    );
  }

  markTagsDirty(): void {
    this.tagDirty = true;
  }

  render(dtMs: number): void {
    const gl = this.gl;
    const dpr = Math.min(2, window.devicePixelRatio || 1);
    const w = Math.max(1, Math.round(this.canvas.clientWidth * dpr));
    const h = Math.max(1, Math.round(this.canvas.clientHeight * dpr));
    if (this.canvas.width !== w || this.canvas.height !== h) {
      this.canvas.width = w;
      this.canvas.height = h;
    }
    if (this.autoRotate) this.yaw += dtMs * 0.00012;
    const proj = perspective(0.6, w / h, 50, 5000);
    const view = rotationView(this.yaw, this.pitch, 1900 / this.zoom);
    this.mvp = multiply(proj, view);

    gl.viewport(0, 0, w, h);
    gl.clearColor(0.02, 0.025, 0.04, 1);
    gl.clear(gl.COLOR_BUFFER_BIT);
    gl.disable(gl.DEPTH_TEST);
    gl.enable(gl.BLEND);
    gl.blendFunc(gl.ONE, gl.ONE_MINUS_SRC_ALPHA);
    gl.useProgram(this.prog);
    gl.uniformMatrix4fv(this.uMVP, false, this.mvp);
    gl.uniform1f(this.uScale, dpr * Math.max(1, this.zoom * 0.9));
    gl.bindVertexArray(this.vao);
    gl.bindBuffer(gl.ARRAY_BUFFER, this.heatBuf);
    gl.bufferSubData(gl.ARRAY_BUFFER, 0, this.heat, 0, this.c.nSim);
    if (this.tagDirty) {
      gl.bindBuffer(gl.ARRAY_BUFFER, this.tagBuf);
      gl.bufferSubData(gl.ARRAY_BUFFER, 0, this.tag);
      this.tagDirty = false;
    }
    // Optic lobes first (dim background), then the simulated brain on top.
    gl.drawArrays(gl.POINTS, this.c.nSim, this.c.nAll - this.c.nSim);
    gl.drawArrays(gl.POINTS, 0, this.c.nSim);
    gl.bindVertexArray(null);
  }

  /** Nearest simulated neuron to a canvas pixel (CSS pixels), or null. */
  pick(x: number, y: number, radiusPx = 7): number | null {
    const w = this.canvas.clientWidth;
    const h = this.canvas.clientHeight;
    const m = this.mvp;
    const p = this.positions;
    let best: number | null = null;
    let bestD = radiusPx * radiusPx;
    let bestZ = Infinity;
    for (let i = 0; i < this.c.nSim; i++) {
      const px = p[i * 3];
      const py = p[i * 3 + 1];
      const pz = p[i * 3 + 2];
      const cw = m[3] * px + m[7] * py + m[11] * pz + m[15];
      if (cw <= 0) continue;
      const sx = ((m[0] * px + m[4] * py + m[8] * pz + m[12]) / cw) * 0.5 + 0.5;
      const sy = 0.5 - ((m[1] * px + m[5] * py + m[9] * pz + m[13]) / cw) * 0.5;
      const dx = sx * w - x;
      const dy = sy * h - y;
      const d = dx * dx + dy * dy;
      if (d < bestD || (d === bestD && cw < bestZ)) {
        bestD = d;
        bestZ = cw;
        best = i;
      }
    }
    return best;
  }

  dispose(): void {
    const ext = this.gl.getExtension("WEBGL_lose_context");
    ext?.loseContext();
  }
}
