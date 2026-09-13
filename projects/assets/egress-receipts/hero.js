/*
 * hero.js
 * Three.js hero scene for the egress receipts project page.
 *
 * The scene is one run of the system, read left to right:
 *
 *   sandbox        glass box with lit edges and an inner floor grid. The agent core
 *                  pulses inside it; a gold credential token sits beside it as bait.
 *   broker gate    ring with an iris on the +X face of the box. Every flow leaves
 *                  through it, and the particles are squeezed as they pass.
 *   enforcement    stack of thin plates under the gate. One plate lights each time a
 *   log            flow is written into the decision log.
 *   witness        lens outside the box, on the flows' path. A scan ring sweeps it,
 *                  and every flow it sees is dropped onto a leaf of the tree below.
 *   merkle tree    eight leaves, then their parents, then the root. The root pulses
 *                  up a dashed line to the public anchor.
 *   destinations   seven endpoint nodes on an arc; each flashes when its flow lands.
 *   decoy          a gold endpoint that the planted credential is the bait for. When
 *                  the gold flow reaches it the canary mark below it lights, and stays.
 *   anchor         tall slab, the public log; its ring flashes when the root arrives.
 *   receipt        thin card at the lower right. Three roots fly into it (witness,
 *                  enforcement, bait) and a seal pops once they are bound.
 *
 * Six small labels name the sandbox, the gate, the witness, the destinations, the
 * decoy and the anchor. They fade in once and hold at a muted opacity.
 *
 * Timing: one full story per LOOP seconds. Anything that has been built stays built,
 * so a frame grabbed at any time past the first loop shows the whole system, and the
 * reduced motion still (STILL_T) is that same fully assembled state.
 *
 * Public API
 *   initHero(canvas, opts) -> { pause, resume, destroy, setReducedMotion }
 *
 * opts (all optional)
 *   orbitPeriod   seconds per revolution of the scene group          default 45
 *   startAngle    initial yaw in radians                             default -0.45
 *   parallax      max parallax in radians                            default 0.055
 *   framePadding  how much air to leave around the scene               default 1.1
 *   offset        [x, y] shift in fractions of the visible half frame  default [0, 0]
 *   reducedMotion force the still frame from the start               default undefined
 *   respectPrefersReducedMotion                                      default true
 *   preserveDrawingBuffer  keep the buffer so headless tools can screenshot it
 *                          default false, the test harness turns it on
 *
 * Events dispatched on the canvas
 *   "hero-fallback"  WebGL is unavailable or the context was lost; show a static image
 *   "hero-ready"     detail { triangles, calls, points } after the first frame
 */

import * as THREE from "https://cdnjs.cloudflare.com/ajax/libs/three.js/0.160.0/three.module.min.js";

/* ------------------------------------------------------------------ palette */

const C = {
  teal: 0x5a9e8f,
  bright: 0x7bbdae,
  soft: 0xbfded6,
  ink: 0xeef4f7,
  gold: 0xd8b34a,
  danger: 0xa94438,
  slate: 0x1e3a4f,
  deep: 0x16313f,
};

/* --------------------------------------------------------------- quantities */

const FLOW_COUNT = 7; // the seven real destinations of the demo run
const PER_FLOW = 120;
const DECOY_PARTICLES = 140;
const TOTAL_PARTICLES = FLOW_COUNT * PER_FLOW + DECOY_PARTICLES; // 980
const LEAF_COUNT = 8; // seven real flows plus the bait flow
const TREE_NODES = 15;
const LOG_PLATES = 10;

/* -------------------------------------------------------------------- clock */

/* One loop is one run of the story. Everything below is loop local time. */
const LOOP = 7.6;
const LEAF_T0 = 0.5; // first flow is written into the tree
const LEAF_STEP = 0.42; // and one more every LEAF_STEP after that
const PARENT_LAG = 0.26; // a parent hashes this long after its later child
const CAPTURE_TRAVEL = 0.42; // witness to leaf
const GATE_LEAD = 0.34; // the gate sees a flow this long before the witness
const DEST_LAG = 0.36; // and the destination this long after
const PACKET_TRAVEL = 2.1; // agent to destination, for the bright packet

const DECOY_TRAVEL = 2.6;
const DECOY_EVERY = 2; // the gold run happens every other loop
const DECOY_T0 = 2.35; // so that it crosses the witness as leaf 7 is written

const ANCHOR_T0 = 4.5;
const ANCHOR_TRAVEL = 1.35;

const RECEIPT_T0 = 4.4; // the blank card wakes
const CHIP_T = [4.6, 4.85, 5.15]; // witness root, enforcement root, bait root
const CHIP_TRAVEL = 1.15;
const SEAL_T = 6.45;

const LABEL_T0 = 0.8;
const LABEL_FADE = 1.4;
const LABEL_STAGGER = 0.22;
const LABEL_ALPHA = 0.6;
const LABEL_PX = 33; // on screen height of the label bitmap, in css pixels

const STILL_T = 14.6; // frozen clock: second loop, everything bound and sealed
const ORBIT_EASE = 0.32; // dwell on the readable yaws, hurry past the end on ones

/* ------------------------------------------------------- layout, wide frame */

const BASE = {
  cubeHalf: 2.1,
  cube: [-8.05, 0.2, 0],
  gate: [-5.95, 0.2, 0],
  log: [-5.95, -3.62, 0.85],
  lens: [-2.3, 0.5, 0.15],
  credential: [-8.95, -1.62, 0.7],
  decoyEnd: [4.6, -4.9, 1.8],
  canary: [4.6, -6.12, 1.8],
  anchor: [9.7, 1.1, -1.3],
  receipt: [7.8, -4.55, 0.6],
  treeRoot: [-2.1, -2.05, 0.15],
  treeLeafY: -5.5,
  treeWidth: 5.0,
  destR: 8.2,
  destSpread: 0.8,
};

function destPosition(i) {
  const a = -BASE.destSpread + (i * (2 * BASE.destSpread)) / (FLOW_COUNT - 1);
  return new THREE.Vector3(
    BASE.lens[0] + BASE.destR * Math.cos(a) * 0.95,
    BASE.lens[1] + BASE.destR * Math.sin(a) * 0.58,
    BASE.lens[2] + Math.sin(a) * 2.2
  );
}

/* ------------------------------------------------------------------ shaders */

const GLOW_VERT = /* glsl */ `
  uniform vec2 uFog;
  varying vec3 vNrm;
  varying vec3 vDir;
  varying float vFog;
  void main() {
    vec4 mv = modelViewMatrix * vec4(position, 1.0);
    vNrm = normalize(normalMatrix * normal);
    vDir = normalize(-mv.xyz);
    vFog = smoothstep(uFog.x, uFog.y, -mv.z);
    gl_Position = projectionMatrix * mv;
  }
`;

/* Fresnel rim, a fixed key light and an optional highlight, so solids read as
   solids and the edges still carry the glow. No lights in the scene: the key is
   a view space direction, which keeps the shading stable while the group orbits.
   Depth fade at the end is the only fog: whatever the orbit swings away from the
   camera sinks back rather than staying at full strength. */
const GLOW_FRAG = /* glsl */ `
  uniform vec3 uCore;
  uniform vec3 uRim;
  uniform float uOpacity;
  uniform float uPower;
  uniform float uGain;
  uniform float uShade;
  uniform float uSpec;
  uniform float uSpecK;
  uniform vec3 uLight;
  varying vec3 vNrm;
  varying vec3 vDir;
  varying float vFog;
  void main() {
    vec3 n = normalize(vNrm);
    vec3 v = normalize(vDir);
    vec3 l = normalize(uLight);
    float f = 1.0 - clamp(abs(dot(n, v)), 0.0, 1.0);
    f = pow(f, uPower) * uGain;
    float key = dot(n, l) * 0.5 + 0.5;
    vec3 body = uCore * mix(uShade, 1.0, key * key);
    float spec = uSpecK > 0.0 ? pow(max(dot(n, normalize(l + v)), 0.0), uSpec) * uSpecK : 0.0;
    vec3 col = mix(body, uRim, clamp(f, 0.0, 1.0)) + uRim * spec;
    col *= mix(1.0, 0.42, vFog);
    gl_FragColor = vec4(col, uOpacity * mix(1.0, 0.62, vFog));
    #include <colorspace_fragment>
  }
`;

const POINT_VERT = /* glsl */ `
  attribute float aSize;
  attribute float aAlpha;
  attribute vec3 aColor;
  uniform float uScale;
  uniform vec2 uFog;
  varying vec3 vColor;
  varying float vAlpha;
  void main() {
    vec4 mv = modelViewMatrix * vec4(position, 1.0);
    vColor = aColor;
    vAlpha = aAlpha * mix(1.0, 0.45, smoothstep(uFog.x, uFog.y, -mv.z));
    gl_PointSize = aSize * (uScale / max(0.001, -mv.z));
    gl_Position = projectionMatrix * mv;
  }
`;

const POINT_FRAG = /* glsl */ `
  varying vec3 vColor;
  varying float vAlpha;
  void main() {
    float d = length(gl_PointCoord - vec2(0.5));
    float halo = smoothstep(0.5, 0.05, d);
    float core = smoothstep(0.24, 0.0, d);
    float a = (halo * halo * 0.8 + core * 0.5) * vAlpha;
    if (a <= 0.002) discard;
    gl_FragColor = vec4(vColor, a);
    #include <colorspace_fragment>
  }
`;

/* ------------------------------------------------------------------ helpers */

const KEY_LIGHT = new THREE.Vector3(-0.42, 0.78, 0.62).normalize();

/* one fog range, shared by every material in the scene: the fit writes it once
   per resize and all the shaders pick it up */
function makeFog() {
  return { value: new THREE.Vector2(20, 62) };
}

function glowMaterial(fog, core, rim, opacity, power, gain, extra, shade, spec) {
  const uniforms = {
    uCore: { value: new THREE.Color(core) },
    uRim: { value: new THREE.Color(rim) },
    uOpacity: { value: opacity },
    uPower: { value: power },
    uGain: { value: gain },
    uShade: { value: shade == null ? 0.58 : shade },
    uSpec: { value: spec ? spec[0] : 16 },
    uSpecK: { value: spec ? spec[1] : 0 },
    uLight: { value: KEY_LIGHT.clone() },
    uFog: fog,
  };
  const base = {
    uniforms,
    vertexShader: GLOW_VERT,
    fragmentShader: GLOW_FRAG,
    transparent: opacity < 1,
  };
  return new THREE.ShaderMaterial(Object.assign(base, extra || {}));
}

