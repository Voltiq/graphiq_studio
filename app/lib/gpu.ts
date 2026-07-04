// WebGL2 tone-LUT renderer — the GPU stage behind the render-graph seam.
//
// Scope (deliberate): the compositor's blend modes already run on the GPU via
// Canvas2D's globalCompositeOperation, so the real CPU cost in the engine is
// the hand-written per-pixel loops. The hottest of those with a clean seam is
// the tone-LUT stage (Curves/Levels adjustment layers re-run getImageData +
// a full-document JS loop on every slider tick). This renderer replaces BOTH:
// the below-accumulator canvas uploads straight to a texture (no readback),
// a 256×1 LUT texture maps each channel, and the result comes back to the
// compositor as a canvas for a GPU→GPU drawImage.
//
// Correctness stance: Canvas2D remains the always-correct fallback — the GPU
// path is used only when it can match it: WebGL2 present, and the working
// colour space either sRGB or representable via drawingBufferColorSpace /
// unpackColorSpace. LUT sampling is NEAREST at (v·255 + 0.5)/256, so each
// 8-bit value hits its exact LUT bucket. Sources upload UNPREMULTIPLIED
// (matching getImageData semantics); the context is created with
// premultipliedAlpha:false so drawImage reads it back the same way.
// A/B via window.__gqGPU (dev), mirroring __gqRenderCache.

import type { ToneLUTs } from "./tone";

const VERT = `#version 300 es
layout(location = 0) in vec2 aPos;
out vec2 vUV;
void main() {
  vUV = aPos * 0.5 + 0.5;
  gl_Position = vec4(aPos, 0.0, 1.0);
}`;

const FRAG = `#version 300 es
precision highp float;
uniform sampler2D uSrc;
uniform sampler2D uLut;
in vec2 vUV;
out vec4 o;
void main() {
  vec4 c = texture(uSrc, vUV);
  float r = texture(uLut, vec2((c.r * 255.0 + 0.5) / 256.0, 0.5)).r;
  float g = texture(uLut, vec2((c.g * 255.0 + 0.5) / 256.0, 0.5)).g;
  float b = texture(uLut, vec2((c.b * 255.0 + 0.5) / 256.0, 0.5)).b;
  o = vec4(r, g, b, c.a);
}`;

export class GpuToneRenderer {
  readonly cs: PredefinedColorSpace;
  private canvas: HTMLCanvasElement;
  private gl: WebGL2RenderingContext;
  private srcTex: WebGLTexture;
  private lutTex: WebGLTexture;
  private lutBytes = new Uint8Array(256 * 4);
  private broken = false;

