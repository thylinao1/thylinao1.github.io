/*
 * hero.js
 * Three.js hero scene for the egress receipts project page.
 *
 * What the scene depicts, left to right:
 *   sandbox      glass cube with glowing teal edges; the agent core (icosahedron,
 *                slow pulse) sits inside it, together with a planted gold decoy token
 *   broker gate  bright ring on the +X face of the cube; every flow leaves through it
 *   flows        seven additive particle streams, one per real CDN destination
 *   witness      lens shaped torus on the flows' path, outside the cube; every flow
 *                that passes is captured and feeds a growing Merkle tree beside it
 *   anchor       tall thin slab with a slowly rotating ring; the tree root pulses to it
 *   decoy        gold token inside, gold endpoint outside; about every twelve seconds a
 *                red stream tries to reach the endpoint and the witness flashes gold
 *
 * Public API
 *   initHero(canvas, opts) -> { pause, resume, destroy, setReducedMotion }
 *
 * opts (all optional)
 *   orbitPeriod   seconds per revolution of the scene group          default 45
 *   startAngle    initial yaw in radians                             default -0.45
 *   parallax      max parallax in radians                            default 0.055
 *   framePadding  how much air to leave around the scene               default 1.16
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
};

/* The seven real destinations of the demo run, used only to vary each stream. */
const FLOW_COUNT = 7;
const PER_FLOW = 120;
const DECOY_PARTICLES = 140;
const TOTAL_PARTICLES = FLOW_COUNT * PER_FLOW + DECOY_PARTICLES; // 980

const TREE_STEP = 0.55;
const TREE_HOLD = 2.2;
const TREE_NODES = 15;
const TREE_CYCLE = TREE_NODES * TREE_STEP + TREE_HOLD;
const DECOY_PERIOD = 12;
const DECOY_TRAVEL = 2.6;
const LENS_U = 0.42; // where the lens sits along a flow path
const STILL_T = 49.14; // frozen clock, chosen so the still frame explains the most

/* ------------------------------------------------------- layout, wide frame */

