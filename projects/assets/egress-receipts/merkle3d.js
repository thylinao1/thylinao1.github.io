/*
 * merkle3d.js
 * Three.js view of the witness Merkle tree for the egress receipts project page.
 *
 * Leaves are the per flow digests, drawn as small cubes along the bottom and
 * labelled by index with an HTML overlay positioned from projected coordinates.
 * Internal nodes are spheres, edges are thin lines. Node hashing is not done
 * here: the caller passes hashPair, which is the RFC 6962 node hash from the
 * page's verifier. An odd node at the end of a level is promoted unchanged,
 * also per RFC 6962, and is drawn smaller and dimmer with a single carry edge.
 *
 * Public API
 *   initMerkle3d(canvas, { leaves, hashPair, onRoot })
 *     leaves    array of hex SHA-256 digests, up to 16
 *     hashPair  (leftHex, rightHex) => Promise<hex>
 *     onRoot    (rootHex, changedPath) => void
 *     preserveDrawingBuffer  optional, keep the buffer so headless tools can
 *                            screenshot it; the test harness turns it on
 *   returns { setLeaves, hide, restore, setReducedMotion, destroy }
 *
 * onRoot fires after setLeaves, after hide and after restore. changedPath is an
 * array of { level, index, hash } for every node whose hash moved, ordered from
 * the leaf level up; it is empty when nothing changed, which is the case for the
 * first build. A hide leaves the changed path red, a restore flashes the same
 * path and settles it back on teal.
 */

import * as THREE from "https://cdnjs.cloudflare.com/ajax/libs/three.js/0.160.0/three.module.min.js";

const C = {
  teal: 0x5a9e8f,
  bright: 0x7bbdae,
  soft: 0xbfded6,
  ink: 0xeef4f7,
  gold: 0xd8b34a,
  danger: 0xa94438,
};

const MAX_LEAVES = 16;
const LEVEL_H = 1.45;
const SLOT_MAX = 1.05;
const TREE_SPAN = 13;
const LEVEL_DELAY = 0.24; // seconds between level flashes
const FLASH_DUR = 0.85;
const ORBIT_PERIOD = 36;
const ORBIT_AMPL = 0.38;

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