function decay(t, t0, k) {
  return t >= t0 ? Math.exp(-(t - t0) * k) : 0;
}

function bump(x, w) {
  return Math.exp(-(x * x) / (w * w));
}

/* 0 before t0, eases to 1 over d */
function ramp(t, t0, d) {
  const k = THREE.MathUtils.clamp((t - t0) / d, 0, 1);
  return k * k * (3 - 2 * k);
}

/* time since the most recent occurrence of a loop local event, or -1 if the
   event has not happened yet. Every schedule in the scene runs through this. */
function since(t, at, period) {
  const a = t - at;
  if (a < 0) return -1;
  return a % (period || LOOP);
}

/* progress 0..1 of the travel that ends at the next occurrence, else -1 */
function approach(t, at, travel, period) {
  const p = period || LOOP;
  const a = t - at;
  if (a >= 0) {
    const u = a % p;
    return u >= p - travel ? (u - (p - travel)) / travel : -1;
  }
  return a > -travel ? (a + travel) / travel : -1;
}

function webglSupported() {
  try {
    const probe = document.createElement("canvas");
    const gl = probe.getContext("webgl2") || probe.getContext("webgl");
    return !!(window.WebGLRenderingContext && gl);
  } catch (err) {
    return false;
  }
}

function noopHandle() {
  return {
    pause() {},
    resume() {},
    destroy() {},
    setReducedMotion() {},
  };
}

/* Dither a canvas in place. Every soft gradient in this scene is stretched over
   hundreds of pixels, which is exactly where eight bit ramps band; a little
   noise in the alpha channel costs nothing and removes the rings. */
function dither(ctx, w, h, amount) {
  const img = ctx.getImageData(0, 0, w, h);
  const d = img.data;
  for (let i = 0; i < d.length; i += 4) {
    const n = (Math.random() - 0.5) * amount;
    d[i + 3] = Math.max(0, Math.min(255, d[i + 3] + n));
  }
  ctx.putImageData(img, 0, 0);
}

/* soft additive dot, used for every emitter halo. The falloff is deliberately
   steep near the middle: a flat topped blob is what turns glow into mush. */
function radialTexture(stops) {
  const s = 256;
  const cv = document.createElement("canvas");
  cv.width = s;
  cv.height = s;
  const g = cv.getContext("2d");
  const grd = g.createRadialGradient(s / 2, s / 2, 0, s / 2, s / 2, s / 2);
  for (const st of stops) grd.addColorStop(st[0], `rgba(255,255,255,${st[1]})`);
  g.fillStyle = grd;
  g.fillRect(0, 0, s, s);
  dither(g, s, s, 5);
  const tex = new THREE.CanvasTexture(cv);
  tex.colorSpace = THREE.SRGBColorSpace;
  return tex;
}

/* fine monochrome grain, laid over the whole frame at a very low opacity: it
   dithers the page's own background ramp as well as the scene's gradients */
function grainTexture() {
  const s = 128;
  const cv = document.createElement("canvas");
  cv.width = s;
  cv.height = s;
  const g = cv.getContext("2d");
  const img = g.createImageData(s, s);
  const d = img.data;
  for (let i = 0; i < d.length; i += 4) {
    d[i] = d[i + 1] = d[i + 2] = 255;
    // triangular noise: mostly mid, so the mean lift stays invisible
    d[i + 3] = Math.round(((Math.random() + Math.random()) / 2) * 255);
  }
  g.putImageData(img, 0, 0);
  const tex = new THREE.CanvasTexture(cv);
  tex.colorSpace = THREE.SRGBColorSpace;
  tex.wrapS = tex.wrapT = THREE.RepeatWrapping;
  tex.magFilter = THREE.NearestFilter;
  tex.minFilter = THREE.NearestFilter;
  tex.generateMipmaps = false;
  return tex;
}

/* one label bitmap: uppercase, letterspaced, mono, with a dark halo so it stays
   readable wherever the scene drifts underneath it */
function labelTexture(text) {
  const px = 44;
  const cv = document.createElement("canvas");
  const ctx = cv.getContext("2d");
  const plex =
    document.fonts && document.fonts.check && document.fonts.check('500 12px "IBM Plex Mono"');
  const font = `500 ${px}px ${plex ? '"IBM Plex Mono", ui-monospace, monospace' : "ui-monospace, monospace"}`;
  const track = px * 0.16;
  const chars = Array.from(text.toUpperCase());
  ctx.font = font;
  let w = 0;
  for (const ch of chars) w += ctx.measureText(ch).width + track;
  const padX = Math.round(px * 0.8);
  const padY = Math.round(px * 0.62);
  cv.width = Math.ceil(w + padX * 2);
  cv.height = Math.ceil(px * 1.32 + padY * 2);
  ctx.font = font; // the resize above cleared the context state
  ctx.textBaseline = "middle";
  ctx.shadowColor = "rgba(9,24,34,0.95)";
  ctx.shadowBlur = px * 0.62;
  ctx.fillStyle = "#d3e8e1";
  let x = padX;
  for (let pass = 0; pass < 2; pass++) {
    x = padX;
    for (const ch of chars) {
      ctx.fillText(ch, x, cv.height / 2);
      x += ctx.measureText(ch).width + track;
    }
  }
  const tex = new THREE.CanvasTexture(cv);
  tex.colorSpace = THREE.SRGBColorSpace;
  tex.minFilter = THREE.LinearMipmapLinearFilter;
  tex.generateMipmaps = true;
  return { texture: tex, aspect: cv.width / cv.height };
}

/* ==================================================================== init  */

