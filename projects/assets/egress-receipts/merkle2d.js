/*
 * merkle2d.js
 * The enforcement log's Merkle tree, drawn flat on a 2D canvas.
 *
 * This replaces the Three.js view (merkle3d.js). The leaf numbers now sit
 * inside the canvas, directly under their leaf, and the shape reads as a
 * plain drawing rather than a scene. The maths is unchanged and still comes
 * from the page's own verifier: the leaves are the per row digests, hashPair
 * is the RFC 6962 node hash, and an odd node at the end of a level is
 * promoted to the next level unchanged, drawn smaller on a dashed carry edge.
 *
 * Public API, identical to the module it replaces
 *   initMerkle2d(canvas, { leaves, hashPair, onRoot })
 *     leaves    array of hex SHA-256 digests, up to 16
 *     hashPair  (leftHex, rightHex) => Promise<hex>
 *     onRoot    (rootHex, changedPath) => void
 *   returns { setLeaves, hide, restore, setReducedMotion, destroy }
 *
 * onRoot fires after setLeaves, after hide and after restore. changedPath is
 * an array of { level, index, hash } for every node whose hash moved, ordered
 * from the leaf level up; it is empty when nothing changed, which is the case
 * for the first build. A hide settles the changed path on the danger colour,
 * a restore flashes the same path and settles it back on teal.
 */

/* the page's palette, as rgb triples so they can be mixed */
const C = {
  teal: [90, 158, 143],
  soft: [191, 222, 214],
  ink: [238, 244, 247],
  gold: [216, 179, 74],
  danger: [201, 90, 74],
  dangerSoft: [224, 131, 111],
};
const BG_TOP = "#1a2f3f";
const BG_BOTTOM = "#2a5270";

const MAX_LEAVES = 16;
const LEVEL_MS = 120; // stagger between levels of the changed path
const FLASH_MS = 420; // one node's transition
const ROOT_SETTLE_MS = 300; // after the top level, before onRoot fires
const PULSE_MS = 3600; // idle glow on the root
const DPR_CAP = 2;

const FONT_STACK = '"IBM Plex Mono", ui-monospace, SFMono-Regular, Menlo, monospace';

const clamp = (lo, v, hi) => Math.max(lo, Math.min(hi, v));
const mix = (a, b, k) => [
  a[0] + (b[0] - a[0]) * k,
  a[1] + (b[1] - a[1]) * k,
  a[2] + (b[2] - a[2]) * k,
];
const rgba = (c, a) => "rgba(" + Math.round(c[0]) + "," + Math.round(c[1]) + "," + Math.round(c[2]) + "," + a.toFixed(3) + ")";
const ease = (k) => (k < 0.5 ? 2 * k * k : 1 - Math.pow(-2 * k + 2, 2) / 2);
const font = (size, weight) => (weight ? weight + " " : "") + size.toFixed(1) + "px " + FONT_STACK;
const now = () => (typeof performance !== "undefined" && performance.now ? performance.now() : Date.now());

function isHex(v) {
  return typeof v === "string" && /^[0-9a-fA-F]+$/.test(v);
}