function glowMaterial(core, rim, opacity) {
  return new THREE.ShaderMaterial({
    uniforms: {
      uCore: { value: new THREE.Color(core) },
      uRim: { value: new THREE.Color(rim) },
      uOpacity: { value: opacity },
      uPower: { value: 1.8 },
      uGain: { value: 1.7 },
    },
    vertexShader: GLOW_VERT,
    fragmentShader: GLOW_FRAG,
    transparent: opacity < 1,
  });
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

function isHex(v) {
  return typeof v === "string" && /^[0-9a-fA-F]+$/.test(v);
}

function noopHandle() {
  return {
    setLeaves() {},
    hide() {},
    restore() {},
    setReducedMotion() {},
    destroy() {},
  };
}

export function initMerkle3d(canvas, options = {}) {
  const hashPair = options.hashPair;
  const onRoot = typeof options.onRoot === "function" ? options.onRoot : () => {};
  if (typeof hashPair !== "function") throw new TypeError("merkle3d: hashPair is required");
  if (!canvas || !webglSupported()) {
    if (canvas && canvas.dispatchEvent) {
      setTimeout(() => canvas.dispatchEvent(new CustomEvent("merkle-fallback")), 0);
    }
    return noopHandle();
  }

  let renderer;
  try {
    renderer = new THREE.WebGLRenderer({
      canvas,
      alpha: true,
      antialias: true,
      preserveDrawingBuffer: !!options.preserveDrawingBuffer,
    });
  } catch (err) {
    setTimeout(() => canvas.dispatchEvent(new CustomEvent("merkle-fallback")), 0);
    return noopHandle();
  }
  renderer.setClearAlpha(0);
  renderer.setPixelRatio(Math.min(1.5, window.devicePixelRatio || 1));

  const scene = new THREE.Scene();
  const camera = new THREE.PerspectiveCamera(40, 1, 0.5, 200);
  const group = new THREE.Group();
  scene.add(group);

  /* ------------------------------------------------------------- geometry */

  const leafGeo = new THREE.BoxGeometry(0.34, 0.34, 0.34);
  const nodeGeo = new THREE.SphereGeometry(0.24, 12, 8);
  const carryGeo = new THREE.SphereGeometry(0.15, 10, 7);
  const edgeMat = new THREE.LineBasicMaterial({
    color: new THREE.Color(C.teal),
    transparent: true,
    opacity: 0.42,
  });
  const ghostMat = glowMaterial(0x4a1f1a, C.danger, 0.55);
  const disposables = [leafGeo, nodeGeo, carryGeo, edgeMat, ghostMat];

  let edgeLines = null;
  let meshes = []; // { mesh, node, mat, flashAt, changed }
  let ghostMesh = null;

  /* ---------------------------------------------------------- label layer */

  const host = canvas.parentElement || canvas;
  const hostPosition = host.style.position;
  if (host !== canvas && getComputedStyle(host).position === "static") {
    host.style.position = "relative";
  }
  const layer = document.createElement("div");
  layer.className = "merkle3d-labels";
  layer.setAttribute("aria-hidden", "true");
  Object.assign(layer.style, {
    position: "absolute",
    inset: "0",
    pointerEvents: "none",
    overflow: "hidden",
    font: '10px/1.2 ui-monospace, SFMono-Regular, "IBM Plex Mono", Menlo, monospace',
    letterSpacing: "0.04em",
  });
  host.appendChild(layer);
  const labels = [];

  function makeLabel() {
    const el = document.createElement("span");
    Object.assign(el.style, {
      position: "absolute",
      transform: "translate(-50%, 0)",
      color: "#eef4f7",
      opacity: "0.72",
      whiteSpace: "nowrap",
      textShadow: "0 1px 3px rgba(12,28,40,0.85)",
    });
    layer.appendChild(el);
    labels.push(el);
    return el;
  }

  /* ------------------------------------------------------- tree structure */

  let slots = []; // hex digest per original leaf index
  let hiddenIndex = -1;
  let levels = []; // levels[0] = leaves, last level holds the root
  let seq = 0;
  let pendingRoot = null; // { at, hash, path }
  let work = Promise.resolve(); // recomputes run one at a time, in order

  function slotX(index, count) {
    const step = Math.min(SLOT_MAX, count > 1 ? TREE_SPAN / (count - 1) : SLOT_MAX);
    return (index - (count - 1) / 2) * step;
  }

  async function computeLevels(visible, count) {
    let level = visible.map((entry, i) => ({
      hash: entry.hash,
      x: slotX(entry.index, count),
      level: 0,
      index: i,
      slot: entry.index,
      kids: [],
    }));
    const out = [level];
    while (level.length > 1) {
      const next = [];
      for (let i = 0; i < level.length; i += 2) {
        if (i + 1 < level.length) {
          const hash = await hashPair(level[i].hash, level[i + 1].hash);
          next.push({
            hash,
            x: (level[i].x + level[i + 1].x) / 2,
            level: out.length,
            index: next.length,
            kids: [level[i], level[i + 1]],
          });
        } else {
          // RFC 6962: an odd node is promoted to the next level unchanged
          next.push({
            hash: level[i].hash,
            x: level[i].x,
            level: out.length,
            index: next.length,
            kids: [level[i]],
            promoted: true,
          });
        }
      }
      out.push(next);
      level = next;
    }
    return out;
  }

  function diffLevels(oldLevels, newLevels) {
    const path = [];
    for (let l = 0; l < newLevels.length; l++) {
      for (const node of newLevels[l]) {
        const before = oldLevels[l] && oldLevels[l][node.index];
        if (!before || before.hash !== node.hash) {
          path.push({ level: l, index: node.index, hash: node.hash });
        }
      }
    }
    return path;
  }

  /* ----------------------------------------------------------- scene build */

  function clearScene() {
    for (const entry of meshes) {
      group.remove(entry.mesh);
      entry.mat.dispose();
    }
    meshes = [];
    if (edgeLines) {
      group.remove(edgeLines);
      edgeLines.geometry.dispose();
      edgeLines = null;
    }
    if (ghostMesh) {
      group.remove(ghostMesh);
      ghostMesh = null;
    }
    for (const el of labels) el.remove();
    labels.length = 0;
  }

  function yFor(level) {
    const height = (levels.length - 1) * LEVEL_H;
    return level * LEVEL_H - height / 2;
  }

  function rebuild(changedKeys, startAt, snap) {
    clearScene();
    const pts = [];
    for (let l = 0; l < levels.length; l++) {
      for (const node of levels[l]) {
        const isLeaf = l === 0;
        const key = l + ":" + node.index;
        const changed = changedKeys ? changedKeys.has(key) : false;
        const mat = glowMaterial(changed ? C.danger : C.teal, changed ? 0xe0836f : C.soft, 1);
        const mesh = new THREE.Mesh(isLeaf ? leafGeo : node.promoted ? carryGeo : nodeGeo, mat);
        mesh.position.set(node.x, yFor(l), 0);
        group.add(mesh);
        meshes.push({
          mesh,
          node,
          mat,
          changed,
          // a hide settles the changed path on red; a restore flashes the same
          // path and settles it back on teal
          settleRed: snap.hidden >= 0,
          flashAt: changed && startAt != null ? startAt + l * LEVEL_DELAY : -1,
        });
        for (const kid of node.kids) {
          pts.push(kid.x, yFor(l - 1), 0, node.x, yFor(l), 0);
        }
        if (isLeaf) {
          const el = makeLabel();
          el.textContent = String(node.slot);
          mesh.userData.label = el;
        } else if (l === levels.length - 1) {
          const el = makeLabel();
          el.textContent = "root " + node.hash.slice(0, 8);
          el.style.opacity = "0.9";
          mesh.userData.label = el;
          mesh.userData.labelAbove = true;
        }
      }
    }
    if (snap.hidden >= 0) {
      ghostMesh = new THREE.Mesh(leafGeo, ghostMat);
      ghostMesh.position.set(slotX(snap.hidden, snap.count), yFor(0), 0);
      group.add(ghostMesh);
      const el = makeLabel();
      el.textContent = snap.hidden + " hidden";
      el.style.color = "#e0836f";
      el.style.opacity = "0.95";
      ghostMesh.userData.label = el;
    }
    const geo = new THREE.BufferGeometry();
    geo.setAttribute("position", new THREE.Float32BufferAttribute(pts, 3));
    edgeLines = new THREE.LineSegments(geo, edgeMat);
    group.add(edgeLines);
    fit(true);
  }

  /* -------------------------------------------------------------- recompute */

  function visibleLeaves() {
    return slots
      .map((hash, index) => ({ hash, index }))
      .filter((e) => e.index !== hiddenIndex);
  }

  /* the snapshot is taken at call time, so a hide() that lands while an earlier
     build is still in flight is still computed against the state it asked for */
  function recompute(animate) {
    const snap = {
      visible: visibleLeaves(),
      hidden: hiddenIndex,
      count: slots.length,
      animate,
    };
    const run = () => runRecompute(snap);
    work = work.then(run, run);
    return work;
  }

  async function runRecompute(snap) {
    const mine = ++seq;
    const before = levels;
    const next = await computeLevels(snap.visible, snap.count);
    if (mine !== seq || destroyed) return;
    const path = before.length ? diffLevels(before, next) : [];
    levels = next;
    const keys = new Set(path.map((p) => p.level + ":" + p.index));
    const live = snap.animate && !reduced && running();
    rebuild(keys, live ? clock : null, snap);
    const root = levels.length ? levels[levels.length - 1][0].hash : null;
    if (live && path.length) {
      pendingRoot = { at: clock + (levels.length - 1) * LEVEL_DELAY + 0.3, hash: root, path };
    } else {
      pendingRoot = null;
      onRoot(root, path);
    }
    if (!raf) drawOnce();
  }

  /* ------------------------------------------------------------ camera fit */

  let vw = 0;
  let vh = 0;

  function fit(force) {
    const box = canvas.parentElement || canvas;
    const w = Math.max(1, Math.round(box.clientWidth || canvas.clientWidth || 1));
    const h = Math.max(1, Math.round(box.clientHeight || canvas.clientHeight || 1));
    if (!force && w === vw && h === vh) return;
    vw = w;
    vh = h;
    renderer.setSize(w, h, false);
    camera.aspect = w / h;

    // Same perspective aware fit as the hero: the orbit swings the outer leaves
    // toward the camera, which magnifies them. The y margin allows for the HTML
    // label that sits under each leaf.
    const tanV = Math.tan((camera.fov * Math.PI) / 360);
    let dist = 4;
    for (const entry of meshes) {
      const r = Math.abs(entry.mesh.position.x) + 0.5;
      const py = Math.abs(entry.mesh.position.y) + 0.95;
      for (let k = -3; k <= 3; k++) {
        const a = (k / 3) * ORBIT_AMPL;
        const sx = Math.abs(r * Math.cos(a)) * 1.06;
        const pz = Math.abs(r * Math.sin(a));
        dist = Math.max(dist, sx / (tanV * camera.aspect) + pz, py * 1.06 / tanV + pz);
      }
    }
    camera.position.set(0, dist * 0.07, dist);
    camera.lookAt(0, 0, 0);
    camera.updateProjectionMatrix();
  }

  /* ------------------------------------------------------------- animation */

  const tealCol = new THREE.Color(C.teal);
  const softCol = new THREE.Color(C.soft);
  const dangerCol = new THREE.Color(C.danger);
  const flashCol = new THREE.Color(C.gold);
  const scratch = new THREE.Color();
  const projected = new THREE.Vector3();

  function updateNodes(t) {
    for (const entry of meshes) {
      let k = 0;
      if (entry.changed) {
        if (entry.flashAt < 0) k = 1;
        else if (t >= entry.flashAt) k = Math.min(1, (t - entry.flashAt) / FLASH_DUR);
      }
      const burst = k > 0 && k < 1 ? Math.sin(k * Math.PI) : 0;
      scratch.copy(tealCol).lerp(dangerCol, entry.settleRed ? k : 0);
      entry.mat.uniforms.uCore.value.copy(scratch).lerp(flashCol, burst * 0.7);
      entry.mat.uniforms.uRim.value.copy(softCol).lerp(flashCol, burst * 0.8);
      const base = entry.node.promoted ? 0.9 : 1;
      entry.mesh.scale.setScalar(base * (1 + burst * 0.55));
      if (!entry.node.kids.length && entry.node.level > 0) continue;
      entry.mesh.rotation.y = t * 0.25 + entry.node.index * 0.6;
      entry.mesh.rotation.x = entry.node.level === 0 ? t * 0.2 : 0;
    }
    if (ghostMesh) {
      ghostMesh.rotation.y = -t * 0.5;
      ghostMesh.scale.setScalar(0.72 + Math.sin(t * 2) * 0.05);
    }
    if (pendingRoot && t >= pendingRoot.at) {
      const done = pendingRoot;
      pendingRoot = null;
      onRoot(done.hash, done.path);
    }
  }

  function updateLabels() {
    const w = vw;
    const h = vh;
    const all = meshes.map((e) => e.mesh).concat(ghostMesh ? [ghostMesh] : []);
    for (const mesh of all) {
      const el = mesh.userData.label;
      if (!el) continue;
      projected.copy(mesh.position);
      projected.y += mesh.userData.labelAbove ? 0.52 : -0.52;
      group.localToWorld(projected);
      projected.project(camera);
      el.style.left = ((projected.x * 0.5 + 0.5) * w).toFixed(1) + "px";
      el.style.top = (
        (-projected.y * 0.5 + 0.5) * h -
        (mesh.userData.labelAbove ? 14 : 0)
      ).toFixed(1) + "px";
    }
  }

  /* -------------------------------------------------------------- run loop */

  let raf = 0;
  let last = 0;
  let clock = 0;
  let reduced = false;
  let onScreen = true;
  let tabVisible = document.visibilityState !== "hidden";
  let destroyed = false;

  function running() {
    return !destroyed && !reduced && onScreen && tabVisible;
  }

  function render(t) {
    group.rotation.y = reduced ? 0.18 : Math.sin((t / ORBIT_PERIOD) * Math.PI * 2) * ORBIT_AMPL;
    group.rotation.x = -0.06;
    updateNodes(t);
    renderer.render(scene, camera);
    updateLabels();
  }

  function drawOnce() {
    fit();
    render(reduced ? 0 : clock);
  }

  function frame(now) {
    raf = requestAnimationFrame(frame);
    const dt = last ? Math.min(0.05, (now - last) / 1000) : 0.016;
    last = now;
    clock += dt;
    fit();
    render(clock);
  }

  function sync() {
    if (running()) {
      if (!raf) {
        last = 0;
        raf = requestAnimationFrame(frame);
      }
    } else if (raf) {
      cancelAnimationFrame(raf);
      raf = 0;
    }
  }

  const ro = new ResizeObserver(() => {
    fit(true);
    if (!raf && !destroyed) drawOnce();
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

  function onContextLost(e) {
    e.preventDefault();
    if (raf) cancelAnimationFrame(raf);
    raf = 0;
    canvas.dispatchEvent(new CustomEvent("merkle-fallback"));
  }
  canvas.addEventListener("webglcontextlost", onContextLost);

  const mq = window.matchMedia ? window.matchMedia("(prefers-reduced-motion: reduce)") : null;
  function setReducedMotion(on) {
    reduced = !!on;
    if (reduced) {
      if (raf) cancelAnimationFrame(raf);
      raf = 0;
      if (pendingRoot) {
        const done = pendingRoot;
        pendingRoot = null;
        onRoot(done.hash, done.path);
      }
      for (const entry of meshes) entry.flashAt = -1;
      drawOnce();
    } else {
      sync();
      if (!raf) drawOnce();
    }
  }
  const onMq = (e) => setReducedMotion(e.matches);
  if (mq) mq.addEventListener("change", onMq);

  /* ------------------------------------------------------------------ API */

  function setLeaves(next) {
    const list = Array.isArray(next) ? next.slice(0, MAX_LEAVES) : [];
    const clean = list.filter(isHex);
    if (clean.length !== list.length) {
      throw new TypeError("merkle3d: every leaf must be a hex digest string");
    }
    if (!clean.length) {
      slots = [];
      levels = [];
      clearScene();
      onRoot(null, []);
      return;
    }
    slots = clean;
    hiddenIndex = -1;
    levels = [];
    recompute(false);
  }

  function hide(index) {
    if (!slots.length) return;
    const i = Number(index);
    if (!Number.isInteger(i) || i < 0 || i >= slots.length || i === hiddenIndex) return;
    if (slots.length < 2) return;
    hiddenIndex = i;
    recompute(true);
  }

  function restore() {
    if (hiddenIndex < 0) return;
    hiddenIndex = -1;
    recompute(true);
  }

  if (mq && mq.matches) reduced = true;
  setLeaves(options.leaves || []);
  sync();
  if (!raf) drawOnce();

  return {
    setLeaves,
    hide,
    restore,
    setReducedMotion,
    destroy() {
      destroyed = true;
      seq++;
      if (raf) cancelAnimationFrame(raf);
      raf = 0;
      ro.disconnect();
      io.disconnect();
      document.removeEventListener("visibilitychange", onVisibility);
      canvas.removeEventListener("webglcontextlost", onContextLost);
      if (mq) mq.removeEventListener("change", onMq);
      clearScene();
      layer.remove();
      if (host !== canvas) host.style.position = hostPosition;
      for (const d of disposables) d.dispose();
      renderer.dispose();
      if (renderer.forceContextLoss) renderer.forceContextLoss();
    },
  };
}

export default initMerkle3d;