const BASE = {
  cubeHalf: 2.2,
  cube: [-8.6, 0.2, 0],
  gate: [-6.4, 0.2, 0],
  lens: [-2.3, 0.5, 0.15],
  decoyToken: [-9.45, -1.15, 0.85],
  decoyEnd: [4.6, -4.9, 1.8],
  anchor: [9.7, 1.1, -1.3],
  treeRoot: [-2.3, -2.2, 0.15],
  treeLeafY: -5.9,
  treeWidth: 5.4,
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
  varying vec3 vNrm;
  varying vec3 vDir;
  void main() {
    vec4 mv = modelViewMatrix * vec4(position, 1.0);
    vNrm = normalize(normalMatrix * normal);
    vDir = normalize(-mv.xyz);
    gl_Position = projectionMatrix * mv;
  }
`;

const GLOW_FRAG = /* glsl */ `
  uniform vec3 uCore;
  uniform vec3 uRim;
  uniform float uOpacity;
  uniform float uPower;
  uniform float uGain;
  varying vec3 vNrm;
  varying vec3 vDir;
  void main() {
    float f = 1.0 - clamp(abs(dot(normalize(vNrm), normalize(vDir))), 0.0, 1.0);
    f = pow(f, uPower) * uGain;
    gl_FragColor = vec4(mix(uCore, uRim, clamp(f, 0.0, 1.0)), uOpacity);
    #include <colorspace_fragment>
  }
`;

const POINT_VERT = /* glsl */ `
  attribute float aSize;
  attribute float aAlpha;
  attribute vec3 aColor;
  uniform float uScale;
  varying vec3 vColor;
  varying float vAlpha;
  void main() {
    vec4 mv = modelViewMatrix * vec4(position, 1.0);
    vColor = aColor;
    vAlpha = aAlpha;
    gl_PointSize = aSize * (uScale / max(0.001, -mv.z));
    gl_Position = projectionMatrix * mv;
  }
`;

const POINT_FRAG = /* glsl */ `
  varying vec3 vColor;
  varying float vAlpha;
  void main() {
    float d = length(gl_PointCoord - vec2(0.5));
    float a = smoothstep(0.5, 0.06, d) * vAlpha;
    if (a <= 0.002) discard;
    gl_FragColor = vec4(vColor, a);
    #include <colorspace_fragment>
  }
`;

/* ------------------------------------------------------------------ helpers */

function glowMaterial(core, rim, opacity, power, gain, extra) {
  return new THREE.ShaderMaterial(
    Object.assign(
      {
        uniforms: {
          uCore: { value: new THREE.Color(core) },
          uRim: { value: new THREE.Color(rim) },
          uOpacity: { value: opacity },
          uPower: { value: power },
          uGain: { value: gain },
        },
        vertexShader: GLOW_VERT,
        fragmentShader: GLOW_FRAG,
        transparent: opacity < 1,
      },
      extra || {}
    )
  );
}

function decay(t, t0, k) {
  return t >= t0 ? Math.exp(-(t - t0) * k) : 0;
}

function webglSupported() {
  try {
    const probe = document.createElement("canvas");
    return !!(
      window.WebGLRenderingContext &&
      (probe.getContext("webgl2") || probe.getContext("webgl"))
    );
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

/* offset envelope: wide inside the cube and along the corridor, pinched hard
   at the gate ring and again at the witness lens, tight at the destination */
function apertureAmp(u) {
  const gate = 1 - 0.93 * Math.exp(-Math.pow((u - 0.205) / 0.055, 2));
  const lens = 1 - 0.93 * Math.exp(-Math.pow((u - LENS_U) / 0.05, 2));
  const body = 0.8 - 0.58 * THREE.MathUtils.smoothstep(u, 0.5, 1);
  return 0.05 + body * gate * lens;
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
  renderer.setPixelRatio(Math.min(1.5, window.devicePixelRatio || 1));

  const scene = new THREE.Scene();
  const camera = new THREE.PerspectiveCamera(40, 1, 0.5, 120);

  const root = new THREE.Group(); // layout tilt and scale, set by the fit
  const orbit = new THREE.Group(); // yaw revolution plus parallax
  root.add(orbit);
  scene.add(root);

  const disposables = [];
  const track = (obj) => {
    disposables.push(obj);
    return obj;
  };

  /* ----------------------------------------------------------- sandbox cube */

  const cubePos = new THREE.Vector3().fromArray(BASE.cube);
  const half = BASE.cubeHalf;

  const glassGeo = track(new THREE.BoxGeometry(half * 2, half * 2, half * 2));
  const glassMat = track(
    glowMaterial(0x16313f, C.teal, 0.3, 2.6, 1.4, {
      side: THREE.DoubleSide,
      depthWrite: false,
      blending: THREE.AdditiveBlending,
    })
  );
  const glass = new THREE.Mesh(glassGeo, glassMat);
  glass.position.copy(cubePos);
  orbit.add(glass);

  // twelve glowing edge tubes
  const edgeGeoLong = track(new THREE.CylinderGeometry(0.035, 0.035, half * 2, 6, 1, true));
  const edgeMat = track(glowMaterial(C.teal, C.soft, 0.95, 1.6, 1.5));
  const edgeGroup = new THREE.Group();
  edgeGroup.position.copy(cubePos);
  const s = half;
  const edgeSpecs = [];
  for (const a of [-s, s]) {
    for (const b of [-s, s]) {
      edgeSpecs.push({ p: [0, a, b], r: [0, 0, Math.PI / 2] }); // along X
      edgeSpecs.push({ p: [a, 0, b], r: [0, 0, 0] }); // along Y
      edgeSpecs.push({ p: [a, b, 0], r: [Math.PI / 2, 0, 0] }); // along Z
    }
  }
  for (const spec of edgeSpecs) {
    const m = new THREE.Mesh(edgeGeoLong, edgeMat);
    m.position.set(spec.p[0], spec.p[1], spec.p[2]);
    m.rotation.set(spec.r[0], spec.r[1], spec.r[2]);
    edgeGroup.add(m);
  }
  orbit.add(edgeGroup);

  /* ------------------------------------------------------------ agent core */

  const coreGeo = track(new THREE.IcosahedronGeometry(0.72, 1));
  const coreMat = track(glowMaterial(0x2f7f74, C.soft, 1, 1.8, 1.8));
  const core = new THREE.Mesh(coreGeo, coreMat);
  core.position.copy(cubePos);
  orbit.add(core);

  const haloGeo = track(new THREE.IcosahedronGeometry(1.08, 0));
  const haloMat = track(
    glowMaterial(C.teal, C.bright, 0.28, 2.2, 1.6, {
      blending: THREE.AdditiveBlending,
      depthWrite: false,
      side: THREE.BackSide,
    })
  );
  const halo = new THREE.Mesh(haloGeo, haloMat);
  halo.position.copy(cubePos);
  orbit.add(halo);

  /* --------------------------------------------------------- decoy token in */

  const tokenGeo = track(new THREE.OctahedronGeometry(0.27, 0));
  const tokenMat = track(glowMaterial(0x8a6d1f, C.gold, 1, 1.4, 2));
  const token = new THREE.Mesh(tokenGeo, tokenMat);
  token.position.fromArray(BASE.decoyToken);
  orbit.add(token);

  /* ------------------------------------------------------------ broker gate */

  const gatePos = new THREE.Vector3().fromArray(BASE.gate);
  const gateGeo = track(new THREE.TorusGeometry(1.15, 0.085, 6, 40));
  const gateMat = track(glowMaterial(C.bright, C.ink, 1, 1.5, 1.9));
  const gate = new THREE.Mesh(gateGeo, gateMat);
  gate.position.copy(gatePos);
  gate.rotation.y = Math.PI / 2;
  orbit.add(gate);

  const gateDiscGeo = track(new THREE.RingGeometry(0.86, 1.12, 40, 1));
  const gateDiscMat = track(
    new THREE.MeshBasicMaterial({
      color: new THREE.Color(C.bright),
      transparent: true,
      opacity: 0.14,
      side: THREE.DoubleSide,
      blending: THREE.AdditiveBlending,
      depthWrite: false,
    })
  );
  const gateDisc = new THREE.Mesh(gateDiscGeo, gateDiscMat);
  gateDisc.position.copy(gatePos);
  gateDisc.rotation.y = Math.PI / 2;
  orbit.add(gateDisc);

  /* ----------------------------------------------------------- witness lens */

  const lensPos = new THREE.Vector3().fromArray(BASE.lens);
  const lensGeo = track(new THREE.TorusGeometry(1.58, 0.16, 6, 36));
  const lensMat = track(glowMaterial(C.teal, C.soft, 1, 1.7, 1.7));
  const lens = new THREE.Mesh(lensGeo, lensMat);
  lens.position.copy(lensPos);
  lens.rotation.y = Math.PI / 2;
  orbit.add(lens);

  const lensDiscGeo = track(new THREE.CircleGeometry(1.5, 36));
  const lensDiscMat = track(
    new THREE.MeshBasicMaterial({
      color: new THREE.Color(C.soft),
      transparent: true,
      opacity: 0.08,
      side: THREE.DoubleSide,
      blending: THREE.AdditiveBlending,
      depthWrite: false,
    })
  );
  const lensDisc = new THREE.Mesh(lensDiscGeo, lensDiscMat);
  lensDisc.position.copy(lensPos);
  lensDisc.rotation.y = Math.PI / 2;
  orbit.add(lensDisc);

  /* ---------------------------------------------------- destinations, decoy */

  const destGeo = track(new THREE.SphereGeometry(0.34, 14, 10));
  const destMeshes = [];
  const destPositions = [];
  for (let i = 0; i < FLOW_COUNT; i++) {
    const p = destPosition(i);
    destPositions.push(p);
    const k = i / (FLOW_COUNT - 1);
    const mat = track(
      glowMaterial(
        new THREE.Color(C.teal).lerp(new THREE.Color(C.soft), k * 0.7).getHex(),
        C.ink,
        1,
        1.9,
        1.5
      )
    );
    const m = new THREE.Mesh(destGeo, mat);
    m.position.copy(p);
    orbit.add(m);
    destMeshes.push(m);
  }

  const decoyEnd = new THREE.Vector3().fromArray(BASE.decoyEnd);
  const decoyGeo = track(new THREE.SphereGeometry(0.38, 14, 10));
  const decoyMat = track(glowMaterial(0x7d6320, C.gold, 1, 1.6, 1.9));
  const decoyMesh = new THREE.Mesh(decoyGeo, decoyMat);
  decoyMesh.position.copy(decoyEnd);
  orbit.add(decoyMesh);

  const decoyRingGeo = track(new THREE.TorusGeometry(0.72, 0.035, 5, 28));
  const decoyRingMat = track(glowMaterial(C.gold, C.ink, 0.8, 1.5, 1.6));
  const decoyRing = new THREE.Mesh(decoyRingGeo, decoyRingMat);
  decoyRing.position.copy(decoyEnd);
  decoyRing.rotation.x = Math.PI / 2.4;
  orbit.add(decoyRing);

  /* ------------------------------------------------------------ merkle tree */

  const treeRoot = new THREE.Vector3().fromArray(BASE.treeRoot);
  const levelH = (BASE.treeRoot[1] - BASE.treeLeafY) / 3;
  const nodePos = [];
  const leafX = [];
  for (let j = 0; j < 8; j++) {
    leafX.push(treeRoot.x + (j - 3.5) * (BASE.treeWidth / 7));
    nodePos.push(new THREE.Vector3(leafX[j], BASE.treeLeafY, treeRoot.z));
  }
  for (let j = 0; j < 4; j++) {
    nodePos.push(
      new THREE.Vector3(
        (leafX[j * 2] + leafX[j * 2 + 1]) / 2,
        BASE.treeLeafY + levelH,
        treeRoot.z
      )
    );
  }
  for (let j = 0; j < 2; j++) {
    nodePos.push(
      new THREE.Vector3(
        (nodePos[8 + j * 2].x + nodePos[9 + j * 2].x) / 2,
        BASE.treeLeafY + levelH * 2,
        treeRoot.z
      )
    );
  }
  nodePos.push(treeRoot.clone());

  /* order in which nodes light up: leaf, leaf, parent, and so on up */
  const BUILD_ORDER = [0, 1, 8, 2, 3, 9, 12, 4, 5, 10, 6, 7, 11, 13, 14];
  const slotStep = new Array(15);
  BUILD_ORDER.forEach((id, step) => {
    slotStep[id] = step;
  });

  const leafGeo = track(new THREE.BoxGeometry(0.28, 0.28, 0.28));
  const midGeo = track(new THREE.IcosahedronGeometry(0.23, 1));
  const topGeo = track(new THREE.IcosahedronGeometry(0.32, 1));
  const nodeMat = track(glowMaterial(C.teal, C.soft, 1, 1.7, 1.7));
  const rootMat = track(glowMaterial(C.bright, C.ink, 1, 1.5, 1.9));
  const treeMeshes = nodePos.map((p, id) => {
    const m = new THREE.Mesh(
      id < 8 ? leafGeo : id === 14 ? topGeo : midGeo,
      id === 14 ? rootMat : nodeMat
    );
    m.position.copy(p);
    orbit.add(m);
    return m;
  });

  const edgePairs = [
    [0, 8], [1, 8], [2, 9], [3, 9], [4, 10], [5, 10], [6, 11], [7, 11],
    [8, 12], [9, 12], [10, 13], [11, 13], [12, 14], [13, 14],
  ];
  const edgePts = [];
  for (const [a, b] of edgePairs) {
    edgePts.push(nodePos[a].x, nodePos[a].y, nodePos[a].z);
    edgePts.push(nodePos[b].x, nodePos[b].y, nodePos[b].z);
  }
  // feed line from the witness lens down into the tree root
  const feedTop = new THREE.Vector3(lensPos.x, lensPos.y - 1.62, lensPos.z);
  edgePts.push(feedTop.x, feedTop.y, feedTop.z, treeRoot.x, treeRoot.y + 0.28, treeRoot.z);
  const treeEdgeGeo = track(new THREE.BufferGeometry());
  treeEdgeGeo.setAttribute("position", new THREE.Float32BufferAttribute(edgePts, 3));
  const treeEdgeMat = track(
    new THREE.LineBasicMaterial({
      color: new THREE.Color(C.bright),
      transparent: true,
      opacity: 0.5,
    })
  );
  orbit.add(new THREE.LineSegments(treeEdgeGeo, treeEdgeMat));

  /* ---------------------------------------------------------------- anchor */

  const anchorPos = new THREE.Vector3().fromArray(BASE.anchor);
  const slabGeo = track(new THREE.BoxGeometry(0.82, 6.2, 0.36));
  const slabMat = track(glowMaterial(0xccdde6, C.bright, 1, 1.5, 2.2));
  const slab = new THREE.Mesh(slabGeo, slabMat);
  slab.position.copy(anchorPos);
  orbit.add(slab);

  const aRingGeo = track(new THREE.TorusGeometry(1.52, 0.095, 6, 32));
  const aRingMat = track(glowMaterial(C.teal, C.soft, 0.95, 1.5, 1.8));
  const aRingSpin = new THREE.Group();
  aRingSpin.position.set(anchorPos.x, anchorPos.y + 0.7, anchorPos.z);
  const aRing = new THREE.Mesh(aRingGeo, aRingMat);
  aRing.rotation.x = Math.PI / 2 - 0.42; // tilted, so the spin below is visible
  aRingSpin.add(aRing);
  orbit.add(aRingSpin);

  const capGeo = track(new THREE.IcosahedronGeometry(0.2, 1));
  const capMat = track(glowMaterial(C.ink, C.bright, 1, 1.4, 1.6));
  const cap = new THREE.Mesh(capGeo, capMat);
  cap.position.set(anchorPos.x, anchorPos.y + 3.28, anchorPos.z);
  orbit.add(cap);

  const anchorLineGeo = track(new THREE.BufferGeometry());
  anchorLineGeo.setAttribute(
    "position",
    new THREE.Float32BufferAttribute(
      [
        treeRoot.x, treeRoot.y, treeRoot.z,
        anchorPos.x, anchorPos.y + 0.7, anchorPos.z,
      ],
      3
    )
  );
  const anchorLineMat = track(
    new THREE.LineBasicMaterial({
      color: new THREE.Color(C.soft),
      transparent: true,
      opacity: 0.17,
    })
  );
  orbit.add(new THREE.Line(anchorLineGeo, anchorLineMat));

  /* travelling beads: capture into the tree, and root into the anchor */
  const beadGeo = track(new THREE.IcosahedronGeometry(0.11, 0));
  const captureBeadMat = track(glowMaterial(C.soft, C.ink, 1, 1.4, 1.8));
  const anchorBeadMat = track(glowMaterial(C.bright, C.ink, 1, 1.4, 1.8));
  const captureBead = new THREE.Mesh(beadGeo, captureBeadMat);
  const anchorBead = new THREE.Mesh(beadGeo, anchorBeadMat);
  captureBead.visible = false;
  anchorBead.visible = false;
  orbit.add(captureBead);
  orbit.add(anchorBead);

  /* ---------------------------------------------------------- flow curves  */

  function buildCurve(target) {
    const pts = [
      cubePos.clone(),
      new THREE.Vector3(gatePos.x - 0.9, gatePos.y * 0.6 + cubePos.y * 0.4, cubePos.z * 0.5),
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
  for (let i = 0; i < FLOW_COUNT; i++) paths.push(buildCurve(destPositions[i]));
  paths.push(buildCurve(decoyEnd));

  const pathPts = paths.map((c) => c.getPoints(SAMPLES - 1));
  const pathBasis = paths.map((c, i) => {
    const dir = pathPts[i][SAMPLES - 1].clone().sub(pathPts[i][0]).normalize();
    const u = new THREE.Vector3(0, 1, 0).cross(dir).normalize();
    const v = dir.clone().cross(u).normalize();
    return [u, v];
  });

  function samplePath(idx, u, out) {
    const f = THREE.MathUtils.clamp(u, 0, 1) * (SAMPLES - 1);
    const i0 = Math.floor(f);
    const i1 = Math.min(SAMPLES - 1, i0 + 1);
    out.copy(pathPts[idx][i0]).lerp(pathPts[idx][i1], f - i0);
    return out;
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
    if (isDecoy) tmpCol.setHex(C.danger).lerp(new THREE.Color(0xe08a72), rand() * 0.5);
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
  pGeo.boundingSphere = new THREE.Sphere(new THREE.Vector3(0, 0, 0), 16);
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

  function updateParticles(t) {
    const dPhase = t % DECOY_PERIOD;
    const dHead = dPhase < DECOY_TRAVEL ? dPhase / DECOY_TRAVEL : -1;
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
      const amp = apertureAmp(u) * pOff[i * 2 + 1];
      const ang = pOff[i * 2] + u * 2.4;
      const b = pathBasis[flow];
      tmpV.x += (b[0].x * Math.cos(ang) + b[1].x * Math.sin(ang)) * amp;
      tmpV.y += (b[0].y * Math.cos(ang) + b[1].y * Math.sin(ang)) * amp;
      tmpV.z += (b[0].z * Math.cos(ang) + b[1].z * Math.sin(ang)) * amp;
      pPos[i * 3] = tmpV.x;
      pPos[i * 3 + 1] = tmpV.y;
      pPos[i * 3 + 2] = tmpV.z;
      pAlpha[i] =
        Math.min(1, u / 0.16) *
        Math.min(1, (1 - u) / 0.1) *
        (flow === FLOW_COUNT ? 0.75 : 0.18);
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
  const dangerCol = new THREE.Color(C.danger);
  const scratch = new THREE.Color();

  function updateScene(t) {
    const pulse = 0.5 + 0.5 * Math.sin(t * 1.15);
    core.scale.setScalar(0.94 + pulse * 0.12);
    core.rotation.y = t * 0.22;
    core.rotation.x = t * 0.13;
    halo.scale.setScalar(1 + pulse * 0.1);
    haloMat.uniforms.uOpacity.value = 0.2 + pulse * 0.16;
    token.rotation.y = t * 0.75;
    token.rotation.z = t * 0.4;

    // decoy run
    const dPhase = t % DECOY_PERIOD;
    const dHead = dPhase < DECOY_TRAVEL ? dPhase / DECOY_TRAVEL : -1;
    const atGate = dHead >= 0 ? Math.exp(-Math.pow((dHead - 0.2) / 0.09, 2)) : 0;
    const atLens = dHead >= 0 ? Math.exp(-Math.pow((dHead - LENS_U) / 0.08, 2)) : 0;
    const atEnd = dHead >= 0 ? Math.exp(-Math.pow((dHead - 0.97) / 0.1, 2)) : 0;

    gateMat.uniforms.uCore.value.copy(brightCol).lerp(dangerCol, atGate * 0.85);
    gateDiscMat.opacity = 0.12 + 0.06 * Math.sin(t * 2.1) + atGate * 0.3;

    scratch.copy(tealCol).lerp(goldCol, atLens);
    lensMat.uniforms.uCore.value.copy(scratch);
    lensMat.uniforms.uRim.value.copy(softCol).lerp(goldCol, atLens);
    lensDiscMat.opacity = 0.07 + atLens * 0.45;
    lens.scale.setScalar(1 + atLens * 0.07);

    decoyMat.uniforms.uRim.value.copy(goldCol).lerp(inkCol, atEnd);
    decoyMesh.scale.setScalar(1 + atEnd * 0.35);
    decoyRing.rotation.z = t * 0.5;
    decoyRingMat.uniforms.uOpacity.value = 0.55 + atEnd * 0.45;

    // destinations breathe a little, out of phase
    for (let i = 0; i < FLOW_COUNT; i++) {
      const k = 0.5 + 0.5 * Math.sin(t * 1.3 + i * 0.9);
      destMeshes[i].scale.setScalar(0.9 + k * 0.16);
    }

    // merkle tree build cycle
    const phase = t % TREE_CYCLE;
    const step = phase / TREE_STEP;
    for (let id = 0; id < TREE_NODES; id++) {
      const age = step - slotStep[id];
      const grow = THREE.MathUtils.clamp(age / 0.55, 0, 1);
      const pop = grow < 1 ? 1 + Math.sin(grow * Math.PI) * 0.6 : 1;
      treeMeshes[id].visible = age >= 0;
      treeMeshes[id].scale.setScalar(grow * pop);
      treeMeshes[id].rotation.y = t * 0.4 + id;
    }

    // capture bead runs from the lens down to the root on every new node
    const inStep = phase % TREE_STEP;
    const capturing = step < TREE_NODES && inStep < 0.42;
    captureBead.visible = capturing;
    if (capturing) {
      const k = inStep / 0.42;
      captureBead.position.lerpVectors(feedTop, treeRoot, k);
      captureBead.scale.setScalar(0.8 + Math.sin(k * Math.PI) * 0.9);
    }

    // root anchors: bead travels to the anchor ring, the ring flashes
    const anchorStart = TREE_NODES * TREE_STEP;
    const travelling = phase >= anchorStart && phase < anchorStart + 1.3;
    anchorBead.visible = travelling;
    if (travelling) {
      const k = (phase - anchorStart) / 1.3;
      anchorBead.position.lerpVectors(treeRoot, aRingSpin.position, k);
      anchorBead.scale.setScalar(1 + Math.sin(k * Math.PI) * 1.1);
    }
    const arrive = decay(phase, anchorStart + 1.3, 2.2);
    aRingSpin.rotation.y = t * 0.5;
    aRingSpin.scale.setScalar(1 + arrive * 0.16);
    aRingMat.uniforms.uCore.value.copy(tealCol).lerp(inkCol, arrive);
    slabMat.uniforms.uGain.value = 1.5 + arrive * 1.4;
    cap.scale.setScalar(1 + arrive * 0.8);
  }

  /* ------------------------------------------------------------ camera fit */

  let vw = 1;
  let vh = 1;
  let baseY = 0;

  function fit() {
    const box = canvas.parentElement || canvas;
    const w = Math.max(1, Math.round(box.clientWidth || canvas.clientWidth || 1));
    const h = Math.max(1, Math.round(box.clientHeight || canvas.clientHeight || 1));
    if (w === vw && h === vh) return;
    vw = w;
    vh = h;
    renderer.setSize(w, h, false);
    const aspect = w / h;
    camera.aspect = aspect;

    // wide frames keep the pipeline horizontal; narrow frames tilt it into a
    // diagonal and shrink it so the same scene still reads on a phone
    const k = THREE.MathUtils.clamp((aspect - 0.85) / (1.7 - 0.85), 0, 1);
    const ease = k * k * (3 - 2 * k);
    const tilt = -1.15 * (1 - ease);
    const scale = 0.5 + 0.5 * ease;
    root.rotation.z = tilt;
    root.scale.setScalar(scale);

    // extents of the orbiting content, valid for every yaw
    const probe = [
      cubePos.clone().add(new THREE.Vector3(-half, 0, -half)),
      new THREE.Vector3(anchorPos.x + 1.5, anchorPos.y + 3.4, anchorPos.z),
      new THREE.Vector3(decoyEnd.x, decoyEnd.y - 0.75, decoyEnd.z),
      new THREE.Vector3(treeRoot.x, BASE.treeLeafY - 0.3, treeRoot.z),
      destPositions[0].clone(),
      destPositions[FLOW_COUNT - 1].clone(),
      destPositions[3].clone().add(new THREE.Vector3(0.4, 0, 0)),
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
      for (let k = 0; k < YAWS; k++) {
        const a = (k / YAWS) * Math.PI * 2;
        const px = r * Math.cos(a);
        const pz = r * Math.sin(a);
        const sx = Math.abs(px * ct - py * st) * framePadding;
        const sy = Math.abs(px * st + py * ct) * framePadding;
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
    orbit.rotation.y = startAngle + (stillTime == null ? (t / orbitPeriod) * Math.PI * 2 : 0) + px;
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
    fit();
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
      scene.traverse((o) => {
        if (o.isMesh || o.isPoints || o.isLine) o.geometry = null;
      });
      for (const d of disposables) if (d && d.dispose) d.dispose();
      renderer.dispose();
      if (renderer.forceContextLoss) renderer.forceContextLoss();
    },
  };
}

export default initHero;