function roundedRect(ctx, x, y, w, h, r) {
  ctx.beginPath();
  if (typeof ctx.roundRect === "function") {
    ctx.roundRect(x, y, w, h, r);
    return;
  }
  ctx.moveTo(x + r, y);
  ctx.arcTo(x + w, y, x + w, y + h, r);
  ctx.arcTo(x + w, y + h, x, y + h, r);
  ctx.arcTo(x, y + h, x, y, r);
  ctx.arcTo(x, y, x + w, y, r);
  ctx.closePath();
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

export function initMerkle2d(canvas, options = {}) {
  const hashPair = options.hashPair;
  const onRoot = typeof options.onRoot === "function" ? options.onRoot : () => {};
  if (typeof hashPair !== "function") throw new TypeError("merkle2d: hashPair is required");

  let ctx = null;
  try {
    ctx = canvas && canvas.getContext ? canvas.getContext("2d") : null;
  } catch (err) {
    ctx = null;
  }
  if (!ctx) {
    if (canvas && canvas.dispatchEvent) {
      setTimeout(() => canvas.dispatchEvent(new CustomEvent("merkle-fallback")), 0);
    }
    return noopHandle();
  }

  /* ------------------------------------------------------- tree structure */

  let slots = []; // hex digest per original leaf index
  let hiddenIndex = -1;
  let levels = []; // levels[0] = leaves, last level holds the root
  let seq = 0;
  let pendingRoot = null; // { at, hash, path }
  let work = Promise.resolve(); // recomputes run one at a time, in order

  /* what the current drawing is of: filled by build(), laid out by layout() */
  let changedKeys = new Set();
  let flashStart = null; // ms timestamp, or null for an instant change
  let settleRed = false; // a hide settles red, a restore flashes back to teal
  let hiddenSlot = -1;
  let slotCount = 0;
  let rootHex = null;
  let prevRootHex = null;

  let view = null; // pixel geometry, rebuilt on every resize
  let cssW = 0;
  let cssH = 0;
  let dpr = 1;

  async function computeLevels(visible) {
    let level = visible.map((entry, i) => ({
      hash: entry.hash,
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
          next.push({ hash, level: out.length, index: next.length, kids: [level[i], level[i + 1]] });
        } else {
          // RFC 6962: an odd node is promoted to the next level unchanged
          next.push({
            hash: level[i].hash,
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

  function visibleLeaves() {
    return slots.map((hash, index) => ({ hash, index })).filter((e) => e.index !== hiddenIndex);
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
    const next = await computeLevels(snap.visible);
    if (mine !== seq || destroyed) return;
    const path = before.length ? diffLevels(before, next) : [];
    const wasRoot = before.length ? before[before.length - 1][0].hash : null;
    levels = next;
    const live = snap.animate && !reduced && running();
    build(new Set(path.map((p) => p.level + ":" + p.index)), live ? now() : null, snap, wasRoot);
    const root = levels.length ? levels[levels.length - 1][0].hash : null;
    if (live && path.length) {
      pendingRoot = { at: flashStart + (levels.length - 1) * LEVEL_MS + ROOT_SETTLE_MS, hash: root, path };
    } else {
      pendingRoot = null;
      onRoot(root, path);
    }
    sync();
    if (!raf) drawOnce();
  }

  function build(keys, startAt, snap, wasRoot) {
    changedKeys = keys;
    flashStart = startAt;
    settleRed = snap.hidden >= 0;
    hiddenSlot = snap.hidden;
    slotCount = snap.count;
    prevRootHex = wasRoot;
    rootHex = levels.length ? levels[levels.length - 1][0].hash : null;
    layout();
  }

  function clearTree() {
    levels = [];
    changedKeys = new Set();
    flashStart = null;
    settleRed = false;
    hiddenSlot = -1;
    rootHex = null;
    prevRootHex = null;
    view = null;
  }

  /* -------------------------------------------------------------- layout */

  function flashFor(level) {
    return flashStart == null ? -1 : flashStart + level * LEVEL_MS;
  }

  function layout() {
    if (!levels.length || cssW < 8 || cssH < 8) {
      view = null;
      return;
    }
    const fs = clamp(8.5, cssW / 38, 15); // the leaf index labels
    const padX = clamp(10, cssW * 0.04, 30);
    const inner = Math.max(1, cssW - padX * 2);
    const count = Math.max(slotCount, 1);
    const step = count > 1 ? inner / (count - 1) : 0;
    const leafSize = clamp(6, Math.min(fs * 1.5, step * 0.66), 22);
    const nodeR = clamp(3, Math.min(leafSize * 0.46, step * 0.42), 12);
    const rootR = nodeR * 1.55;

    // the two legend lines share the top row; if they will not both fit they
    // are shrunk, and below the floor the witness line drops to its own row
    const legendLeft = "enforcement log, " + count + " rows";
    const legendRight = "witness root: anchored, does not move";
    let legendFs = clamp(7.2, fs * 0.9, 12);
    ctx.font = font(legendFs);
    const need = ctx.measureText(legendLeft).width + ctx.measureText(legendRight).width + fs * 1.4;
    let stacked = false;
    if (need > inner) {
      const shrunk = legendFs * (inner / need);
      if (shrunk >= 7.2) legendFs = shrunk;
      else stacked = true;
    }
    const legendBase1 = 4 + legendFs;
    const legendBase2 = legendBase1 + legendFs * 1.4;
    const legendBottom = stacked ? legendBase2 : legendBase1;

    // the root label and its note sit above the root; the two rows under the
    // leaves (index, then the hidden tag) are always reserved, so the geometry
    // does not shift between the clean and the hidden state
    const rootLabelBase = legendBottom + fs * 1.6;
    const noteBase = rootLabelBase + fs * 1.2;
    const hiddenBase = cssH - Math.max(4, fs * 0.4);
    const indexBase = hiddenBase - fs * 1.3;
    const leafCy = indexBase - fs * 0.95 - leafSize / 2;
    const rootCy = noteBase + fs * 0.35 + rootR;
    const span = Math.max(leafSize, leafCy - rootCy);
    const gap = levels.length > 1 ? span / (levels.length - 1) : 0;

    const xs = [];
    for (let l = 0; l < levels.length; l++) {
      xs[l] = levels[l].map((node) =>
        l === 0
          ? padX + node.slot * step
          : node.kids.reduce((sum, kid) => sum + xs[l - 1][kid.index], 0) / node.kids.length
      );
    }

    const nodes = [];
    const edges = [];
    let rootEntry = null;
    for (let l = 0; l < levels.length; l++) {
      const y = leafCy - l * gap;
      for (const node of levels[l]) {
        const key = l + ":" + node.index;
        const changed = changedKeys.has(key);
        const entry = {
          ref: node,
          x: xs[l][node.index],
          y,
          r: node.promoted ? nodeR * 0.66 : nodeR,
          size: leafSize,
          kind: l === 0 ? "leaf" : l === levels.length - 1 ? "root" : "node",
          dim: !!node.promoted,
          changed,
          flashAt: changed ? flashFor(l) : -1,
        };
        if (entry.kind === "root") {
          entry.r = rootR;
          rootEntry = entry;
        }
        nodes.push(entry);
        for (const kid of node.kids) {
          const kidChanged = changedKeys.has(l - 1 + ":" + kid.index);
          edges.push({
            x1: xs[l - 1][kid.index],
            y1: leafCy - (l - 1) * gap,
            x2: entry.x,
            y2: y,
            dashed: !!node.promoted,
            changed: changed && kidChanged,
            flashAt: changed && kidChanged ? flashFor(l) : -1,
          });
        }
      }
    }

    view = {
      nodes,
      edges,
      rootEntry,
      ghost:
        hiddenSlot >= 0
          ? { x: padX + hiddenSlot * step, y: leafCy, size: leafSize, flashAt: flashFor(0) }
          : null,
      fs,
      padX,
      legendLeft,
      legendRight,
      legendFs,
      legendBase1,
      legendBase2,
      stacked,
      rootLabelBase,
      noteBase,
      indexBase,
      hiddenBase,
      lineScale: clamp(0.85, cssW / 420, 1.7),
    };
  }

  /* ---------------------------------------------------------------- paint */

  function progress(entry, t) {
    if (!entry.changed) return 0;
    if (entry.flashAt < 0) return 1;
    if (t < entry.flashAt) return 0;
    return clamp(0, (t - entry.flashAt) / FLASH_MS, 1);
  }

  function shade(k, burst) {
    const base = mix(C.teal, C.danger, settleRed ? ease(k) : 0);
    return {
      core: mix(base, C.gold, burst * 0.7),
      rim: mix(C.soft, C.gold, burst * 0.85),
    };
  }

  /* centred text, nudged inward so a label never leaves the canvas */
  function textAt(text, x, y) {
    const half = ctx.measureText(text).width / 2;
    ctx.fillText(text, clamp(half + 2, x, cssW - half - 2), y);
  }

  function draw(t) {
    ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
    const grad = ctx.createLinearGradient(0, 0, cssW, cssH);
    grad.addColorStop(0, BG_TOP);
    grad.addColorStop(1, BG_BOTTOM);
    ctx.fillStyle = grad;
    ctx.fillRect(0, 0, cssW, cssH);
    const v = view;
    if (!v) return;

    ctx.textBaseline = "alphabetic";
    ctx.font = font(v.legendFs);
    ctx.textAlign = "left";
    ctx.fillStyle = rgba(C.ink, 0.6);
    ctx.fillText(v.legendLeft, v.padX, v.legendBase1);
    ctx.textAlign = "right";
    ctx.fillStyle = rgba(C.soft, 0.56);
    ctx.fillText(v.legendRight, cssW - v.padX, v.stacked ? v.legendBase2 : v.legendBase1);

    for (const e of v.edges) {
      const k = progress(e, t);
      const burst = k > 0 && k < 1 ? Math.sin(k * Math.PI) : 0;
      const col = shade(k, burst).core;
      ctx.strokeStyle = rgba(col, 0.3 + (settleRed ? 0.55 * ease(k) : 0.4 * burst));
      ctx.lineWidth = (e.dashed ? 0.9 : 1.15) * (1 + burst * 0.7) * v.lineScale;
      ctx.setLineDash(e.dashed ? [3 * v.lineScale, 3 * v.lineScale] : []);
      ctx.beginPath();
      ctx.moveTo(e.x1, e.y1);
      ctx.lineTo(e.x2, e.y2);
      ctx.stroke();
    }
    ctx.setLineDash([]);

    for (const n of v.nodes) {
      const k = progress(n, t);
      const burst = k > 0 && k < 1 ? Math.sin(k * Math.PI) : 0;
      const { core, rim } = shade(k, burst);
      const bump = 1 + burst * 0.35;
      if (n.kind === "root") {
        const pulse = reduced ? 0.4 : 0.5 + 0.5 * Math.sin((t / PULSE_MS) * Math.PI * 2);
        const outer = n.r * (2.3 + pulse * 0.9);
        const halo = ctx.createRadialGradient(n.x, n.y, n.r * 0.4, n.x, n.y, outer);
        halo.addColorStop(0, rgba(core, 0.24 + pulse * 0.14));
        halo.addColorStop(1, rgba(core, 0));
        ctx.fillStyle = halo;
        ctx.beginPath();
        ctx.arc(n.x, n.y, outer, 0, Math.PI * 2);
        ctx.fill();
      }
      ctx.save();
      if (burst > 0.02) {
        ctx.shadowColor = rgba(C.gold, 0.7 * burst);
        ctx.shadowBlur = 4 + 11 * burst;
      }
      ctx.fillStyle = rgba(core, n.dim ? 0.7 : 0.95);
      ctx.strokeStyle = rgba(rim, n.dim ? 0.4 : 0.68);
      ctx.lineWidth = Math.max(0.8, v.fs * 0.085) * v.lineScale;
      if (n.kind === "leaf") {
        const s = n.size * bump;
        roundedRect(ctx, n.x - s / 2, n.y - s / 2, s, s, s * 0.28);
      } else {
        ctx.beginPath();
        ctx.arc(n.x, n.y, n.r * bump, 0, Math.PI * 2);
      }
      ctx.fill();
      ctx.stroke();
      ctx.restore();
      if (n.kind === "leaf") {
        ctx.font = font(v.fs);
        ctx.textAlign = "center";
        ctx.fillStyle = rgba(mix(C.ink, C.dangerSoft, settleRed ? ease(k) : 0), 0.78);
        textAt(String(n.ref.slot), n.x, v.indexBase);
      }
    }

    if (v.ghost) {
      const g = v.ghost;
      const k = progress({ changed: true, flashAt: g.flashAt }, t);
      const e = ease(k);
      const s = g.size;
      ctx.save();
      ctx.setLineDash([2.4 * v.lineScale, 2.4 * v.lineScale]);
      ctx.fillStyle = rgba(C.danger, 0.2 + 0.28 * e);
      ctx.strokeStyle = rgba(C.dangerSoft, 0.35 + 0.5 * e);
      ctx.lineWidth = Math.max(0.9, v.fs * 0.09) * v.lineScale;
      roundedRect(ctx, g.x - s / 2, g.y - s / 2, s, s, s * 0.28);
      ctx.fill();
      ctx.stroke();
      ctx.restore();
      ctx.font = font(v.fs);
      ctx.textAlign = "center";
      ctx.fillStyle = rgba(C.dangerSoft, 0.55 + 0.42 * e);
      textAt(String(hiddenSlot), g.x, v.indexBase);
      ctx.font = font(v.fs * 0.92);
      ctx.fillStyle = rgba(C.dangerSoft, 0.95 * e);
      textAt("hidden", g.x, v.hiddenBase);
    }

    const root = v.rootEntry;
    if (root && rootHex) {
      const rk = progress(root, t);
      const shown = rk > 0 || !prevRootHex ? rootHex : prevRootHex;
      ctx.font = font(v.fs * 1.06, "500");
      ctx.textAlign = "center";
      ctx.fillStyle = rgba(mix(C.ink, C.dangerSoft, settleRed ? ease(rk) : 0), 0.95);
      textAt("root " + shown.slice(0, 8), root.x, v.rootLabelBase);
      if (hiddenSlot >= 0) {
        ctx.font = font(v.fs * 0.92);
        ctx.fillStyle = rgba(C.dangerSoft, 0.92 * ease(rk));
        textAt("root changed", root.x, v.noteBase);
      }
    }
  }

  /* -------------------------------------------------------------- run loop */

  let raf = 0;
  let reduced = false;
  let onScreen = true;
  let tabVisible = document.visibilityState !== "hidden";
  let destroyed = false;

  function running() {
    return !destroyed && !reduced && onScreen && tabVisible;
  }

  function fit(force) {
    const w = Math.max(1, Math.round(canvas.clientWidth || 0));
    const h = Math.max(1, Math.round(canvas.clientHeight || 0));
    const ratio = Math.min(DPR_CAP, window.devicePixelRatio || 1);
    if (!force && w === cssW && h === cssH && ratio === dpr) return false;
    cssW = w;
    cssH = h;
    dpr = ratio;
    const bw = Math.max(1, Math.round(w * ratio));
    const bh = Math.max(1, Math.round(h * ratio));
    if (canvas.width !== bw) canvas.width = bw;
    if (canvas.height !== bh) canvas.height = bh;
    layout();
    return true;
  }

  function drawOnce() {
    fit();
    draw(now());
  }

  function flushRoot() {
    if (!pendingRoot) return;
    const done = pendingRoot;
    pendingRoot = null;
    onRoot(done.hash, done.path);
  }

  function frame() {
    raf = requestAnimationFrame(frame);
    const t = now();
    draw(t);
    if (pendingRoot && t >= pendingRoot.at) flushRoot();
  }

  function sync() {
    if (running()) {
      if (!raf) raf = requestAnimationFrame(frame);
    } else if (raf) {
      cancelAnimationFrame(raf);
      raf = 0;
      flushRoot();
    }
  }

  let ro = null;
  let onWindowResize = null;
  if (typeof ResizeObserver === "function") {
    ro = new ResizeObserver(() => {
      if (destroyed) return;
      if (fit(false) && !raf) drawOnce();
    });
    ro.observe(canvas);
  } else {
    onWindowResize = () => {
      if (destroyed) return;
      if (fit(false) && !raf) drawOnce();
    };
    window.addEventListener("resize", onWindowResize);
  }

  let io = null;
  if (typeof IntersectionObserver === "function") {
    io = new IntersectionObserver(
      (entries) => {
        onScreen = entries.some((e) => e.isIntersecting);
        sync();
      },
      { rootMargin: "120px" }
    );
    io.observe(canvas);
  }

  function onVisibility() {
    tabVisible = document.visibilityState !== "hidden";
    sync();
  }
  document.addEventListener("visibilitychange", onVisibility);

  const mq = window.matchMedia ? window.matchMedia("(prefers-reduced-motion: reduce)") : null;
  function setReducedMotion(on) {
    reduced = !!on;
    if (reduced) {
      if (raf) cancelAnimationFrame(raf);
      raf = 0;
      flushRoot();
      flashStart = null; // every pending change lands at once
      layout();
      drawOnce();
    } else {
      sync();
      if (!raf) drawOnce();
    }
  }
  const onMq = (e) => setReducedMotion(e.matches);
  if (mq && mq.addEventListener) mq.addEventListener("change", onMq);

  /* a late web font changes the text metrics the layout was measured with */
  if (document.fonts && document.fonts.ready && document.fonts.ready.then) {
    document.fonts.ready
      .then(() => {
        if (destroyed) return;
        layout();
        if (!raf) drawOnce();
      })
      .catch(() => {});
  }

  /* ------------------------------------------------------------------ API */

  function setLeaves(next) {
    const list = Array.isArray(next) ? next.slice(0, MAX_LEAVES) : [];
    const clean = list.filter(isHex);
    if (clean.length !== list.length) {
      throw new TypeError("merkle2d: every leaf must be a hex digest string");
    }
    if (!clean.length) {
      slots = [];
      hiddenIndex = -1;
      clearTree();
      drawOnce();
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
  fit(true);
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
      pendingRoot = null;
      if (raf) cancelAnimationFrame(raf);
      raf = 0;
      if (ro) ro.disconnect();
      if (io) io.disconnect();
      if (onWindowResize) window.removeEventListener("resize", onWindowResize);
      document.removeEventListener("visibilitychange", onVisibility);
      if (mq && mq.removeEventListener) mq.removeEventListener("change", onMq);
      clearTree();
      try {
        ctx.setTransform(1, 0, 0, 1, 0, 0);
        ctx.clearRect(0, 0, canvas.width, canvas.height);
      } catch (err) {
        /* the canvas may already be gone */
      }
    },
  };
}

export default initMerkle2d;