  private constructor(cs: PredefinedColorSpace, canvas: HTMLCanvasElement, gl: WebGL2RenderingContext) {
    this.cs = cs;
    this.canvas = canvas;
    this.gl = gl;
    canvas.addEventListener("webglcontextlost", (e) => {
      e.preventDefault(); // no restore path — the engine falls back to CPU
      this.broken = true;
    });

    const compile = (type: number, src: string): WebGLShader => {
      const sh = gl.createShader(type)!;
      gl.shaderSource(sh, src);
      gl.compileShader(sh);
      if (!gl.getShaderParameter(sh, gl.COMPILE_STATUS)) throw new Error(String(gl.getShaderInfoLog(sh)));
      return sh;
    };
    const prog = gl.createProgram()!;
    gl.attachShader(prog, compile(gl.VERTEX_SHADER, VERT));
    gl.attachShader(prog, compile(gl.FRAGMENT_SHADER, FRAG));
    gl.linkProgram(prog);
    if (!gl.getProgramParameter(prog, gl.LINK_STATUS)) throw new Error(String(gl.getProgramInfoLog(prog)));
    gl.useProgram(prog);

    // One clip-space triangle covering the viewport.
    const buf = gl.createBuffer()!;
    gl.bindBuffer(gl.ARRAY_BUFFER, buf);
    gl.bufferData(gl.ARRAY_BUFFER, new Float32Array([-1, -1, 3, -1, -1, 3]), gl.STATIC_DRAW);
    gl.enableVertexAttribArray(0);
    gl.vertexAttribPointer(0, 2, gl.FLOAT, false, 0, 0);

    const tex = (unit: number): WebGLTexture => {
      const t = gl.createTexture()!;
      gl.activeTexture(gl.TEXTURE0 + unit);
      gl.bindTexture(gl.TEXTURE_2D, t);
      gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MIN_FILTER, gl.NEAREST);
      gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MAG_FILTER, gl.NEAREST);
      gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_S, gl.CLAMP_TO_EDGE);
      gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_T, gl.CLAMP_TO_EDGE);
      return t;
    };
    this.srcTex = tex(0);
    this.lutTex = tex(1);
    gl.uniform1i(gl.getUniformLocation(prog, "uSrc"), 0);
    gl.uniform1i(gl.getUniformLocation(prog, "uLut"), 1);
  }

  /** Create a renderer for the working colour space, or null when the GPU path
   *  can't guarantee a match (no WebGL2; P3 without colour-space controls). */
  static create(cs: PredefinedColorSpace): GpuToneRenderer | null {
    if (typeof document === "undefined") return null;
    try {
      const canvas = document.createElement("canvas");
      const gl = canvas.getContext("webgl2", {
        alpha: true,
        antialias: false,
        depth: false,
        stencil: false,
        premultipliedAlpha: false,
        preserveDrawingBuffer: true,
      });
      if (!gl) return null;
      if (cs !== "srgb") {
        // Wide-gamut docs need explicit colour-space plumbing on both ends.
        const anyGl = gl as WebGL2RenderingContext & {
          drawingBufferColorSpace?: PredefinedColorSpace;
          unpackColorSpace?: PredefinedColorSpace;
        };
        if (!("drawingBufferColorSpace" in anyGl) || !("unpackColorSpace" in anyGl)) return null;
        anyGl.drawingBufferColorSpace = cs;
        anyGl.unpackColorSpace = cs;
      }
      return new GpuToneRenderer(cs, canvas, gl);
    } catch {
      return null;
    }
  }

  /** Apply `luts` to `src` (a w×h canvas) on the GPU. Returns the renderer's
   *  canvas — valid for immediate drawImage — or null when unavailable. */
  render(src: TexImageSource, w: number, h: number, luts: ToneLUTs): HTMLCanvasElement | null {
    if (this.broken || w < 1 || h < 1) return null;
    const gl = this.gl;
    try {
      if (this.canvas.width !== w || this.canvas.height !== h) {
        this.canvas.width = w;
        this.canvas.height = h;
      }
      gl.viewport(0, 0, w, h);

      // Source: unpremultiplied (getImageData semantics), Y-flipped so the
      // framebuffer's bottom-up orientation cancels out.
      gl.activeTexture(gl.TEXTURE0);
      gl.bindTexture(gl.TEXTURE_2D, this.srcTex);
      gl.pixelStorei(gl.UNPACK_PREMULTIPLY_ALPHA_WEBGL, false);
      gl.pixelStorei(gl.UNPACK_FLIP_Y_WEBGL, true);
      gl.texImage2D(gl.TEXTURE_2D, 0, gl.RGBA8, gl.RGBA, gl.UNSIGNED_BYTE, src);
      gl.pixelStorei(gl.UNPACK_FLIP_Y_WEBGL, false);

      // LUT: 256×1 RGBA — channel N of the texel maps channel N of the pixel.
      const lb = this.lutBytes;
      for (let i = 0; i < 256; i++) {
        lb[i * 4] = luts.r[i];
        lb[i * 4 + 1] = luts.g[i];
        lb[i * 4 + 2] = luts.b[i];
        lb[i * 4 + 3] = 255;
      }
      gl.activeTexture(gl.TEXTURE1);
      gl.bindTexture(gl.TEXTURE_2D, this.lutTex);
      gl.texImage2D(gl.TEXTURE_2D, 0, gl.RGBA8, 256, 1, 0, gl.RGBA, gl.UNSIGNED_BYTE, lb);

      gl.drawArrays(gl.TRIANGLES, 0, 3);
      return this.canvas;
    } catch {
      this.broken = true;
      return null;
    }
  }
}
