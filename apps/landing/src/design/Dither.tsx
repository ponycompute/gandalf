"use client";

import { useEffect, useRef } from "react";
import styles from "./Dither.module.css";

/** One dot of the dither, in CSS pixels. */
const CELL = 3;
/** Tones per color channel. */
const LEVELS = 8;
/** How fast the wallpaper drifts, and how far. */
const SPEED = 0.4;
const FLOW = 0.06;

const VERTEX = `#version 300 es
in vec2 pos;
void main() {
  gl_Position = vec4(pos, 0.0, 1.0);
}`;

// The --wallpaper gradients drawn in the shader, then read through a slow flow and posterized
// with an 8x8 ordered (Bayer) dither: the same effect as the Bayer Dither shader in Figma.
const FRAGMENT = `#version 300 es
precision highp float;
uniform vec2 size;
uniform float time;
uniform float levels;
uniform float flow;
uniform vec3 base0;
uniform vec3 base1;
uniform vec3 tints[3];
out vec4 color;

// A CSS radial-gradient(rx ry at cx cy, tint 0%, transparent stop).
vec3 radial(vec3 under, vec2 p, vec2 center, vec2 radius, vec3 tint, float stop) {
  float d = length((p - center) / radius);
  return mix(under, tint, clamp(1.0 - d / stop, 0.0, 1.0));
}

vec3 wallpaper(vec2 p) {
  vec3 c = mix(base0, base1, p.y);
  c = radial(c, p, vec2(0.6, 1.0), vec2(0.8, 0.7), tints[2], 0.7);
  c = radial(c, p, vec2(0.92, 0.18), vec2(0.6, 0.8), tints[1], 0.62);
  c = radial(c, p, vec2(0.12, 0.08), vec2(0.7, 0.9), tints[0], 0.6);
  return c;
}

float bayer8(uvec2 cell) {
  uint x = cell.x & 7u;
  uint y = cell.y & 7u;
  uint v = x ^ y;
  uint i = ((v & 1u) << 5u) | ((y & 1u) << 4u) | ((v & 2u) << 2u) | ((y & 2u) << 1u)
    | ((v & 4u) >> 1u) | ((y & 4u) >> 2u);
  return (float(i) + 0.5) / 64.0;
}

void main() {
  // One fragment is one dot; y runs down the page, as in CSS.
  vec2 cell = vec2(gl_FragCoord.x, size.y - gl_FragCoord.y);
  vec2 p = (floor(cell) + 0.5) / size;
  float k = 6.2831853;
  vec2 drift = vec2(
    sin(p.y * k + time) + 0.5 * sin((p.x + p.y) * k * 1.7 - time * 1.3),
    cos(p.x * k - time * 0.8) + 0.5 * cos((p.x - p.y) * k * 1.3 + time * 1.1)
  ) * flow;
  vec3 c = wallpaper(clamp(p + drift, 0.0, 1.0));
  float steps = levels - 1.0;
  vec3 q = floor(c * steps + bayer8(uvec2(cell))) / steps;
  color = vec4(clamp(q, 0.0, 1.0), 1.0);
}`;

// The --wallpaper colors in tokens.css: the two ends of the base, then the three tints from the
// top-left, top-right and bottom glows.
const PALETTES = {
  light: ["#f6eee8", "#eceaf3", "#f9d9c9", "#d9dcf6", "#f3e6d6"],
  dark: ["#221c1c", "#1b1b24", "#4a2a22", "#262a4a", "#3a2c22"],
} as const;

const rgb = (hex: string) => [1, 3, 5].map((i) => parseInt(hex.slice(i, i + 2), 16) / 255);

function compile(gl: WebGL2RenderingContext, type: number, source: string) {
  const shader = gl.createShader(type)!;
  gl.shaderSource(shader, source);
  gl.compileShader(shader);
  if (!gl.getShaderParameter(shader, gl.COMPILE_STATUS)) {
    throw new Error(gl.getShaderInfoLog(shader) ?? "shader did not compile");
  }
  return shader;
}