export function initHero(canvas, opts = {}) {
  if (!canvas || !webglSupported()) {
    if (canvas && canvas.dispatchEvent) {
      setTimeout(() => canvas.dispatchEvent(new CustomEvent("hero-fallback")), 0);
    }
    return noopHandle();
  }

  const orbitPeriod = opts.orbitPeriod || 45;
  const parallaxMax = opts.parallax == null ? 0.055 : opts.parallax;
  const startAngle = opts.startAngle == null ? -0.45 : opts.startAngle;
  const framePadding = opts.framePadding || 1.1;
  const offset = opts.offset || [0, 0];

  let renderer;
  try {
    renderer = new THREE.WebGLRenderer({
      canvas,
      alpha: true,
      antialias: true,
      powerPreference: "high-performance",
      preserveDrawingBuffer: !!opts.preserveDrawingBuffer,
    });
  } catch (err) {
    setTimeout(() => canvas.dispatchEvent(new CustomEvent("hero-fallback")), 0);
    return noopHandle();
  }
  renderer.setClearAlpha(0);
  // 2 on the page, so a retina laptop stays at 60fps. The screenshot harness
  // asks for preserveDrawingBuffer and renders a single frame, so it is allowed
  // the full ratio and can be driven at --force-device-scale-factor 3.
  renderer.setPixelRatio(Math.min(opts.preserveDrawingBuffer ? 3 : 2, window.devicePixelRatio || 1));

  const scene = new THREE.Scene();
  const camera = new THREE.PerspectiveCamera(40, 1, 0.5, 160);
  scene.add(camera); // the grain plane rides on the camera

  const root = new THREE.Group(); // layout tilt and scale, set by the fit
  const orbit = new THREE.Group(); // yaw revolution plus parallax
  root.add(orbit);
  scene.add(root);

  const disposables = [];
  const track = (obj) => {
    disposables.push(obj);
    return obj;
  };

  const FOG = makeFog(); // shared by every material, written by the fit
  const glow = (core, rim, opacity, power, gain, extra, shade, spec) =>
    track(glowMaterial(FOG, core, rim, opacity, power, gain, extra, shade, spec));

  /* every scene object goes in through here: make the mesh, put it where the
     layout says, optionally yaw it, and park it in the orbiting group */
  const place = (geo, mat, pos, rotY, parent) => {
    const m = new THREE.Mesh(geo, mat);
    if (pos) m.position.copy(pos);
    if (rotY) m.rotation.y = rotY;
    (parent || orbit).add(m);
    return m;
  };

  const glowTex = track(
    radialTexture([
      [0, 0.95],
      [0.1, 0.5],
      [0.26, 0.16],
      [0.55, 0.035],
      [1, 0],
    ])
  );
  const hazeTex = track(
    radialTexture([
      [0, 0.5],
      [0.3, 0.3],
      [0.62, 0.1],
      [1, 0],
    ])
  );
  const glowSprite = (color, size, pos, opacity, parent) => {
    const mat = track(
      new THREE.SpriteMaterial({
        map: glowTex,
        color: new THREE.Color(color),
        transparent: true,
        opacity: opacity == null ? 0.5 : opacity,
        depthWrite: false,
        blending: THREE.AdditiveBlending,
      })
    );
    const s = new THREE.Sprite(mat);
    s.scale.setScalar(size);
    if (pos) s.position.copy(pos);
    (parent || orbit).add(s);
    return s;
  };

  const lineMaterial = (color, opacity, dashed) => {
    const o = { color: new THREE.Color(color), transparent: true, opacity };
    if (dashed) {
      o.dashSize = 0.3;
      o.gapSize = 0.24;
      return track(new THREE.LineDashedMaterial(o));
    }
    return track(new THREE.LineBasicMaterial(o));
  };

  const segments = (pts, mat, dashed) => {
    const geo = track(new THREE.BufferGeometry());
    geo.setAttribute("position", new THREE.Float32BufferAttribute(pts, 3));
    const l = new THREE.LineSegments(geo, mat);
    if (dashed) l.computeLineDistances();
    orbit.add(l);
    return l;
  };

  /* a thin rod from a to b, drawn from a so it can grow out of its child */
  const linkGeo = track(new THREE.CylinderGeometry(0.024, 0.024, 1, 5, 1, true));
  linkGeo.translate(0, 0.5, 0);
  const UP = new THREE.Vector3(0, 1, 0);
  const rod = (a, b, mat, parent) => {
    const m = new THREE.Mesh(linkGeo, mat);
    const d = new THREE.Vector3().subVectors(b, a);
    m.position.copy(a);
    m.quaternion.setFromUnitVectors(UP, d.clone().normalize());
    m.scale.set(1, d.length(), 1);
    m.userData.len = d.length();
    (parent || orbit).add(m);
    return m;
  };

  /* ------------------------------------------------------------- backdrop  */

  const backGeo = track(new THREE.PlaneGeometry(1, 1));
  const backdrop = new THREE.Mesh(
    backGeo,
    track(
      new THREE.MeshBasicMaterial({
        map: hazeTex,
        color: new THREE.Color(0x2f6d86),
        transparent: true,
        opacity: 0.16,
        depthWrite: false,
        depthTest: false,
        blending: THREE.AdditiveBlending,
      })
    )
  );
  backdrop.renderOrder = -10;
  scene.add(backdrop);

  /* grain: a fixed screen space layer, so the page's own background ramp and
     every soft glow in here get dithered instead of banding */
  const grainTex = track(grainTexture());
  const grain = new THREE.Mesh(
    backGeo,
    track(
      new THREE.MeshBasicMaterial({
        map: grainTex,
        transparent: true,
        opacity: 0.032,
        depthWrite: false,
        depthTest: false,
        blending: THREE.AdditiveBlending,
      })
    )
  );
  grain.renderOrder = 40;
  grain.position.set(0, 0, -6);
  camera.add(grain);

  /* ----------------------------------------------------------- sandbox cube */

  const cubePos = new THREE.Vector3().fromArray(BASE.cube);
  const half = BASE.cubeHalf;

  // two passes of the same box, back faces first: the far wall shows through the
  // near wall, which is what makes it read as glass rather than as a wire cage
  const glassGeo = track(new THREE.BoxGeometry(half * 2, half * 2, half * 2));
  const backBlend = { side: THREE.BackSide, depthWrite: false, blending: THREE.AdditiveBlending };
  const frontBlend = { side: THREE.FrontSide, depthWrite: false, blending: THREE.AdditiveBlending };
  const glassInMat = glow(0x11333f, C.teal, 0.3, 2.0, 1.1, backBlend, 0.9);
  const glassMat = glow(0x123642, C.bright, 0.26, 3.2, 1.9, frontBlend, 0.85, [30, 0.2]);
  place(glassGeo, glassInMat, cubePos).renderOrder = -2;
  place(glassGeo, glassMat, cubePos).renderOrder = -1;

  // twelve glowing edge tubes
  const edgeGeoLong = track(new THREE.CylinderGeometry(0.045, 0.045, half * 2, 8, 1, true));
  const edgeMat = glow(C.bright, C.ink, 1, 1.5, 1.7, null, 0.7, [30, 0.45]);
  const edgeGroup = new THREE.Group();
  edgeGroup.position.copy(cubePos);
  for (const a of [-half, half]) {
    for (const b of [-half, half]) {
      // one tube per axis direction, through the four corner pairs
      for (const spec of [[0, a, b, 0, 0, Math.PI / 2], [a, 0, b, 0, 0, 0], [a, b, 0, Math.PI / 2, 0, 0]]) {
        const m = new THREE.Mesh(edgeGeoLong, edgeMat);
        m.position.set(spec[0], spec[1], spec[2]);
        m.rotation.set(spec[3], spec[4], spec[5]);
        edgeGroup.add(m);
      }
    }
  }
  orbit.add(edgeGroup);

  // floor grid inside the box, so the box reads as a room and not a wireframe
  const gridPts = [];
  const cells = 6;
  for (let i = 0; i <= cells; i++) {
    const u = -half + (i * half * 2) / cells;
    gridPts.push(u, -half + 0.01, -half, u, -half + 0.01, half);
    gridPts.push(-half, -half + 0.01, u, half, -half + 0.01, u);
  }
  const gridGeo = track(new THREE.BufferGeometry());
  gridGeo.setAttribute("position", new THREE.Float32BufferAttribute(gridPts, 3));
  const gridMat = lineMaterial(C.bright, 0.6);
  const grid = new THREE.LineSegments(gridGeo, gridMat);
  grid.position.copy(cubePos);
  orbit.add(grid);

  /* ------------------------------------------------------------ agent core */

  const corePos = cubePos.clone().add(new THREE.Vector3(0.24, -0.26, 0.25));
  const coreGeo = track(new THREE.IcosahedronGeometry(0.72, 0));
  const coreMat = glow(0x2a7d70, C.ink, 1, 2.2, 1.5, null, 0.34, [26, 0.7]);
  const core = place(coreGeo, coreMat, corePos);

  const haloGeo = track(new THREE.IcosahedronGeometry(1.04, 2));
  const haloBlend = { side: THREE.BackSide, depthWrite: false, blending: THREE.AdditiveBlending };
  const haloMat = glow(C.teal, C.bright, 0.16, 3.2, 1.5, haloBlend, 1);
  const halo = place(haloGeo, haloMat, corePos);
  const coreGlow = glowSprite(C.bright, 3.0, corePos, 0.3);

  // a thin ring around the core, tipped, so the core reads as a running process
  const coreRingGeo = track(new THREE.TorusGeometry(1.16, 0.02, 4, 44));
  const coreRingMat = glow(C.soft, C.ink, 0.55, 1.5, 1.5);
  const coreRing = place(coreRingGeo, coreRingMat, corePos);
  coreRing.rotation.x = 0.42;

  /* ---------------------------------------------------- planted credential */

  const credPos = new THREE.Vector3().fromArray(BASE.credential);
  const tokenGeo = track(new THREE.OctahedronGeometry(0.33, 0));
  const tokenMat = glow(0x8a6d1f, C.gold, 1, 1.4, 2, null, 0.5, [30, 0.55]);
  const token = place(tokenGeo, tokenMat, credPos);
  const tokenGlow = glowSprite(C.gold, 1.9, credPos, 0.5);

  /* ------------------------------------------------------------ broker gate */

  const gatePos = new THREE.Vector3().fromArray(BASE.gate);
  const gateGeo = track(new THREE.TorusGeometry(1.18, 0.09, 8, 44));
  const gateMat = glow(C.bright, C.ink, 1, 1.5, 1.9, null, 0.5, [30, 0.32]);
  place(gateGeo, gateMat, gatePos, Math.PI / 2);

  // iris blades: the aperture every flow is squeezed through
  const bladeGeo = track(new THREE.BoxGeometry(0.44, 0.075, 0.075));
  const bladeMat = glow(C.soft, C.ink, 1, 1.5, 1.6, null, 0.55);
  const irisGroup = new THREE.Group();
  irisGroup.position.copy(gatePos);
  irisGroup.rotation.y = Math.PI / 2;
  const blades = [];
  for (let k = 0; k < 6; k++) {
    const a = (k * Math.PI) / 3 + 0.22;
    const m = new THREE.Mesh(bladeGeo, bladeMat);
    m.position.set(Math.cos(a) * 0.86, Math.sin(a) * 0.86, 0);
    m.rotation.z = a;
    irisGroup.add(m);
    blades.push(m);
  }
  orbit.add(irisGroup);

  const discBase = {
    transparent: true,
    side: THREE.DoubleSide,
    blending: THREE.AdditiveBlending,
    depthWrite: false,
  };
  const gateDiscGeo = track(new THREE.RingGeometry(0.5, 1.14, 40, 1));
  const gateDiscMat = track(
    new THREE.MeshBasicMaterial({ ...discBase, color: new THREE.Color(C.bright), opacity: 0.14 })
  );
  place(gateDiscGeo, gateDiscMat, gatePos, Math.PI / 2);
  const gateGlow = glowSprite(C.ink, 2.6, gatePos, 0.22);

  /* -------------------------------------------------------- enforcement log */

  const logPos = new THREE.Vector3().fromArray(BASE.log);
  const plateGeo = track(new THREE.BoxGeometry(1.32, 0.08, 0.92));
  const plates = [];
  const plateMats = [];
  const PLATE_GAP = 0.28;
  for (let i = 0; i < LOG_PLATES; i++) {
    const mat = glow(0x22505f, 0x8fb6b0, 0.95, 1.8, 1.0, { transparent: true }, 0.5, [24, 0.3]);
    const m = place(
      plateGeo,
      mat,
      new THREE.Vector3(
        logPos.x,
        logPos.y - ((LOG_PLATES - 1) / 2) * PLATE_GAP + i * PLATE_GAP,
        logPos.z
      )
    );
    m.rotation.y = 0.22;
    plates.push(m);
    plateMats.push(mat);
  }
  // the enforcement root sits on top of the stack
  const logRootPos = new THREE.Vector3(
    logPos.x,
    logPos.y + ((LOG_PLATES - 1) / 2) * PLATE_GAP + 0.42,
    logPos.z
  );
  const logRootGeo = track(new THREE.IcosahedronGeometry(0.26, 1));
  const logRootMat = glow(C.bright, C.ink, 1, 1.5, 1.9, null, 0.5);
  const logRoot = place(logRootGeo, logRootMat, logRootPos);
  const logGlow = glowSprite(C.bright, 1.5, logRootPos, 0.35);
  // the gate feeds the stack
  segments(
    [gatePos.x, gatePos.y - 1.2, gatePos.z, logRootPos.x, logRootPos.y + 0.3, logRootPos.z],
    lineMaterial(C.soft, 0.2)
  );

  /* ----------------------------------------------------------- witness lens */

  const lensPos = new THREE.Vector3().fromArray(BASE.lens);
  const lensGeo = track(new THREE.TorusGeometry(1.72, 0.115, 8, 44));
  const lensMat = glow(C.teal, C.soft, 1, 1.7, 1.7, null, 0.5, [26, 0.34]);
  const lens = place(lensGeo, lensMat, lensPos, Math.PI / 2);

  const irisRingGeo = track(new THREE.TorusGeometry(1.12, 0.045, 6, 36));
  const irisRingMat = glow(C.soft, C.ink, 0.85, 1.6, 1.6);
  const irisRing = place(irisRingGeo, irisRingMat, lensPos, Math.PI / 2);

  const pupilGeo = track(new THREE.TorusGeometry(0.52, 0.03, 5, 28));
  const pupilMat = glow(C.ink, C.ink, 0.8, 1.5, 1.6);
  const pupil = place(pupilGeo, pupilMat, lensPos, Math.PI / 2);

  const lensDiscGeo = track(new THREE.CircleGeometry(1.66, 40));
  const lensDiscMat = track(
    new THREE.MeshBasicMaterial({ ...discBase, color: new THREE.Color(C.soft), opacity: 0.07 })
  );
  place(lensDiscGeo, lensDiscMat, lensPos, Math.PI / 2);
  const lensGlow = glowSprite(C.soft, 3.2, lensPos, 0.2);

  // scan ring: sweeps outward from the lens every couple of seconds
  const scanGeo = track(new THREE.TorusGeometry(1, 0.03, 4, 40));
  const scanMat = glow(C.soft, C.ink, 0.4, 1.5, 1.6, { transparent: true });
  const scan = place(scanGeo, scanMat, lensPos, Math.PI / 2);

  /* ---------------------------------------------------- destinations, decoy */

  const destGeo = track(new THREE.SphereGeometry(0.36, 18, 12));
  const destMeshes = [];
  const destMats = [];
  const destPositions = [];
  const destGlows = [];
  for (let i = 0; i < FLOW_COUNT; i++) {
    const p = destPosition(i);
    destPositions.push(p);
    const k = i / (FLOW_COUNT - 1);
    const body = new THREE.Color(C.teal).lerp(new THREE.Color(C.soft), k * 0.7).getHex();
    const mat = glow(body, C.ink, 1, 1.9, 1.5, null, 0.5, [34, 0.42]);
    destMats.push(mat);
    destMeshes.push(place(destGeo, mat, p));
    destGlows.push(glowSprite(C.soft, 1.7, p, 0.22));
  }

  // the arc the endpoints sit on, so they read as one set
  const arcPts = [];
  for (let i = 0; i < FLOW_COUNT - 1; i++) {
    const a = destPositions[i];
    const b = destPositions[i + 1];
    for (let k = 0; k < 6; k++) {
      arcPts.push(
        THREE.MathUtils.lerp(a.x, b.x, k / 6), THREE.MathUtils.lerp(a.y, b.y, k / 6), THREE.MathUtils.lerp(a.z, b.z, k / 6),
        THREE.MathUtils.lerp(a.x, b.x, (k + 0.55) / 6), THREE.MathUtils.lerp(a.y, b.y, (k + 0.55) / 6), THREE.MathUtils.lerp(a.z, b.z, (k + 0.55) / 6)
      );
    }
  }
  segments(arcPts, lineMaterial(C.soft, 0.42));

  const decoyEnd = new THREE.Vector3().fromArray(BASE.decoyEnd);
  const decoyGeo = track(new THREE.SphereGeometry(0.42, 18, 12));
  const decoyMat = glow(0x7d6320, C.gold, 1, 1.6, 1.9, null, 0.5, [34, 0.5]);
  const decoyMesh = place(decoyGeo, decoyMat, decoyEnd);
  const decoyGlow = glowSprite(C.gold, 2.6, decoyEnd, 0.4);

  const decoyRingGeo = track(new THREE.TorusGeometry(0.74, 0.038, 6, 34));
  const decoyRingMat = glow(C.gold, C.ink, 0.8, 1.5, 1.6);
  const decoyRing = place(decoyRingGeo, decoyRingMat, decoyEnd);
  decoyRing.rotation.z = 0.5;

  // canary mark: lights when the bait is taken, and stays lit
  const canaryPos = new THREE.Vector3().fromArray(BASE.canary);
  const canaryGeo = track(new THREE.OctahedronGeometry(0.26, 0));
  const canaryMat = glow(0x6f5a1c, C.gold, 1, 1.4, 1.9, { transparent: true }, 0.5);
  const canary = place(canaryGeo, canaryMat, canaryPos);
  const canaryRingGeo = track(new THREE.TorusGeometry(0.4, 0.024, 4, 28));
  const canaryRingMat = glow(C.gold, C.ink, 0.7, 1.5, 1.6, { transparent: true });
  const canaryRing = place(canaryRingGeo, canaryRingMat, canaryPos);
  const canaryGlow = glowSprite(C.gold, 1.7, canaryPos, 0);
  segments(
    [decoyEnd.x, decoyEnd.y - 0.5, decoyEnd.z, canaryPos.x, canaryPos.y + 0.4, canaryPos.z],
    lineMaterial(C.gold, 0.28)
  );

  /* ------------------------------------------------------------ merkle tree */

  const treeRoot = new THREE.Vector3().fromArray(BASE.treeRoot);
  const levelH = (BASE.treeRoot[1] - BASE.treeLeafY) / 3;
  const nodePos = [];
  for (let j = 0; j < LEAF_COUNT; j++) {
    nodePos.push(
      new THREE.Vector3(
        treeRoot.x + (j - 3.5) * (BASE.treeWidth / 7),
        BASE.treeLeafY,
        treeRoot.z
      )
    );
  }
  const addRow = (first, count, y) => {
    for (let j = 0; j < count; j++) {
      const x = (nodePos[first + j * 2].x + nodePos[first + j * 2 + 1].x) / 2;
      nodePos.push(new THREE.Vector3(x, y, treeRoot.z));
    }
  };
  addRow(0, 4, BASE.treeLeafY + levelH);
  addRow(8, 2, BASE.treeLeafY + levelH * 2);
  nodePos.push(treeRoot.clone());

  /* when each node is written, in loop local seconds: leaves on the flow
     schedule, every parent a beat after its later child */
  const nodeT = new Array(TREE_NODES);
  for (let j = 0; j < LEAF_COUNT; j++) nodeT[j] = LEAF_T0 + j * LEAF_STEP;
  const CHILDREN = { 8: [0, 1], 9: [2, 3], 10: [4, 5], 11: [6, 7], 12: [8, 9], 13: [10, 11], 14: [12, 13] };
  for (let id = 8; id < TREE_NODES; id++) {
    const kids = CHILDREN[id];
    nodeT[id] = Math.max(nodeT[kids[0]], nodeT[kids[1]]) + PARENT_LAG;
  }

  const leafGeo = track(new THREE.BoxGeometry(0.34, 0.34, 0.34));
  const midGeo = track(new THREE.IcosahedronGeometry(0.24, 1));
  const topGeo = track(new THREE.IcosahedronGeometry(0.34, 1));
  const treeMeshes = [];
  const treeMats = [];
  for (let id = 0; id < TREE_NODES; id++) {
    const isBait = id === 7; // the eighth leaf is the bait flow
    const core = isBait ? 0x7d6320 : id === 14 ? C.bright : C.teal;
    const rim = isBait ? C.gold : id === 14 ? C.ink : C.soft;
    const mat = glow(core, rim, 1, 1.7, 1.7, { transparent: true }, 0.5, [30, 0.34]);
    treeMats.push(mat);
    treeMeshes.push(
      place(id < LEAF_COUNT ? leafGeo : id === 14 ? topGeo : midGeo, mat, nodePos[id])
    );
  }
  const rootGlow = glowSprite(C.bright, 2.2, treeRoot, 0.3);

  const treeLinkMat = glow(C.bright, C.ink, 0.78, 1.6, 1.5, { transparent: true }, 0.75);
  const treeLinks = [];
  for (let id = 8; id < TREE_NODES; id++) {
    for (const kid of CHILDREN[id]) {
      const m = rod(nodePos[kid], nodePos[id], treeLinkMat);
      m.userData.at = nodeT[id];
      treeLinks.push(m);
    }
  }

  // the witness feeds the tree
  const feedTop = new THREE.Vector3(lensPos.x, lensPos.y - 1.85, lensPos.z);
  segments([feedTop.x, feedTop.y, feedTop.z, treeRoot.x, treeRoot.y + 0.3, treeRoot.z], lineMaterial(C.soft, 0.26));

  // the bead that carries one observation from the witness down to a leaf
  const beadGeo = track(new THREE.IcosahedronGeometry(0.12, 1));
  const captureBeadMat = glow(C.soft, C.ink, 1, 1.4, 1.8);
  const captureBead = place(beadGeo, captureBeadMat);
  captureBead.visible = false;

  /* ---------------------------------------------------------------- anchor */

  const anchorPos = new THREE.Vector3().fromArray(BASE.anchor);
  const slabGeo = track(new THREE.BoxGeometry(0.86, 6.2, 0.38));
  const slabMat = glow(0x9fb9c6, C.ink, 1, 1.6, 1.7, null, 0.55, [22, 0.35]);
  place(slabGeo, slabMat, anchorPos);

  // entries already in the public log: faint ticks up the slab
  const tickPts = [];
  for (let i = 0; i < 9; i++) {
    const y = anchorPos.y - 2.5 + i * 0.62;
    tickPts.push(anchorPos.x - 0.52, y, anchorPos.z + 0.22, anchorPos.x + 0.52, y, anchorPos.z + 0.22);
  }
  segments(tickPts, lineMaterial(C.slate, 0.5));

  const aRingGeo = track(new THREE.TorusGeometry(1.55, 0.1, 8, 36));
  const aRingMat = glow(C.teal, C.soft, 0.95, 1.5, 1.8, null, 0.55, [26, 0.3]);
  const aRingSpin = new THREE.Group();
  aRingSpin.position.set(anchorPos.x, anchorPos.y + 0.7, anchorPos.z);
  const aRing = new THREE.Mesh(aRingGeo, aRingMat);
  aRing.rotation.x = Math.PI / 2 - 0.42; // tilted, so the spin below is visible
  aRingSpin.add(aRing);
  orbit.add(aRingSpin);
  const anchorGlow = glowSprite(C.bright, 3.6, aRingSpin.position, 0.22);

  const capGeo = track(new THREE.IcosahedronGeometry(0.22, 1));
  const capMat = glow(C.ink, C.bright, 1, 1.4, 1.6);
  const cap = place(capGeo, capMat);
  cap.position.set(anchorPos.x, anchorPos.y + 3.3, anchorPos.z);

  // dashed path the root travels to reach the public log
  const anchorLine = segments(
    [treeRoot.x, treeRoot.y, treeRoot.z, aRingSpin.position.x, aRingSpin.position.y, aRingSpin.position.z],
    lineMaterial(C.soft, 0.26, true),
    true
  );
  const anchorBeadMat = glow(C.bright, C.ink, 1, 1.4, 1.8);
  const anchorBead = place(beadGeo, anchorBeadMat);
  anchorBead.visible = false;

  /* --------------------------------------------------------------- receipt */

  const receiptGroup = new THREE.Group();
  receiptGroup.position.fromArray(BASE.receipt);
  receiptGroup.rotation.y = 0.42;
  orbit.add(receiptGroup);

  const CARD_W = 3.0;
  const CARD_H = 2.0;
  const cardGeo = track(new THREE.PlaneGeometry(CARD_W, CARD_H));
  const cardMat = track(
    new THREE.MeshBasicMaterial({
      color: new THREE.Color(0x8fc7c0),
      transparent: true,
      opacity: 0.1,
      side: THREE.DoubleSide,
      depthWrite: false,
      blending: THREE.AdditiveBlending,
    })
  );
  const card = new THREE.Mesh(cardGeo, cardMat);
  receiptGroup.add(card);

  const borderPts = [];
  const bx = CARD_W / 2;
  const by = CARD_H / 2;
  const corners = [
    [-bx, -by],
    [bx, -by],
    [bx, by],
    [-bx, by],
  ];
  for (let i = 0; i < 4; i++) {
    const a = corners[i];
    const b = corners[(i + 1) % 4];
    borderPts.push(a[0], a[1], 0, b[0], b[1], 0);
  }
  const borderGeo = track(new THREE.BufferGeometry());
  borderGeo.setAttribute("position", new THREE.Float32BufferAttribute(borderPts, 3));
  const borderMat = lineMaterial(C.ink, 0.8);
  const cardBorder = new THREE.LineSegments(borderGeo, borderMat);
  receiptGroup.add(cardBorder);

  // rulings, standing in for the rows of the receipt
  const rulePts = [];
  const ruleRows = [0.12, -0.16, -0.44, -0.72];
  for (let r = 0; r < ruleRows.length; r++) {
    const y = ruleRows[r];
    const wEnd = [0.55, 0.75, 0.3, -0.1][r];
    for (let x = -1.18; x < wEnd; x += 0.28) {
      rulePts.push(x, y, 0.01, Math.min(x + 0.19, wEnd), y, 0.01);
    }
  }
  rulePts.push(-1.18, 0.38, 0.01, 1.18, 0.38, 0.01);
  const ruleGeo = track(new THREE.BufferGeometry());
  ruleGeo.setAttribute("position", new THREE.Float32BufferAttribute(rulePts, 3));
  const ruleMat = lineMaterial(C.soft, 0.34);
  const rulings = new THREE.LineSegments(ruleGeo, ruleMat);
  receiptGroup.add(rulings);

  // three root chips across the top of the card
  const chipGeo = track(new THREE.BoxGeometry(0.62, 0.22, 0.07));
  const CHIP_COLOR = [C.teal, C.teal, C.gold];
  const CHIP_RIM = [C.soft, C.soft, C.ink];
  const chipSlots = [];
  const chipMeshes = [];
  const chipMats = [];
  const flyers = [];
  const flySource = [treeRoot, logRootPos, canaryPos];
  for (let i = 0; i < 3; i++) {
    const local = new THREE.Vector3(-0.92 + i * 0.92, 0.62, 0.04);
    const mat = glow(CHIP_COLOR[i], CHIP_RIM[i], 1, 1.5, 1.8, { transparent: true }, 0.55, [28, 0.4]);
    chipMats.push(mat);
    const m = new THREE.Mesh(chipGeo, mat);
    m.position.copy(local);
    receiptGroup.add(m);
    chipMeshes.push(m);
    receiptGroup.updateMatrix();
    chipSlots.push(local.clone().applyMatrix4(receiptGroup.matrix));
    const fm = glow(CHIP_COLOR[i], CHIP_RIM[i], 1, 1.4, 1.9, null, 0.5);
    const f = place(beadGeo, fm, flySource[i]);
    f.visible = false;
    flyers.push(f);
  }

  // seal
  const sealGroup = new THREE.Group();
  sealGroup.position.set(1.02, -0.58, 0.03);
  receiptGroup.add(sealGroup);
  const sealGeo = track(new THREE.TorusGeometry(0.24, 0.035, 6, 24));
  const sealMat = glow(C.bright, C.ink, 1, 1.4, 1.8, { transparent: true }, 0.5);
  const seal = new THREE.Mesh(sealGeo, sealMat);
  sealGroup.add(seal);
  const sealDotGeo = track(new THREE.IcosahedronGeometry(0.085, 1));
  const sealDot = new THREE.Mesh(sealDotGeo, sealMat);
  sealGroup.add(sealDot);
  const sealGlow = glowSprite(C.bright, 1.4, null, 0, receiptGroup);
  sealGlow.position.copy(sealGroup.position);

  /* ---------------------------------------------------------------- labels */

  const LABELS = [
    ["sandbox", [-8.65, 3.05, 0]],
    ["broker gate", [-5.3, 2.88, 0.45]],
    ["witness", [-2.05, 3.1, 0.15]],
    ["destinations", [4.35, 4.8, 1.4]],
    ["decoy", [4.6, -3.7, 1.8]],
    ["public anchor", [9.2, 4.95, -1.3]],
  ];
  const LEADERS = [
    [-8.65, 2.76, 0, -8.65, 2.36, 0],
    [-5.36, 2.64, 0.42, -5.78, 1.5, 0.1],
    [-2.05, 2.84, 0.15, -2.16, 2.34, 0.15],
    [4.16, 4.55, 1.45, 3.45, 4.14, 1.55],
    [4.6, -3.96, 1.8, 4.6, -4.42, 1.8],
    [9.34, 4.72, -1.3, 9.62, 4.44, -1.3],
  ];
  segments(LEADERS.flat(), lineMaterial(C.soft, 0.22));

  const labels = LABELS.map((spec, i) => {
    const { texture, aspect } = labelTexture(spec[0]);
    track(texture);
    const mat = track(
      new THREE.SpriteMaterial({
        map: texture,
        transparent: true,
        opacity: 0,
        depthTest: false,
        depthWrite: false,
        sizeAttenuation: false,
      })
    );
    const s = new THREE.Sprite(mat);
    s.position.fromArray(spec[1]);
    s.renderOrder = 20;
    orbit.add(s);
    return { sprite: s, mat, aspect, text: spec[0], i };
  });

  /* if the webfont lands after the first paint, redraw the bitmaps once */
  if (document.fonts && document.fonts.ready && document.fonts.check) {
    document.fonts.ready
      .then(() => {
        if (destroyed || !document.fonts.check('500 12px "IBM Plex Mono"')) return;
        for (const l of labels) {
          const next = labelTexture(l.text);
          const old = l.mat.map;
          l.mat.map = next.texture;
          l.aspect = next.aspect;
          l.mat.needsUpdate = true;
          track(next.texture);
          if (old) old.dispose();
        }
        fit(true);
        if (!raf) draw(reduced ? STILL_T : clock);
      })
      .catch(() => {});
  }

  /* ---------------------------------------------------------- flow curves  */

  function buildCurve(from, target) {
    const pts = [
      from.clone(),
      new THREE.Vector3(gatePos.x - 0.95, gatePos.y * 0.6 + from.y * 0.4, from.z * 0.5),
      gatePos.clone(),
      new THREE.Vector3().lerpVectors(gatePos, lensPos, 0.55),
      lensPos.clone(),
      new THREE.Vector3().lerpVectors(lensPos, target, 0.45),
      target.clone(),
    ];
    return new THREE.CatmullRomCurve3(pts, false, "centripetal", 0.4);
  }

  const SAMPLES = 72;
  const paths = [];
  for (let i = 0; i < FLOW_COUNT; i++) paths.push(buildCurve(corePos, destPositions[i]));
  paths.push(buildCurve(credPos, decoyEnd)); // the bait leaves from the token

  const pathPts = paths.map((c) => c.getPoints(SAMPLES - 1));
  const pathBasis = paths.map((c, i) => {
    const dir = pathPts[i][SAMPLES - 1].clone().sub(pathPts[i][0]).normalize();
    const u = new THREE.Vector3(0, 1, 0).cross(dir).normalize();
    const v = dir.clone().cross(u).normalize();
    return [u, v];
  });

  /* where the gate and the lens actually fall along each path, so the squeeze
     lands on the rings instead of near them */
  function closestU(idx, p) {
    let best = 0;
    let bestD = Infinity;
    for (let i = 0; i < SAMPLES; i++) {
      const d = pathPts[idx][i].distanceToSquared(p);
      if (d < bestD) {
        bestD = d;
        best = i;
      }
    }
    return best / (SAMPLES - 1);
  }
  const uGate = paths.map((c, i) => closestU(i, gatePos));
  const uLens = paths.map((c, i) => closestU(i, lensPos));

  function samplePath(idx, u, out) {
    const f = THREE.MathUtils.clamp(u, 0, 1) * (SAMPLES - 1);
    const i0 = Math.floor(f);
    const i1 = Math.min(SAMPLES - 1, i0 + 1);
    out.copy(pathPts[idx][i0]).lerp(pathPts[idx][i1], f - i0);
    return out;
  }

  /* offset envelope: wide inside the box and along the corridor, pinched hard
     at the gate ring and again at the witness lens, tight at the destination */
  function apertureAmp(u, g, l) {
    const gate = 1 - 0.9 * bump(u - g, 0.055);
    const lens = 1 - 0.9 * bump(u - l, 0.05);
    const body = 0.82 - 0.6 * THREE.MathUtils.smoothstep(u, 0.5, 1);
    return 0.05 + body * gate * lens;
  }

  /* ------------------------------------------------------------- particles */

  const pPos = new Float32Array(TOTAL_PARTICLES * 3);
  const pCol = new Float32Array(TOTAL_PARTICLES * 3);
  const pSize = new Float32Array(TOTAL_PARTICLES);
  const pAlpha = new Float32Array(TOTAL_PARTICLES);
  const pFlow = new Int16Array(TOTAL_PARTICLES);
  const pOff = new Float32Array(TOTAL_PARTICLES * 2); // angle, radius
  const pSeed = new Float32Array(TOTAL_PARTICLES);
  const pSpeed = new Float32Array(TOTAL_PARTICLES);

  let rnd = 20260913;
  const rand = () => {
    rnd = (rnd * 1664525 + 1013904223) % 4294967296;
    return rnd / 4294967296;
  };

  const tmpCol = new THREE.Color();
  for (let i = 0; i < TOTAL_PARTICLES; i++) {
    const isDecoy = i >= FLOW_COUNT * PER_FLOW;
    const flow = isDecoy ? FLOW_COUNT : Math.floor(i / PER_FLOW);
    pFlow[i] = flow;
    pSeed[i] = isDecoy ? (i - FLOW_COUNT * PER_FLOW) / DECOY_PARTICLES : rand();
    pSpeed[i] = isDecoy ? 1 : 0.15 + 0.055 * (flow % 3) + rand() * 0.03;
    pOff[i * 2] = isDecoy
      ? rand() * Math.PI * 2
      : (flow * Math.PI * 2) / FLOW_COUNT + (rand() - 0.5) * 0.95;
    pOff[i * 2 + 1] = 0.22 + rand() * 0.62;
    pSize[i] = isDecoy ? 2.8 + rand() * 1.7 : 1.5 + rand() * 1.9;
    if (isDecoy) tmpCol.setHex(C.gold).lerp(new THREE.Color(0xe8d08a), rand() * 0.6);
    else
      tmpCol
        .setHex(C.teal)
        .lerp(new THREE.Color(C.soft), (flow / (FLOW_COUNT - 1)) * 0.75 + rand() * 0.2);
    pCol[i * 3] = tmpCol.r;
    pCol[i * 3 + 1] = tmpCol.g;
    pCol[i * 3 + 2] = tmpCol.b;
  }

  const pGeo = track(new THREE.BufferGeometry());
  pGeo.setAttribute("position", new THREE.BufferAttribute(pPos, 3));
  pGeo.setAttribute("aColor", new THREE.BufferAttribute(pCol, 3));
  pGeo.setAttribute("aSize", new THREE.BufferAttribute(pSize, 1));
  pGeo.setAttribute("aAlpha", new THREE.BufferAttribute(pAlpha, 1));
  pGeo.boundingSphere = new THREE.Sphere(new THREE.Vector3(0, 0, 0), 18);
  const pMat = track(
    new THREE.ShaderMaterial({
      uniforms: { uScale: { value: 300 } },
      vertexShader: POINT_VERT,
      fragmentShader: POINT_FRAG,
      transparent: true,
      depthWrite: false,
      blending: THREE.AdditiveBlending,
    })
  );
  orbit.add(new THREE.Points(pGeo, pMat));

  const tmpV = new THREE.Vector3();
  const packetU = new Float32Array(FLOW_COUNT);

  /* the head of the flow that is being recorded right now, per stream: it
     leaves the agent, is squeezed through the gate, crosses the witness exactly
     as that leaf is written, and lands on the destination a beat later */
  function updatePackets(t) {
    for (let f = 0; f < FLOW_COUNT; f++) {
      const a = t - (nodeT[f] - uLens[f] * PACKET_TRAVEL);
      packetU[f] = a < 0 ? -1 : ((a % LOOP) / PACKET_TRAVEL) % (LOOP / PACKET_TRAVEL);
    }
  }

  function decoyHead(t) {
    const a = t - DECOY_T0;
    if (a < 0) return -1;
    const p = a % (LOOP * DECOY_EVERY);
    return p < DECOY_TRAVEL ? p / DECOY_TRAVEL : -1;
  }

  function updateParticles(t) {
    updatePackets(t);
    const dHead = decoyHead(t);
    for (let i = 0; i < TOTAL_PARTICLES; i++) {
      const flow = pFlow[i];
      let u;
      if (flow === FLOW_COUNT) {
        u = dHead < 0 ? -1 : dHead * 1.22 - pSeed[i] * 0.22;
      } else {
        u = (pSeed[i] + t * pSpeed[i]) % 1;
      }
      if (u < 0 || u > 1) {
        pAlpha[i] = 0;
        continue;
      }
      samplePath(flow, u, tmpV);
      const open = apertureAmp(u, uGate[flow], uLens[flow]);
      const amp = open * pOff[i * 2 + 1];
      const ang = pOff[i * 2] + u * 2.4;
      const b = pathBasis[flow];
      tmpV.x += (b[0].x * Math.cos(ang) + b[1].x * Math.sin(ang)) * amp;
      tmpV.y += (b[0].y * Math.cos(ang) + b[1].y * Math.sin(ang)) * amp;
      tmpV.z += (b[0].z * Math.cos(ang) + b[1].z * Math.sin(ang)) * amp;
      pPos[i * 3] = tmpV.x;
      pPos[i * 3 + 1] = tmpV.y;
      pPos[i * 3 + 2] = tmpV.z;
      const ends =
        Math.min(1, u / 0.16) * Math.min(1, (1 - u) / 0.1) * (0.42 + 0.58 * (open / 0.86));
      if (flow === FLOW_COUNT) {
        pAlpha[i] = ends * 0.85;
      } else {
        const pu = packetU[flow];
        const boost = pu < 0 ? 1 : 1 + 2.8 * bump(u - pu, 0.075);
        const ripple = 0.86 + 0.18 * Math.sin((u * 4.4 - t * 0.34 + flow * 0.7) * 6.2832);
        pAlpha[i] = ends * 0.2 * boost * ripple;
      }
    }
    pGeo.attributes.position.needsUpdate = true;
    pGeo.attributes.aAlpha.needsUpdate = true;
  }

  /* ----------------------------------------------------------- scene motion */

  const goldCol = new THREE.Color(C.gold);
  const tealCol = new THREE.Color(C.teal);
  const softCol = new THREE.Color(C.soft);
  const brightCol = new THREE.Color(C.bright);
  const inkCol = new THREE.Color(C.ink);
  const baitCol = new THREE.Color(0x7d6320);
  const scratch = new THREE.Color();
  const tmpA = new THREE.Vector3();
  const tmpB = new THREE.Vector3();

  function updateSandbox(t) {
    const pulse = 0.5 + 0.5 * Math.sin(t * 1.05);
    core.scale.setScalar(0.94 + pulse * 0.12);
    core.rotation.y = t * 0.2;
    core.rotation.x = t * 0.12;
    halo.scale.setScalar(1 + pulse * 0.11);
    haloMat.uniforms.uOpacity.value = 0.1 + pulse * 0.12;
    coreGlow.material.opacity = 0.24 + pulse * 0.14;
    coreGlow.scale.setScalar(2.8 + pulse * 0.6);
    coreRing.rotation.z = t * 0.3;
    coreRing.rotation.y = 0.3 + Math.sin(t * 0.22) * 0.22;
    coreRingMat.uniforms.uOpacity.value = 0.38 + pulse * 0.24;
    token.rotation.y = t * 0.7;
    token.rotation.z = t * 0.36;
    tokenGlow.material.opacity = 0.4 + 0.2 * Math.sin(t * 1.7);
    gridMat.opacity = 0.34 + 0.12 * pulse;
  }

  /* the gate writes a row into the enforcement log for every flow it lets out */
  function updateGate(t) {
    let flash = 0;
    for (let j = 0; j < LEAF_COUNT; j++) {
      const s = since(t, nodeT[j] - GATE_LEAD, LOOP);
      if (s < 0) continue;
      flash = Math.max(flash, decay(s, 0, 3.4));
    }
    const loopIndex = Math.max(0, Math.floor(t / LOOP));
    const shimmer = 0.5 + 0.5 * Math.sin(t * 2.1);

    scratch.copy(brightCol).lerp(inkCol, flash * 0.8);
    gateMat.uniforms.uCore.value.copy(scratch);
    gateMat.uniforms.uGain.value = 1.9 + flash * 1.4;
    gateDiscMat.opacity = 0.1 + 0.05 * shimmer + flash * 0.34;
    gateGlow.material.opacity = 0.16 + flash * 0.34;
    gateGlow.scale.setScalar(2.4 + flash * 1.2);
    for (let k = 0; k < blades.length; k++) {
      const b = blades[k];
      const r = 0.86 - flash * 0.12;
      const a = (k * Math.PI) / 3 + 0.22 + flash * 0.16;
      b.position.set(Math.cos(a) * r, Math.sin(a) * r, 0);
      b.rotation.z = a;
    }

    // one plate per written row, rolling up the stack
    for (let i = 0; i < LOG_PLATES; i++) {
      const m = plateMats[i];
      m.uniforms.uCore.value.set(0x27515f);
      m.uniforms.uOpacity.value = 0.95;
      m.uniforms.uGain.value = 1.2;
      plates[i].scale.setScalar(1);
    }
    for (let j = 0; j < LEAF_COUNT; j++) {
      const s = since(t, nodeT[j] - GATE_LEAD, LOOP);
      if (s < 0) continue;
      const idx = (loopIndex * LEAF_COUNT + j) % LOG_PLATES;
      const f = decay(s, 0, 2.2);
      if (f < 0.02) continue;
      const m = plateMats[idx];
      m.uniforms.uCore.value.set(0x27515f).lerp(j === 7 ? goldCol : softCol, f);
      m.uniforms.uGain.value = 1.2 + f * 2.2;
      plates[idx].scale.setScalar(1 + f * 0.08);
    }
    const logPulse = decay(since(t, nodeT[14], LOOP), 0, 1.6);
    logRootMat.uniforms.uGain.value = 1.9 + logPulse * 1.6;
    logRoot.rotation.y = t * 0.5;
    logRoot.scale.setScalar(1 + logPulse * 0.3);
    logGlow.material.opacity = 0.28 + logPulse * 0.35;
  }

  function updateWitness(t, goldAtLens) {
    let flash = 0;
    for (let j = 0; j < LEAF_COUNT; j++) {
      const s = since(t, nodeT[j], LOOP);
      if (s < 0) continue;
      flash = Math.max(flash, decay(s, 0, 3.2));
    }
    scratch.copy(tealCol).lerp(softCol, flash * 0.7).lerp(goldCol, goldAtLens);
    lensMat.uniforms.uCore.value.copy(scratch);
    lensMat.uniforms.uRim.value.copy(softCol).lerp(goldCol, goldAtLens);
    lensMat.uniforms.uGain.value = 1.7 + flash * 1.1;
    lens.scale.setScalar(1 + (flash * 0.02 + goldAtLens * 0.06));
    irisRing.rotation.x = t * 0.28;
    irisRingMat.uniforms.uOpacity.value = 0.6 + flash * 0.4;
    pupil.scale.setScalar(1 + flash * 0.22);
    lensDiscMat.opacity = 0.06 + flash * 0.16 + goldAtLens * 0.4;
    lensGlow.material.opacity = 0.2 + flash * 0.26 + goldAtLens * 0.3;

    // scan ring sweeps outward, one sweep per flow written
    const sweep = since(t, LEAF_T0 - 0.2, LEAF_STEP);
    const k = sweep < 0 ? 0 : sweep / LEAF_STEP;
    const r = 0.7 + k * 1.5;
    scan.scale.set(r, r, 1);
    scanMat.uniforms.uOpacity.value = sweep < 0 ? 0 : 0.42 * (1 - k) * (1 - k);
  }

  function updateTree(t) {
    for (let id = 0; id < TREE_NODES; id++) {
      const s = since(t, nodeT[id], LOOP);
      const born = s >= 0;
      treeMeshes[id].visible = born;
      if (!born) continue;
      const grow = t < nodeT[id] + 0.4 ? ramp(t, nodeT[id], 0.4) : 1;
      const light = decay(s, 0, 1.7);
      const pop = 1 + light * 0.45;
      treeMeshes[id].scale.setScalar(grow * pop);
      treeMeshes[id].rotation.y = t * 0.3 + id;
      const m = treeMats[id];
      const isBait = id === 7;
      const base = isBait ? baitCol : id === 14 ? brightCol : tealCol;
      m.uniforms.uCore.value.copy(base).lerp(isBait ? goldCol : inkCol, light * 0.75);
      m.uniforms.uGain.value = (id === 14 ? 1.9 : 1.7) + light * 1.5;
      m.uniforms.uOpacity.value = 0.7 + 0.3 * Math.min(1, 0.4 + light * 1.4);
    }
    for (const link of treeLinks) {
      const s = since(t, link.userData.at, LOOP);
      link.visible = s >= 0;
      if (s < 0) continue;
      const grow = ramp(t, link.userData.at - 0.1, 0.34);
      link.scale.y = link.userData.len * grow;
    }
    const rootLight = decay(since(t, nodeT[14], LOOP), 0, 1.3);
    rootGlow.material.opacity = 0.18 + rootLight * 0.5;
    rootGlow.scale.setScalar(2 + rootLight * 1.6);

    // one observation travelling from the witness down onto its leaf
    let shown = false;
    for (let j = 0; j < LEAF_COUNT && !shown; j++) {
      const p = approach(t, nodeT[j], CAPTURE_TRAVEL, LOOP);
      if (p < 0) continue;
      shown = true;
      const leaf = nodePos[j];
      // gentle bow away from the trunk so the bead does not slide down the spine
      tmpA.lerpVectors(feedTop, leaf, p);
      const bow = Math.sin(p * Math.PI) * 0.9 * Math.sign(leaf.x - treeRoot.x || 1);
      tmpA.x += bow;
      captureBead.position.copy(tmpA);
      captureBead.scale.setScalar(0.8 + Math.sin(p * Math.PI) * 0.7);
      captureBeadMat.uniforms.uCore.value.copy(j === 7 ? goldCol : softCol);
    }
    captureBead.visible = shown;
    return rootLight;
  }

  function updateAnchor(t) {
    const p = since(t, ANCHOR_T0, LOOP);
    const travelling = p >= 0 && p < ANCHOR_TRAVEL;
    anchorBead.visible = travelling;
    if (travelling) {
      const k = p / ANCHOR_TRAVEL;
      const e = k * k * (3 - 2 * k);
      anchorBead.position.lerpVectors(treeRoot, aRingSpin.position, e);
      anchorBead.position.y += Math.sin(k * Math.PI) * 0.8;
      anchorBead.scale.setScalar(1 + Math.sin(k * Math.PI) * 1.2);
    }
    const arrive = p < 0 ? 0 : decay(p, ANCHOR_TRAVEL, 1.6);
    const armed = p >= 0 ? THREE.MathUtils.clamp(p / ANCHOR_TRAVEL, 0, 1) : 0;
    anchorLine.material.opacity = 0.16 + armed * 0.3 * (1 - arrive * 0.3) + arrive * 0.3;
    aRingSpin.rotation.y = t * 0.45;
    aRingSpin.scale.setScalar(1 + arrive * 0.18);
    aRingMat.uniforms.uCore.value.copy(tealCol).lerp(inkCol, arrive);
    aRingMat.uniforms.uGain.value = 1.8 + arrive * 1.4;
    anchorGlow.material.opacity = 0.16 + arrive * 0.45;
    anchorGlow.scale.setScalar(3.4 + arrive * 2);
    slabMat.uniforms.uGain.value = 1.7 + arrive * 1.5;
    cap.scale.setScalar(1 + arrive * 0.7);
    cap.rotation.y = t * 0.4;
    return arrive;
  }

  /* the gold run: the planted credential leaves, the gate and the witness both
     see it, the decoy endpoint lights, and the canary mark stays lit after */
  function updateDecoy(t) {
    const head = decoyHead(t);
    const atLens = head >= 0 ? bump(head - uLens[FLOW_COUNT], 0.07) : 0;
    const atEnd = head >= 0 ? bump(head - 0.97, 0.09) : 0;
    const fired = t >= DECOY_T0 + DECOY_TRAVEL * 0.97;
    const sinceFire = fired ? since(t, DECOY_T0 + DECOY_TRAVEL * 0.97, LOOP * DECOY_EVERY) : -1;
    const fresh = fired ? decay(sinceFire, 0, 1.1) : 0;

    decoyMat.uniforms.uRim.value.copy(goldCol).lerp(inkCol, atEnd);
    decoyMat.uniforms.uGain.value = 1.9 + atEnd * 1.4;
    decoyMesh.scale.setScalar(1 + atEnd * 0.3);
    decoyRing.scale.setScalar(1 + atEnd * 0.45);
    decoyRingMat.uniforms.uOpacity.value = 0.5 + atEnd * 0.5;
    decoyGlow.material.opacity = 0.28 + atEnd * 0.5;
    decoyGlow.scale.setScalar(2.4 + atEnd * 1.6);

    const lit = fired ? 1 : 0;
    const breathe = 0.5 + 0.5 * Math.sin(t * 1.6);
    canary.visible = fired;
    canaryRing.visible = fired;
    canary.rotation.y = t * 0.9;
    canary.scale.setScalar(lit * (1 + fresh * 0.8));
    canaryRing.scale.setScalar(lit * (1 + fresh * 1.1));
    canaryRing.rotation.z = t * 0.7;
    canaryMat.uniforms.uOpacity.value = lit;
    canaryMat.uniforms.uGain.value = 1.9 + fresh * 1.6;
    canaryRingMat.uniforms.uOpacity.value = lit * (0.5 + breathe * 0.25 + fresh * 0.25);
    canaryGlow.material.opacity = lit * (0.22 + breathe * 0.12 + fresh * 0.4);
    tokenMat.uniforms.uGain.value = 2 + (head >= 0 && head < 0.12 ? 1.6 : 0);
    return { atLens, fired };
  }

  /* three roots bind into the card, then the seal */
  function updateReceipt(t, baitReady) {
    const wake = since(t, RECEIPT_T0, LOOP);
    const fresh = wake < 0 ? 0 : THREE.MathUtils.clamp(wake / 1.1, 0, 1);
    const ever = t >= RECEIPT_T0;
    cardMat.opacity = ever ? 0.06 + fresh * 0.07 : 0;
    borderMat.opacity = ever ? 0.4 + fresh * 0.42 : 0;
    ruleMat.opacity = ever ? 0.1 + fresh * 0.26 : 0;
    card.visible = ever;
    cardBorder.visible = ever;
    rulings.visible = ever;

    let landedAll = true;
    for (let i = 0; i < 3; i++) {
      const at = CHIP_T[i] + CHIP_TRAVEL;
      const p = approach(t, at, CHIP_TRAVEL, LOOP);
      const landed = t >= at;
      const s = since(t, at, LOOP);
      const glow = s < 0 ? 0 : decay(s, 0, 1.5);
      if (p >= 0 && (i !== 2 || baitReady)) {
        const e = p * p * (3 - 2 * p);
        tmpB.lerpVectors(flySource[i], chipSlots[i], e);
        tmpB.y += Math.sin(p * Math.PI) * 1.1;
        flyers[i].position.copy(tmpB);
        flyers[i].scale.setScalar(0.9 + Math.sin(p * Math.PI) * 0.8);
        flyers[i].visible = true;
      } else {
        flyers[i].visible = false;
      }
      if (!landed) landedAll = false;
      chipMeshes[i].visible = landed && p < 0;
      const m = chipMats[i];
      m.uniforms.uOpacity.value = landed ? 1 : 0;
      m.uniforms.uGain.value = 1.8 + glow * 1.8;
      m.uniforms.uCore.value
        .set(CHIP_COLOR[i])
        .lerp(i === 2 ? goldCol : inkCol, Math.min(0.85, glow));
      chipMeshes[i].scale.setScalar(1 + glow * 0.16);
    }

    const sealed = t >= SEAL_T;
    const s = since(t, SEAL_T, LOOP);
    const pop = s < 0 ? 0 : decay(s, 0, 1.3);
    sealGroup.visible = sealed && landedAll;
    const grow = sealed ? ramp(t, SEAL_T, 0.32) : 0;
    sealGroup.scale.setScalar(grow * (1 + pop * 0.5));
    sealGroup.rotation.z = -pop * 0.5;
    sealMat.uniforms.uOpacity.value = sealed ? 1 : 0;
    sealMat.uniforms.uGain.value = 1.8 + pop * 1.8;
    sealGlow.material.opacity = sealed ? 0.2 + pop * 0.5 : 0;
  }

  function updateDestinations(t) {
    for (let i = 0; i < FLOW_COUNT; i++) {
      const s = since(t, nodeT[i] + DEST_LAG, LOOP);
      const hit = s < 0 ? 0 : decay(s, 0, 2.6);
      const breathe = 0.5 + 0.5 * Math.sin(t * 1.15 + i * 0.9);
      destMeshes[i].scale.setScalar(0.92 + breathe * 0.1 + hit * 0.3);
      destMats[i].uniforms.uGain.value = 1.5 + hit * 1.8;
      destGlows[i].material.opacity = 0.16 + hit * 0.45;
      destGlows[i].scale.setScalar(1.6 + hit * 1.3);
    }
  }

  function updateLabels(t) {
    for (const l of labels) {
      l.mat.opacity = LABEL_ALPHA * ramp(t, LABEL_T0 + l.i * LABEL_STAGGER, LABEL_FADE);
    }
  }

  function updateScene(t) {
    updateSandbox(t);
    updateGate(t);
    const d = updateDecoy(t);
    updateWitness(t, d.atLens);
    updateTree(t);
    updateAnchor(t);
    updateDestinations(t);
    updateReceipt(t, d.fired);
    updateLabels(t);
  }

  /* ------------------------------------------------------------ camera fit */

  let vw = 1;
  let vh = 1;
  let baseY = 0;

  function fit(force) {
    const box = canvas.parentElement || canvas;
    const w = Math.max(1, Math.round(box.clientWidth || canvas.clientWidth || 1));
    const h = Math.max(1, Math.round(box.clientHeight || canvas.clientHeight || 1));
    if (w === vw && h === vh && !force) return;
    vw = w;
    vh = h;
    renderer.setSize(w, h, false);
    const aspect = w / h;
    camera.aspect = aspect;

    // wide frames keep the pipeline horizontal; narrow frames tilt it into a
    // diagonal and shrink it so the same scene still reads on a phone
    const k = THREE.MathUtils.clamp((aspect - 0.85) / (1.7 - 0.85), 0, 1);
    const ease = k * k * (3 - 2 * k);
    const tilt = -1.3 * (1 - ease);
    const scale = 0.5 + 0.5 * ease;
    root.rotation.z = tilt;
    root.scale.setScalar(scale);

    // extents of the orbiting content, valid for every yaw
    const probe = [
      cubePos.clone().add(new THREE.Vector3(-half, 0, -half)),
      new THREE.Vector3(anchorPos.x + 1.6, anchorPos.y + 3.5, anchorPos.z),
      new THREE.Vector3(decoyEnd.x, canaryPos.y - 0.5, decoyEnd.z),
      new THREE.Vector3(treeRoot.x, BASE.treeLeafY - 0.35, treeRoot.z),
      new THREE.Vector3(BASE.receipt[0] + CARD_W * 0.62, BASE.receipt[1] - CARD_H * 0.62, BASE.receipt[2]),
      new THREE.Vector3(logPos.x, logPos.y - 1.5, logPos.z),
      destPositions[0].clone(),
      destPositions[FLOW_COUNT - 1].clone().add(new THREE.Vector3(0, 1.1, 0)),
      destPositions[3].clone().add(new THREE.Vector3(0.5, 0, 0)),
    ];
    // Proper perspective fit: a point swung toward the camera by the orbit is
    // magnified, so solve for the distance at which every probe point still
    // clears the frustum at every yaw, rather than bounding it orthographically.
    const ct = Math.cos(tilt);
    const st = Math.sin(tilt);
    const tanV = Math.tan((camera.fov * Math.PI) / 360);
    const YAWS = 24;
    let dist = 4;
    for (const p of probe) {
      const r = Math.hypot(p.x, p.z) * scale;
      const py = p.y * scale;
      for (let j = 0; j < YAWS; j++) {
        const a = (j / YAWS) * Math.PI * 2;
        const px2 = r * Math.cos(a);
        const pz = r * Math.sin(a);
        const sx = Math.abs(px2 * ct - py * st) * framePadding;
        const sy = Math.abs(px2 * st + py * ct) * framePadding;
        dist = Math.max(dist, sx / (tanV * aspect) + pz, sy / tanV + pz);
      }
    }
    const halfH = dist * tanV;

    root.position.x = offset[0] * halfH * aspect;
    baseY = offset[1] * halfH;
    camera.position.set(0, dist * 0.1, dist * 0.995);
    camera.lookAt(0, 0.1, 0);
    camera.updateProjectionMatrix();
    pMat.uniforms.uScale.value = renderer.domElement.height * 0.34;

    // labels hold a constant size on screen, whatever the frame does
    // Labels hold a constant size on screen, except that they never grow past a
    // fixed share of the layout itself, or a wide frame (where the fit is bound
    // by the height and the scene shrinks) would have two of them collide.
    // sizeAttenuation is off, so a sprite's scale is a fraction of the frame:
    // scale.y = 2 * tan(fov/2) * pixels / frameHeight, undoing the root scale.
    const pxPerUnit = ((h / (2 * halfH)) * scale) || 1;
    const labelPx = Math.min(LABEL_PX, 0.62 * pxPerUnit);
    const labelH = (labelPx * 2 * tanV) / h / scale;
    for (const l of labels) l.sprite.scale.set(labelH * l.aspect, labelH, 1);

    // depth: whatever the orbit swings away from the camera sinks back
    FOG.value.set(dist * 0.8, dist * 2.2);

    // atmosphere sits behind everything the orbit can swing toward the camera
    const bz = -15;
    const bh = 2 * tanV * (camera.position.z - bz) * 1.5;
    backdrop.position.set(root.position.x * 0.5, baseY * 0.5 - halfH * 0.08, bz);
    backdrop.scale.set(bh * aspect * 1.15, bh, 1);

    // grain rides on the camera; one texel every two device pixels at any ratio
    const gh = 2 * tanV * 6 * 1.02;
    grain.scale.set(gh * aspect, gh, 1);
    grainTex.repeat.set(
      Math.max(1, renderer.domElement.width / 256),
      Math.max(1, renderer.domElement.height / 256)
    );
  }

  /* ------------------------------------------------------------- run loop  */

  let raf = 0;
  let last = 0;
  let clock = 0;
  let userPaused = false;
  let onScreen = true;
  let tabVisible = document.visibilityState !== "hidden";
  let reduced = false;
  let announced = false;
  let destroyed = false;
  let px = 0;
  let py = 0;
  let tx = 0;
  let ty = 0;

  function draw(stillTime) {
    const t = stillTime == null ? clock : stillTime;
    px += (tx - px) * (stillTime == null ? 0.06 : 1);
    py += (ty - py) * (stillTime == null ? 0.06 : 1);
    // One full revolution per orbitPeriod, eased: it lingers on the readable
    // three quarter views and sweeps through the end on angles, where a pipeline
    // laid out along one axis stops explaining itself.
    const x = (t / orbitPeriod) * Math.PI * 2;
    const spin = x - ORBIT_EASE * Math.sin(2 * x);
    orbit.rotation.y = startAngle + (stillTime == null ? spin : 0) + px;
    orbit.rotation.x = py;
    root.position.y = baseY + Math.sin(t * 0.5) * 0.14;
    updateScene(t);
    updateParticles(t);
    renderer.render(scene, camera);
    if (!announced) {
      announced = true;
      const info = renderer.info.render;
      const detail = { triangles: info.triangles, calls: info.calls, points: TOTAL_PARTICLES };
      setTimeout(() => canvas.dispatchEvent(new CustomEvent("hero-ready", { detail })), 0);
    }
  }

  function frame(now) {
    raf = requestAnimationFrame(frame);
    const dt = last ? Math.min(0.05, (now - last) / 1000) : 0.016;
    last = now;
    clock += dt;
    // no fit() here on purpose: reading clientWidth every frame forces layout,
    // and the ResizeObserver already covers every size change
    draw();
  }

  function shouldRun() {
    return !destroyed && !reduced && !userPaused && onScreen && tabVisible;
  }

  function sync() {
    if (shouldRun()) {
      if (!raf) {
        last = 0;
        raf = requestAnimationFrame(frame);
      }
    } else if (raf) {
      cancelAnimationFrame(raf);
      raf = 0;
    }
  }

  function still() {
    // never draw through a disposed renderer: setReducedMotion can still be
    // called by a listener the caller kept after destroy()
    if (destroyed) return;
    fit();
    draw(STILL_T);
  }

  /* ------------------------------------------------------------- observers */

  const ro = new ResizeObserver(() => {
    fit();
    if (!raf && !destroyed) draw(reduced ? STILL_T : clock);
  });
  ro.observe(canvas.parentElement || canvas);

  const io = new IntersectionObserver(
    (entries) => {
      onScreen = entries.some((e) => e.isIntersecting);
      sync();
    },
    { rootMargin: "120px" }
  );
  io.observe(canvas);

  function onVisibility() {
    tabVisible = document.visibilityState !== "hidden";
    sync();
  }
  document.addEventListener("visibilitychange", onVisibility);

  function onPointer(e) {
    const r = canvas.getBoundingClientRect();
    if (!r.width || !r.height) return;
    tx = ((e.clientX - r.left) / r.width - 0.5) * 2 * parallaxMax;
    ty = ((e.clientY - r.top) / r.height - 0.5) * 2 * parallaxMax * 0.7;
  }
  window.addEventListener("pointermove", onPointer, { passive: true });

  function onContextLost(e) {
    e.preventDefault();
    if (raf) cancelAnimationFrame(raf);
    raf = 0;
    canvas.dispatchEvent(new CustomEvent("hero-fallback"));
  }
  canvas.addEventListener("webglcontextlost", onContextLost);

  const mq =
    opts.respectPrefersReducedMotion === false || !window.matchMedia
      ? null
      : window.matchMedia("(prefers-reduced-motion: reduce)");

  function setReducedMotion(on) {
    if (destroyed) return;
    reduced = !!on;
    if (reduced) {
      if (raf) cancelAnimationFrame(raf);
      raf = 0;
      still();
    } else {
      sync();
      if (!raf) still();
    }
  }
  const onMq = (e) => setReducedMotion(e.matches);
  if (mq) mq.addEventListener("change", onMq);

  /* ------------------------------------------------------------------ boot */

  fit();
  const startReduced = opts.reducedMotion != null ? !!opts.reducedMotion : !!(mq && mq.matches);
  if (startReduced) setReducedMotion(true);
  else {
    draw();
    sync();
  }

  return {
    pause() {
      userPaused = true;
      sync();
    },
    resume() {
      userPaused = false;
      sync();
    },
    setReducedMotion,
    destroy() {
      destroyed = true;
      if (raf) cancelAnimationFrame(raf);
      raf = 0;
      ro.disconnect();
      io.disconnect();
      document.removeEventListener("visibilitychange", onVisibility);
      window.removeEventListener("pointermove", onPointer);
      canvas.removeEventListener("webglcontextlost", onContextLost);
      if (mq) mq.removeEventListener("change", onMq);
      for (const d of disposables) if (d && d.dispose) d.dispose();
      renderer.dispose();
      if (renderer.forceContextLoss) renderer.forceContextLoss();
    },
  };
}

export default initHero;