/**
 * The wallpaper as a slowly drifting ordered dither. It fills its positioned parent, behind the
 * parent's content; where WebGL2 is missing the parent's own background shows instead.
 */
export function Dither() {
  const ref = useRef<HTMLCanvasElement>(null);

  useEffect(() => {
    const canvas = ref.current!;
    const gl = canvas.getContext("webgl2", { antialias: false, premultipliedAlpha: false });
    if (gl === null) return;

    let program: WebGLProgram;
    try {
      program = gl.createProgram()!;
      gl.attachShader(program, compile(gl, gl.VERTEX_SHADER, VERTEX));
      gl.attachShader(program, compile(gl, gl.FRAGMENT_SHADER, FRAGMENT));
      gl.linkProgram(program);
      if (!gl.getProgramParameter(program, gl.LINK_STATUS)) return;
    } catch {
      return;
    }
    gl.useProgram(program);

    const quad = gl.createBuffer();
    gl.bindBuffer(gl.ARRAY_BUFFER, quad);
    gl.bufferData(gl.ARRAY_BUFFER, new Float32Array([-1, -1, 1, -1, -1, 1, 1, 1]), gl.STATIC_DRAW);
    const pos = gl.getAttribLocation(program, "pos");
    gl.enableVertexAttribArray(pos);
    gl.vertexAttribPointer(pos, 2, gl.FLOAT, false, 0, 0);

    const at = (name: string) => gl.getUniformLocation(program, name);
    gl.uniform1f(at("levels"), LEVELS);
    gl.uniform1f(at("flow"), FLOW);

    const dark = window.matchMedia("(prefers-color-scheme: dark)");
    const still = window.matchMedia("(prefers-reduced-motion: reduce)");
    const paint = () => {
      const [base0, base1, ...tints] = PALETTES[dark.matches ? "dark" : "light"];
      gl.uniform3fv(at("base0"), rgb(base0));
      gl.uniform3fv(at("base1"), rgb(base1));
      gl.uniform3fv(at("tints"), tints.flatMap(rgb));
    };
    paint();

    let frame = 0;
    let visible = false;
    const draw = (now: number) => {
      gl.uniform1f(at("time"), still.matches ? 0 : now * 0.001 * SPEED);
      gl.drawArrays(gl.TRIANGLE_STRIP, 0, 4);
    };
    const loop = (now: number) => {
      draw(now);
      frame = visible && !still.matches ? requestAnimationFrame(loop) : 0;
    };
    const start = () => {
      if (frame === 0) frame = requestAnimationFrame(loop);
    };

    // The canvas holds one pixel per dot and is scaled up without smoothing.
    const resize = () => {
      const width = Math.max(1, Math.ceil(canvas.clientWidth / CELL));
      const height = Math.max(1, Math.ceil(canvas.clientHeight / CELL));
      if (canvas.width !== width) canvas.width = width;
      if (canvas.height !== height) canvas.height = height;
      gl.viewport(0, 0, width, height);
      gl.uniform2f(at("size"), width, height);
      draw(performance.now());
    };
    resize();

    const sized = new ResizeObserver(resize);
    sized.observe(canvas);
    // Only the dithers on screen keep drawing.
    const seen = new IntersectionObserver((entries) => {
      visible = entries.some((entry) => entry.isIntersecting);
      if (visible) start();
    });
    seen.observe(canvas);
    const repaint = () => {
      paint();
      draw(performance.now());
      if (visible) start();
    };
    dark.addEventListener("change", repaint);
    still.addEventListener("change", repaint);

    return () => {
      cancelAnimationFrame(frame);
      sized.disconnect();
      seen.disconnect();
      dark.removeEventListener("change", repaint);
      still.removeEventListener("change", repaint);
      // The canvas keeps its context (a remount gets the same one back), so free only what this
      // run made.
      gl.deleteBuffer(quad);
      gl.deleteProgram(program);
    };
  }, []);

  return <canvas ref={ref} className={styles.dither} aria-hidden="true" />;
}
