/**
 * verify-web.js - verify a Shadow Commit egress+intent receipt in the browser, offline.
 *
 * A port of judge-kit/verify.mjs (the self-contained node verifier) to a dependency-free browser
 * ES module built on WebCrypto alone. It opens no socket and imports nothing. Everything the node
 * verifier does without a filesystem or a git repository is reproduced byte for byte: the DSSE
 * PAE and its Ed25519 check against an out-of-band journal.pub, the canonical-JSON re-encode and
 * subject digest, the witness / enforcement / canary Merkle roots recomputed from the receipt's
 * own evidence (same leaf canonicalisation, RFC 9162 hashing, push order, per-leaf inclusion
 * proofs), the n-continuity check, the CONTRACT.md 4 reconciliation (MATCHED / EXPECTED-BENIGN /
 * OMITTED / PHANTOM, the three allow-classes, the resolvedIp second key that lets a CDN-backed
 * hostname match the IP on the wire), and the offline Rekor read-back against a pinned rekor.pub.
 *
 * The git-note read-back CANNOT run in a browser: it needs a git repository. A page therefore
 * lands on the verdict the node verifier gives with `--no-anchor`, exit 2 UNVERIFIED, unless the
 * receipt carries a Rekor entry that verifies offline here, in which case the anchor IS read back
 * from outside the lab and the verdict is exit 0 (CONTRACT.md 4d: a check that did not run is not
 * a check that passed).
 *
 * Sources: judge-kit/verify.mjs; attest/verify/{verify-core,rekor-offline,verify}.mts;
 * attest/receipt/{receipt-core,make-real-receipts}.mts; CONTRACT.md 1 to 5.
 *
 * EXPORTS
 *
 * verifyReceipt(receipt, { journalPubPem, rekorPubPem, trustRootLabel })
 *   Verifies one already-parsed DSSE envelope. `journalPubPem` is the out-of-band trust root as
 *   PEM text, imported as spki with algorithm {name:"Ed25519"}; pass the file's exact bytes,
 *   trailing newline included, because its sha256 is printed. `rekorPubPem` is the pinned
 *   public-log key (without it a Rekor anchor reports unverifiable, not verified), and the
 *   cosmetic `trustRootLabel` names the `trust root` line, default "journal.pub".
 *   Promise of { exitCode 0|1|2 (the node verifier's rule, CONTRACT.md 4d), verdict
 *   "OK"|"BROKEN"|"UNVERIFIED", verdictLine, lines[] (the verifier's output, in order),
 *   signatureOk, witnessRoot / enforcementRoot / canaryRoot (hex, RECOMPUTED from the evidence),
 *   reconcile { matched, expectedBenign, expectedBenignDetail[{allowClass,dst}], omitted
 *   ["tcp 1.2.3.4:443"], omittedDetail[{proto,dstHostOrIP,dstPort,bytesOut,bytesIn}], phantom
 *   ["host:port"] }, anchor { type, readBack, details } with readBack one of "not-in-browser",
 *   "rekor-verified", "rekor-failed", "rekor-unverifiable", "no-anchor", "foreign-key",
 *   "bad-signature", "root-mismatch", and broken[], unverified[], notes[], runId, the claimed
 *   roots, treeSizes, canaryHits }.
 *
 * hideEnforcementRow(receipt, n)
 *   Promise of a NEW DSSE envelope with the enforcement row whose decision index is `n` deleted
 *   and enforcementLogMerkleRoot recomputed over the shortened log, plus treeSizes.enforcement
 *   and the subject digest: the edit attest/receipt/make-real-receipts.mts makes to cut
 *   receipt-real-tampered.json from receipt-real-clean.json. The witness evidence, the witness
 *   root, the anchored checkpoint body and producedAt carry over untouched, which is what makes
 *   the lie visible. The one thing the browser cannot copy is the lab's signing key, which is not
 *   here and must not be: a throwaway Ed25519 key generated in the page stands in for it and
 *   signs both the payload and the anchor submission, as a real lab's own key does. Its SPKI PEM
 *   comes back as the NON-ENUMERABLE property `labPublicKeyPem` (JSON.stringify still emits a
 *   clean three-field envelope) and the deleted row as `hiddenRow`. Verify under
 *   `labPublicKeyPem` for the lying-lab case (exit 1, one named OMITTED, the n gap, what the node
 *   verifier prints for receipt-real-tampered.json); verify the same object under the real
 *   journal.pub for the forgery case (exit 1 at the signature, nothing after it).
 *
 * merkleHashPair(leftHex, rightHex)
 *   Promise of the hex RFC 6962 interior-node hash SHA-256(0x01 || left || right), the verifier's
 *   own nodeHash. For drawing a tree.
 *
 * merkleRoot(leafHexes)
 *   Promise of the hex root over already-hashed leaves, with the verifier's split rule: the
 *   largest power of two strictly below the leaf count goes left. Empty gives EMPTY_ROOT, the
 *   SHA-256 of zero bytes. Agrees with the MerkleAccumulator the receipt builder uses.
 *
 * leafDigests(receipt)
 *   Promise of the enforcement tree's hex leaf digests in file order: per row,
 *   SHA-256(0x00 || canonicalJson(row)). These are the leaves merkleRoot() consumes.
 *
 * canonicalJson(value)
 *   The canonical-JSON rule the whole scheme hashes under: object keys sorted by UTF-16 code
 *   unit, no insignificant whitespace, undefined dropped in objects and null in arrays, toJSON
 *   honoured. Exported so a page can show the exact bytes that go into a leaf.
 */

const PAYLOAD_TYPE = "application/vnd.in-toto+json";
const PREDICATE_TYPE = "https://shadow-commit/egress-receipt/v0.3";
const IN_TOTO_STATEMENT = "https://in-toto.io/Statement/v1";
const AUTHORISED = new Set(["LIVE", "ALLOW", "HELD"]);
const DNS_PORT = 53;
const LEAF_PREFIX = new Uint8Array([0]);
const NODE_PREFIX = new Uint8Array([1]);
const ELLIPSIS = "\u2026";
const ARROW = "\u2192";
const NOTE_SEPARATOR = "\n\n\u2014 ";

/* --- bytes --- */

const TEXT_ENCODER = new TextEncoder();
const TEXT_DECODER = new TextDecoder();

const utf8 = (text) => TEXT_ENCODER.encode(text);
const fromUtf8 = (bytes) => TEXT_DECODER.decode(bytes);

function concatBytes(parts) {
  const out = new Uint8Array(parts.reduce((n, p) => n + p.length, 0));
  let at = 0;
  for (const part of parts) {
    out.set(part, at);
    at += part.length;
  }
  return out;
}
function toHex(bytes) {
  let out = "";
  for (let i = 0; i < bytes.length; i++) out += bytes[i].toString(16).padStart(2, "0");
  return out;
}
function fromHex(text) {
  const s = String(text ?? "");
  if (s.length % 2 !== 0 || !/^[0-9a-fA-F]*$/.test(s)) return new Uint8Array(0);
  const out = new Uint8Array(s.length / 2);
  for (let i = 0; i < out.length; i++) out[i] = parseInt(s.slice(i * 2, i * 2 + 2), 16);
  return out;
}
function fromBase64(text) {
  try {
    const binary = atob(String(text ?? ""));
    const out = new Uint8Array(binary.length);
    for (let i = 0; i < binary.length; i++) out[i] = binary.charCodeAt(i);
    return out;
  } catch {
    return new Uint8Array(0);
  }
}
function toBase64(bytes) {
  let binary = "";
  for (let i = 0; i < bytes.length; i++) binary += String.fromCharCode(bytes[i]);
  return btoa(binary);
}
function bytesEqual(a, b) {
  if (a.length !== b.length) return false;
  for (let i = 0; i < a.length; i++) if (a[i] !== b[i]) return false;
  return true;
}

/* --- canonical json, sha256 --- */

export function canonicalJson(value) {
  if (value === undefined) return "null";
  if (value === null || typeof value !== "object") return JSON.stringify(value) ?? "null";
  if (typeof value.toJSON === "function") return canonicalJson(value.toJSON());
  if (Array.isArray(value)) return "[" + value.map((entry) => canonicalJson(entry)).join(",") + "]";
  const parts = [];
  for (const key of Object.keys(value).sort()) {
    const entry = value[key];
    if (entry === undefined || typeof entry === "function" || typeof entry === "symbol") continue;
    parts.push(JSON.stringify(key) + ":" + canonicalJson(entry));
  }
  return "{" + parts.join(",") + "}";
}

async function sha256(...parts) {
  const digest = await crypto.subtle.digest("SHA-256", concatBytes(parts));
  return new Uint8Array(digest);
}

const sha256Hex = async (text) => toHex(await sha256(utf8(text)));

let emptyRootCache = null;
async function emptyRoot() {
  return (emptyRootCache ??= await sha256(new Uint8Array(0)));
}

/* --- merkle, RFC 6962 --- */

const leafHash = (entry) => sha256(LEAF_PREFIX, typeof entry === "string" ? utf8(entry) : entry);
const nodeHash = (left, right) => sha256(NODE_PREFIX, left, right);

function splitPoint(n) {
  let k = 1;
  while (k * 2 < n) k *= 2;
  return k;
}

async function merkleRootBytes(leaves) {
  if (leaves.length === 0) return emptyRoot();
  if (leaves.length === 1) return leaves[0];
  const k = splitPoint(leaves.length);
  return nodeHash(await merkleRootBytes(leaves.slice(0, k)), await merkleRootBytes(leaves.slice(k)));
}

async function inclusionProof(leaves, index) {
  if (!Number.isInteger(index) || index < 0 || index >= leaves.length) {
    throw new RangeError(`leaf index ${index} is outside a tree of ${leaves.length}`);
  }
  if (leaves.length === 1) return [];
  const k = splitPoint(leaves.length);
  if (index < k) {
    return [...(await inclusionProof(leaves.slice(0, k), index)), await merkleRootBytes(leaves.slice(k))];
  }
  return [...(await inclusionProof(leaves.slice(k), index - k)), await merkleRootBytes(leaves.slice(0, k))];
}

async function verifyInclusion(leaf, index, treeSize, proof, root) {
  if (!Number.isInteger(index) || !Number.isInteger(treeSize)) return false;
  if (index < 0 || treeSize <= 0 || index >= treeSize) return false;
  let fn = index;
  let sn = treeSize - 1;
  let r = leaf;
  for (const p of proof) {
    if (sn === 0) return false;
    if ((fn & 1) === 1 || fn === sn) {
      r = await nodeHash(p, r);
      while ((fn & 1) === 0 && fn !== 0) {
        fn >>= 1;
        sn >>= 1;
      }
    } else {
      r = await nodeHash(r, p);
    }
    fn >>= 1;
    sn >>= 1;
  }
  return sn === 0 && bytesEqual(r, root);
}

/** apps/server/src/merkle.ts MerkleAccumulator, unrolled: push, peak merge, right-to-left bag. */
async function accumulatorRoot(leaves) {
  const peaks = [];
  for (const leaf of leaves) {
    peaks.push({ size: 1, hash: leaf });
    for (let i = peaks.length - 1; i > 0; i--) {
      const right = peaks[i];
      const left = peaks[i - 1];
      if (left.size !== right.size) break;
      peaks.splice(i - 1, 2, { size: left.size * 2, hash: await nodeHash(left.hash, right.hash) });
    }
  }
  if (peaks.length === 0) return emptyRoot();
  let root = peaks[peaks.length - 1].hash;
  for (let i = peaks.length - 2; i >= 0; i--) root = await nodeHash(peaks[i].hash, root);
  return root;
}

async function proveAll(leaves, rootHex) {
  if (leaves.length === 0) return true;
  const root = fromHex(rootHex);
  for (let i = 0; i < leaves.length; i++) {
    const proof = await inclusionProof(leaves, i);
    if (!(await verifyInclusion(leaves[i], i, leaves.length, proof, root))) return false;
  }
  return true;
}

export async function merkleHashPair(leftHex, rightHex) {
  return toHex(await nodeHash(fromHex(leftHex), fromHex(rightHex)));
}

export async function merkleRoot(leafHexes) {
  const leaves = (leafHexes ?? []).map((hex) => fromHex(hex));
  return toHex(await merkleRootBytes(leaves));
}

export async function leafDigests(receipt) {
  const rows = statementOf(receipt)?.predicate?.evidence?.enforcement ?? [];
  const out = [];
  for (const row of rows) out.push(toHex(await leafHash(canonicalJson(row))));
  return out;
}

/* --- keys and DSSE --- */

function pemToDer(pem) {
  const match = /-----BEGIN [A-Z ]+-----([\s\S]*?)-----END [A-Z ]+-----/.exec(String(pem ?? ""));
  const body = (match ? match[1] : String(pem ?? "")).replace(/[^A-Za-z0-9+/=]/g, "");
  const der = fromBase64(body);
  return der.length ? der : null;
}

const derHexOf = (pem) => (pemToDer(pem) ? toHex(pemToDer(pem)) : null);

function derToPem(der) {
  const b64 = toBase64(der);
  const wrapped = (b64.match(/.{1,64}/g) ?? []).join("\n");
  return `-----BEGIN PUBLIC KEY-----\n${wrapped}\n-----END PUBLIC KEY-----\n`;
}

async function importEd25519(pem) {
  const der = pemToDer(pem);
  if (!der) return null;
  try {
    return await crypto.subtle.importKey("spki", der, { name: "Ed25519" }, true, ["verify"]);
  } catch {
    return null;
  }
}

async function verifyEd25519(key, data, signature) {
  if (!key) return false;
  try {
    return await crypto.subtle.verify({ name: "Ed25519" }, key, signature, data);
  } catch {
    return false;
  }
}

/** node's crypto.verify("sha256", ...) on a P-256 key is ECDSA-SHA256 over a DER signature;
 * WebCrypto wants the raw r||s pair, so unwrap the DER SEQUENCE of two INTEGERs. */
function derToRawEcdsa(der) {
  if (der.length < 8 || der[0] !== 0x30) return null;
  let i = 1;
  let len = der[i++];
  if (len & 0x80) {
    const count = len & 0x7f;
    if (count < 1 || count > 2) return null;
    len = 0;
    for (let k = 0; k < count; k++) len = (len << 8) | der[i++];
  }
  const readInt = () => {
    if (der[i++] !== 0x02) return null;
    const size = der[i++];
    if (size & 0x80) return null;
    let value = der.subarray(i, i + size);
    i += size;
    while (value.length > 0 && value[0] === 0) value = value.subarray(1);
    if (value.length > 32) return null;
    const padded = new Uint8Array(32);
    padded.set(value, 32 - value.length);
    return padded;
  };
  const r = readInt();
  if (!r) return null;
  const s = readInt();
  if (!s) return null;
  const raw = new Uint8Array(64);
  raw.set(r, 0);
  raw.set(s, 32);
  return raw;
}

async function verifyEcdsaSha256(key, data, derSignature) {
  const raw = derToRawEcdsa(derSignature);
  if (!key || !raw) return false;
  try {
    return await crypto.subtle.verify({ name: "ECDSA", hash: "SHA-256" }, key, raw, data);
  } catch {
    return false;
  }
}

/** DSSE Pre-Authentication Encoding: the exact bytes the Ed25519 signature covers. */
function pae(payloadType, payloadB64) {
  const typeLen = utf8(payloadType).length;
  const payloadLen = utf8(payloadB64).length;
  return utf8(`DSSEv1 ${typeLen} ${payloadType} ${payloadLen} ${payloadB64}`);
}

async function verifyEnvelope(env, publicKey) {
  if (env.payloadType !== PAYLOAD_TYPE) return { ok: false, reason: `payloadType ${env.payloadType}` };
  const bytes = fromBase64(env.payload);
  const text = fromUtf8(bytes);
  let statement;
  try {
    statement = JSON.parse(text);
  } catch {
    return { ok: false, reason: "payload is not JSON" };
  }
  if (canonicalJson(statement) !== text) return { ok: false, reason: "payload bytes are not canonical" };
  const paeBytes = pae(env.payloadType, env.payload);
  let okSig = false;
  for (const s of env.signatures ?? []) {
    if (await verifyEd25519(publicKey, paeBytes, fromBase64(s?.sig))) {
      okSig = true;
      break;
    }
  }
  if (!okSig) return { ok: false, reason: "no valid signature over the PAE" };
  return { ok: true, statement };
}

function statementOf(env) {
  try {
    return JSON.parse(fromUtf8(fromBase64(env?.payload)));
  } catch {
    return null;
  }
}

/* --- reconciliation --- */

function enforcementDst(row) {
  const target = typeof row.target === "string" ? row.target : "";
  const cls = String(row.class ?? "");
  if (cls === "decoy") return null;
  if (target.startsWith("model/")) return null;
  if (/^https?:\/\//.test(target)) {
    try {
      const u = new URL(target);
      const port = u.port || (u.protocol === "https:" ? "443" : "80");
      return `${u.hostname.toLowerCase()}:${port}`;
    } catch {
      return null;
    }
  }
  if (/^[^/]+:\d+$/.test(target)) return target.toLowerCase();
  return null;
}

const portOf = (dst) => (dst.lastIndexOf(":") >= 0 ? dst.slice(dst.lastIndexOf(":") + 1) : "");

function enforcementDsts(row) {
  const dst = enforcementDst(row);
  if (!dst) return [];
  const keys = [dst];
  const resolvedIp = typeof row.resolvedIp === "string" ? row.resolvedIp.trim().toLowerCase() : "";
  if (resolvedIp) keys.push(`${resolvedIp}:${portOf(dst)}`);
  return keys;
}

const hostPort = (t) => `${t.dstHostOrIP.toLowerCase()}:${t.dstPort}`;

function reconcile(flows, enforcementRows, allow) {
  const authorisedDsts = new Set();
  const authRows = [];
  for (const row of enforcementRows) {
    if (!AUTHORISED.has(String(row.decision ?? ""))) continue;
    const keys = enforcementDsts(row);
    if (!keys.length) continue;
    authRows.push(keys);
    for (const k of keys) authorisedDsts.add(k);
  }
  const provider = allow.providerHostPort.toLowerCase();
  const decoy = allow.decoyHostPort.toLowerCase();
  const classified = [];
  const coveredDsts = new Set();
  for (const flow of flows) {
    const hp = hostPort(flow);
    if ((flow.proto === "udp" || flow.proto === "tcp") && flow.dstPort === DNS_PORT) {
      classified.push({ flow, klass: "EXPECTED-BENIGN", allowClass: "dns-resolver" });
      continue;
    }
    if (provider && hp === provider) {
      classified.push({ flow, klass: "EXPECTED-BENIGN", allowClass: "model-provider" });
      continue;
    }
    if (decoy && hp === decoy) {
      classified.push({ flow, klass: "EXPECTED-BENIGN", allowClass: "decoy-endpoint" });
      continue;
    }
    if (authorisedDsts.has(hp)) {
      classified.push({ flow, klass: "MATCHED" });
      coveredDsts.add(hp);
      continue;
    }
    classified.push({ flow, klass: "OMITTED" });
  }
  const phantom = [];
  const phantomSeen = new Set();
  for (const keys of authRows) {
    if (keys.some((k) => coveredDsts.has(k))) continue;
    const primary = keys[0];
    if (primary === provider || primary === decoy || phantomSeen.has(primary)) continue;
    phantomSeen.add(primary);
    phantom.push(primary);
  }
  return {
    classified,
    matched: classified.filter((c) => c.klass === "MATCHED").map((c) => c.flow),
    expectedBenign: classified.filter((c) => c.klass === "EXPECTED-BENIGN"),
    omitted: classified.filter((c) => c.klass === "OMITTED").map((c) => c.flow),
    phantom
  };
}

/** witnessMerkleRoot push order: ascending (firstTs, dstHostOrIP, dstPort), ties by canonical
 * bytes (CONTRACT.md 2). */
async function witnessRoot(tuples) {
  const ordered = [...tuples].sort((a, b) => {
    if (a.firstTs !== b.firstTs) return a.firstTs < b.firstTs ? -1 : 1;
    if (a.dstHostOrIP !== b.dstHostOrIP) return a.dstHostOrIP < b.dstHostOrIP ? -1 : 1;
    if (a.dstPort !== b.dstPort) return a.dstPort - b.dstPort;
    const ca = canonicalJson(a);
    const cb = canonicalJson(b);
    return ca < cb ? -1 : ca > cb ? 1 : 0;
  });
  const leaves = [];
  for (const t of ordered) leaves.push(await leafHash(canonicalJson(t)));
  const rootHex = ordered.length === 0 ? toHex(await emptyRoot()) : toHex(await accumulatorRoot(leaves));
  return { rootHex, treeSize: ordered.length, ordered, leaves };
}

async function checkWitnessRoot(flows, claimedRoot, claimedTreeSize) {
  const wr = await witnessRoot(flows);
  if (wr.rootHex !== claimedRoot) {
    return { ok: false, recomputed: wr.rootHex, treeSize: wr.treeSize, inclusionOk: false, reason: "root mismatch" };
  }
  if (wr.treeSize !== claimedTreeSize) {
    return { ok: false, recomputed: wr.rootHex, treeSize: wr.treeSize, inclusionOk: false, reason: "treeSize mismatch" };
  }
  return { ok: true, recomputed: wr.rootHex, treeSize: wr.treeSize, inclusionOk: await proveAll(wr.leaves, wr.rootHex) };
}

async function checkRowsRoot(rows, claimedRoot, claimedTreeSize) {
  const leaves = [];
  for (const r of rows) leaves.push(await leafHash(canonicalJson(r)));
  const recomputed = rows.length === 0 ? toHex(await emptyRoot()) : toHex(await accumulatorRoot(leaves));
  if (recomputed !== claimedRoot) {
    return { ok: false, recomputed, treeSize: rows.length, inclusionOk: false, reason: "root mismatch" };
  }
  if (rows.length !== claimedTreeSize) {
    return { ok: false, recomputed, treeSize: rows.length, inclusionOk: false, reason: "treeSize mismatch" };
  }
  return { ok: true, recomputed, treeSize: rows.length, inclusionOk: await proveAll(leaves, recomputed) };
}

function nContinuityBreak(rows) {
  const ns = rows.map((r) => r.n).filter((n) => typeof n === "number");
  if (ns.length < 2) return "";
  for (let i = 1; i < ns.length; i++) {
    if (ns[i] <= ns[i - 1]) return `has a non-increasing decision index (n ${ns[i - 1]} ${ARROW} ${ns[i]})`;
    if (ns[i] !== ns[i - 1] + 1) return `has a gap in the decision index (n ${ns[i - 1]} ${ARROW} ${ns[i]}), a deleted row`;
  }
  return "";
}

async function checkCanary(canary, flows, canaryHitsRoot, claimedTreeSize, v, say) {
  if (canary.length === 0) {
    const empty = toHex(await emptyRoot());
    if (canaryHitsRoot && canaryHitsRoot !== empty) {
      v.broken.push("canaryHitsRoot is non-empty but the receipt carries no canary events");
    }
    return { shown: 0, root: empty };
  }
  const cr = await checkRowsRoot(canary, canaryHitsRoot, claimedTreeSize);
  if (!cr.ok) {
    v.broken.push(`canaryHitsRoot: ${cr.reason} (recomputed ${cr.recomputed.slice(0, 16)}${ELLIPSIS})`);
    return { shown: 0, root: cr.recomputed };
  }
  const witnessLeaves = new Set();
  for (const t of flows) witnessLeaves.add(toHex(await leafHash(canonicalJson(t))));
  let shown = 0;
  for (const e of canary) {
    const leaf = String(e.witnessFlowLeaf ?? "");
    if (!witnessLeaves.has(leaf)) {
      v.broken.push(`a canary event binds to witnessFlowLeaf ${leaf.slice(0, 16)}${ELLIPSIS} that is not a witnessed flow`);
      continue;
    }
    say(
      `CANARY-HIT  [${String(e.hitType)}] ${String(e.decoyRef)} at ${String(e.ts)} (detection latency ${Number(e.detectionLatencyMs)}ms; binds a witnessed flow, rides the same anchor)`
    );
    shown++;
  }
  return { shown, root: cr.recomputed };
}

/* --- offline Rekor --- */

/** The Rekor inclusion proof indexes with BigInt: the log is past 2^31 entries, so the node
 * verifier's 32-bit shifts would wrap. */
async function verifyRekorInclusion(leaf, index, treeSize, proof, root) {
  if (!Number.isInteger(index) || !Number.isInteger(treeSize)) return false;
  if (index < 0 || treeSize <= 0 || index >= treeSize) return false;
  const idx = BigInt(index);
  const last = BigInt(treeSize) - 1n;
  let bits = 0;
  for (let x = idx ^ last; x > 0n; x >>= 1n) bits++;
  let border = 0;
  for (let x = idx >> BigInt(bits); x > 0n; x >>= 1n) if (x & 1n) border++;
  if (proof.length !== bits + border) return false;
  let seed = leaf;
  for (let i = 0; i < bits; i++) {
    seed = ((idx >> BigInt(i)) & 1n) === 0n ? await sha256(NODE_PREFIX, seed, proof[i]) : await sha256(NODE_PREFIX, proof[i], seed);
  }
  for (let i = bits; i < proof.length; i++) seed = await sha256(NODE_PREFIX, proof[i], seed);
  return bytesEqual(seed, root);
}

function splitCheckpoint(text) {
  const at = text.indexOf(NOTE_SEPARATOR);
  if (at < 0) return null;
  const signed = text.slice(0, at + 1);
  const line = text.slice(at + 3).split("\n")[0].trim();
  const sp = line.indexOf(" ");
  if (sp < 0) return null;
  const blob = fromBase64(line.slice(sp + 1));
  if (blob.length < 8) return null;
  return { signed, name: line.slice(0, sp), hint: toHex(blob.subarray(0, 4)), sig: blob.subarray(4) };
}

async function verifyRekorEntryOffline(entry, pinnedPubPem, artifactSha256) {
  const v = { failures: [], unverifiable: [], integratedAt: "", logIndex: 0, treeSize: 0, pinSha256: "" };
  if (!pinnedPubPem) {
    v.unverifiable.push("the public-log anchor is present but the pinned Rekor key is not available here (rekor.pub)");
    return v;
  }
  const der = pemToDer(pinnedPubPem);
  let key = null;
  if (der) {
    try {
      key = await crypto.subtle.importKey("spki", der, { name: "ECDSA", namedCurve: "P-256" }, false, ["verify"]);
    } catch {
      key = null;
    }
  }
  if (!key) {
    v.unverifiable.push("the pinned Rekor key is not a valid public key");
    return v;
  }
  v.pinSha256 = await sha256Hex(pinnedPubPem);
  const logId = toHex(await sha256(der));
  if (logId !== entry.logID) {
    v.failures.push(
      `the pinned Rekor key does not match the entry's logID (pinned ${logId.slice(0, 16)}${ELLIPSIS}, entry ${String(entry.logID).slice(0, 16)}${ELLIPSIS})`
    );
    return v;
  }
  const setBody = canonicalJson({
    body: entry.body,
    integratedTime: entry.integratedTime,
    logID: entry.logID,
    logIndex: entry.logIndex
  });
  const setOk = await verifyEcdsaSha256(key, utf8(setBody), fromBase64(entry.verification.signedEntryTimestamp));
  if (!setOk) v.failures.push("the Rekor signed entry timestamp does not verify under the pinned log key");
  const ip = entry.verification.inclusionProof;
  const cp = splitCheckpoint(String(ip.checkpoint ?? ""));
  if (!cp) {
    v.failures.push("the Rekor checkpoint is not a signed note");
    return v;
  }
  const cpOk = await verifyEcdsaSha256(key, utf8(cp.signed), cp.sig);
  if (!cpOk) v.failures.push("the Rekor checkpoint signature does not verify under the pinned log key");
  if (cp.hint !== String(entry.logID).slice(0, 8)) v.failures.push("the Rekor checkpoint key hint is not this log's");
  const lines = cp.signed.split("\n");
  const cpSize = Number(lines[1]);
  const cpRoot = toHex(fromBase64(lines[2] ?? ""));
  if (cpSize !== ip.treeSize) v.failures.push(`the checkpoint's tree size ${cpSize} is not the proof's ${ip.treeSize}`);
  if (cpRoot !== ip.rootHash) v.failures.push("the checkpoint's root is not the root the inclusion proof reaches");
  const leaf = await sha256(LEAF_PREFIX, fromBase64(entry.body));
  const incOk = await verifyRekorInclusion(
    leaf,
    ip.logIndex,
    ip.treeSize,
    (ip.hashes ?? []).map((h) => fromHex(h)),
    fromHex(String(ip.rootHash ?? ""))
  );
  if (!incOk) v.failures.push("the Rekor inclusion proof does not reach the signed checkpoint root");
  let logged;
  try {
    logged = JSON.parse(fromUtf8(fromBase64(entry.body)));
  } catch {
    v.failures.push("the Rekor entry body is not JSON");
    return v;
  }
  const hash = logged.spec?.data?.hash;
  if (logged.kind !== "hashedrekord" || hash?.algorithm !== "sha256") {
    v.failures.push(`the Rekor entry is a ${String(logged.kind)}, not the sha256 hashedrekord this anchor publishes`);
  } else if (hash.value !== artifactSha256) {
    v.failures.push(
      `the Rekor entry commits ${String(hash.value).slice(0, 16)}${ELLIPSIS}, not this run's checkpoint ${artifactSha256.slice(0, 16)}${ELLIPSIS}`
    );
  }
  v.integratedAt = new Date(entry.integratedTime * 1000).toISOString();
  v.logIndex = entry.logIndex;
  v.treeSize = ip.treeSize;
  return v;
}

/* --- anchor --- */

async function checkAnchor(predicate, trustDer, journalKey, witnessMerkleRoot, rekorPubPem, v, say) {
  const anchor = predicate.externalAnchor ?? null;
  const type = String(anchor?.type ?? "");
  const stop = (msg, readBack, details = {}) => {
    v.unverified.push(msg);
    return { type, readBack, details };
  };
  if (!anchor || !anchor.submission) return stop("no external anchor in the receipt", "no-anchor");
  const s = anchor.submission;
  const subDer = s.publicKey ? derHexOf(s.publicKey) : null;
  if (!subDer || subDer !== trustDer) {
    return stop("the external anchor is vouched by a key other than the out-of-band trust root", "foreign-key");
  }
  if (!(await verifyEd25519(journalKey, utf8(String(s.body ?? "")), fromBase64(String(s.signature ?? ""))))) {
    return stop("the external anchor signature does not verify under the out-of-band trust root", "bad-signature");
  }
  let bodyRoot = "";
  try {
    bodyRoot = String(JSON.parse(String(s.body ?? "{}")).merkleRoot ?? "");
  } catch {
    bodyRoot = "";
  }
  if (bodyRoot !== witnessMerkleRoot) {
    v.broken.push("the external anchor commits a different witness root than the receipt claims");
    return { type, readBack: "root-mismatch", details: { anchoredRoot: bodyRoot } };
  }

  const note = {
    commit: String(anchor.receipt?.commit ?? ""), notesRef: String(anchor.receipt?.notesRef ?? ""),
    anchoredWitnessRoot: bodyRoot, submissionTs: String(s.ts ?? ""), submissionTreeSize: Number(s.treeSize ?? 0)
  };

  let readBack = 0;
  let outcome = "not-in-browser";
  const brokenBefore = v.broken.length;
  const logEntry = anchor.receipt?.entry;
  let rekorDetails = null;
  if (logEntry) {
    const bodyDigest = await sha256Hex(String(anchor.submission?.body ?? ""));
    const artifact = String(anchor.receipt?.artifactSha256 ?? bodyDigest);
    if (artifact !== bodyDigest) {
      v.broken.push("the public-log anchor names a digest that is not this receipt's checkpoint body");
      outcome = "rekor-failed";
    } else {
      const r = await verifyRekorEntryOffline(logEntry, rekorPubPem, artifact);
      for (const f of r.failures) v.broken.push(`public log: ${f}`);
      for (const u of r.unverifiable) v.unverified.push(`public log: ${u}`);
      if (r.failures.length === 0 && r.unverifiable.length === 0) {
        readBack++;
        outcome = "rekor-verified";
        rekorDetails = {
          uuid: String(anchor.receipt?.uuid ?? ""), url: String(anchor.receipt?.url ?? ""), logIndex: r.logIndex,
          integratedAt: r.integratedAt, treeSize: r.treeSize, pinnedRekorPubSha256: r.pinSha256
        };
        say(
          `anchor      ${anchor.type}: read back from the PUBLIC log - entry ${String(anchor.receipt?.uuid ?? "").slice(0, 16)}${ELLIPSIS} at logIndex ${r.logIndex}, timestamped ${r.integratedAt} by the log's own key`
        );
        say(
          `            inclusion proof to a signed tree head of ${r.treeSize} entries; pinned rekor.pub sha256 ${r.pinSha256.slice(0, 32)}${ELLIPSIS}`
        );
        if (anchor.receipt?.url) say(`            cross-check online at ${anchor.receipt.url}`);
      } else {
        outcome = r.failures.length ? "rekor-failed" : "rekor-unverifiable";
      }
    }
  }

  // The git-note read-back the node verifier does here needs a git repository, so it cannot run
  // in a browser. Falling through leaves the same state `--no-anchor` leaves: nothing read back.
  if (readBack === 0 && v.broken.length === brokenBefore) {
    v.unverified.push(
      "external anchor not read back here; submission is self-signed only - the anchor is vouched by the same key that signed the receipt, so nothing outside the lab has confirmed this witness head (re-run with --anchor-repo <dir>, or use a receipt carrying a public-log entry)"
    );
    say(`anchor      ${anchor.type}: submission signed by the out-of-band key and commits witnessMerkleRoot - NOT read back`);
  }
  const gitNote = "cannot be read back in a browser; run judge-kit/verify.mjs against the anchor repository to close this leg";
  return { type, readBack: outcome, details: rekorDetails ? { ...note, rekor: rekorDetails } : { ...note, gitNote } };
}

/* --- result --- */

const verdictCode = (v) => (v.broken.length ? 1 : v.unverified.length ? 2 : 0);

function finish(v, out, extra) {
  const code = verdictCode(v);
  const lines = [...out];
  for (const n of v.notes) lines.push(`note        ${n}`);
  for (const b of v.broken) lines.push(`  BROKEN: ${b}`);
  for (const u of v.unverified) lines.push(`  UNVERIFIED: ${u}`);
  const verdict =
    code === 0
      ? "OK - witness and enforcement log reconcile; 0 omitted; signature, roots and anchor verified"
      : code === 1
        ? "BROKEN - a check ran and failed"
        : "UNVERIFIED - a check could not run here, so this run proves less than a pass";
  lines.push(`result      ${verdict}  (exit ${code})`);
  return {
    exitCode: code,
    verdict: code === 0 ? "OK" : code === 1 ? "BROKEN" : "UNVERIFIED",
    verdictLine: verdict,
    lines,
    broken: [...v.broken],
    unverified: [...v.unverified],
    notes: [...v.notes],
    signatureOk: false,
    witnessRoot: "", enforcementRoot: "", canaryRoot: "",
    reconcile: { matched: 0, expectedBenign: 0, expectedBenignDetail: [], omitted: [], omittedDetail: [], phantom: [] },
    anchor: { type: "", readBack: "no-anchor", details: {} },
    runId: "", claimedWitnessRoot: "", claimedEnforcementRoot: "", claimedCanaryRoot: "",
    treeSizes: {}, canaryHits: 0,
    ...extra
  };
}

export async function verifyReceipt(receipt, options = {}) {
  const journalPubPem = options.journalPubPem ?? null;
  const rekorPubPem = options.rekorPubPem ?? null;
  const trustRootLabel = options.trustRootLabel ?? "journal.pub";
  const v = { broken: [], unverified: [], notes: [] };
  const out = [];
  const say = (s) => out.push(s);

  const bail = (msg) => {
    v.unverified.push(msg);
    return finish(v, out, {});
  };
  if (!receipt || typeof receipt !== "object") return bail("receipt is not a DSSE envelope object");
  if (journalPubPem === null) return bail(`trust root ${trustRootLabel} not available out of band`);
  const trustDer = derHexOf(journalPubPem);
  const journalKey = await importEd25519(journalPubPem);
  if (!trustDer || !journalKey) return bail("trust root is not a valid public key");
  say(`trust root  ${trustRootLabel}`);
  say(`            journal.pub sha256 ${await sha256Hex(journalPubPem)}`);

  const ver = await verifyEnvelope(receipt, journalKey);
  if (!ver.ok) {
    v.broken.push(`DSSE signature: ${ver.reason}`);
    return finish(v, out, { signatureOk: false });
  }
  const statement = ver.statement ?? {};
  const predicate = statement.predicate ?? {};
  if (statement._type !== IN_TOTO_STATEMENT) v.broken.push(`statement _type is ${statement._type}`);
  if (statement.predicateType !== PREDICATE_TYPE) v.broken.push(`predicateType is ${statement.predicateType}`);
  const claimedDigest = statement.subject?.[0]?.digest?.sha256 ?? "";
  const predicateDigest = await sha256Hex(canonicalJson(predicate));
  if (claimedDigest !== predicateDigest) v.broken.push("subject digest does not match canonicalJson(predicate)");

  const runId = String(predicate.runId ?? "");
  const claimedWitnessRoot = String(predicate.witnessMerkleRoot ?? "");
  const claimedEnforcementRoot = String(predicate.enforcementLogMerkleRoot ?? "");
  const claimedCanaryRoot = String(predicate.canaryHitsRoot ?? "");
  const treeSizes = predicate.treeSizes ?? {};
  say(`run         ${runId}`);

  const evidence = predicate.evidence ?? null;
  const flows = evidence?.flows ?? null;
  const enforcement = evidence?.enforcement ?? null;
  const canary = evidence?.canary ?? [];
  // No sibling flows.jsonl / egress.jsonl in a browser: the receipt embeds its evidence or not.
  if (flows === null) v.unverified.push("witness flows absent (not embedded in the receipt)");
  if (enforcement === null) v.unverified.push("enforcement log absent (not embedded in the receipt)");

  const anchor = await checkAnchor(predicate, trustDer, journalKey, claimedWitnessRoot, rekorPubPem, v, say);

  let witnessRootHex = "";
  if (flows) {
    const wr = await checkWitnessRoot(flows, claimedWitnessRoot, treeSizes.witness ?? flows.length);
    witnessRootHex = wr.recomputed;
    if (!wr.ok) v.broken.push(`witness root: ${wr.reason} (recomputed ${wr.recomputed.slice(0, 16)}${ELLIPSIS})`);
    else if (!wr.inclusionOk) v.broken.push("witness root: an RFC-9162 inclusion proof failed");
    else say(`witness     root ${claimedWitnessRoot.slice(0, 16)}${ELLIPSIS} over ${wr.treeSize} flow(s), inclusion proofs OK`);
  }
  let enforcementRootHex = "";
  if (enforcement) {
    const er = await checkRowsRoot(enforcement, claimedEnforcementRoot, treeSizes.enforcement ?? enforcement.length);
    enforcementRootHex = er.recomputed;
    if (!er.ok) v.broken.push(`enforcement root: ${er.reason} (recomputed ${er.recomputed.slice(0, 16)}${ELLIPSIS})`);
    else say(`enforcement root ${claimedEnforcementRoot.slice(0, 16)}${ELLIPSIS} over ${er.treeSize} row(s), inclusion proofs OK`);
    const gap = nContinuityBreak(enforcement);
    if (gap) v.broken.push(`enforcement log ${gap}`);
  }

  const canaryResult = await checkCanary(canary, flows ?? [], claimedCanaryRoot, treeSizes.canary ?? canary.length, v, say);

  let rec = null;
  if (flows && enforcement) {
    const provider = String(predicate.reconcileContext?.providerHostPort ?? "");
    const decoy = String(predicate.reconcileContext?.decoyHostPort ?? "");
    if (!provider && !decoy) {
      v.notes.push("no reconcileContext in receipt; only dns:53 is treated benign (model-provider/decoy unknown)");
    }
    rec = reconcile(flows, enforcement, { providerHostPort: provider, decoyHostPort: decoy });
    say(
      `reconcile   ${rec.matched.length} matched, ${rec.expectedBenign.length} expected-benign (${rec.expectedBenign.map((c) => c.allowClass).join(",") || "none"}), ${rec.omitted.length} omitted, ${rec.phantom.length} phantom`
    );
    for (const c of rec.expectedBenign) {
      say(`  EXPECTED-BENIGN [${c.allowClass}] ${c.flow.proto} ${c.flow.dstHostOrIP}:${c.flow.dstPort}`);
    }
    for (const dst of rec.phantom) say(`  PHANTOM ${dst}  (enforcement claims a flow the witness never saw)`);
    if (rec.omitted.length) {
      for (const t of rec.omitted) {
        say(
          `  OMITTED: ${t.proto} ${t.dstHostOrIP}:${t.dstPort}  (witness saw ${t.bytesOut}B out / ${t.bytesIn}B in; enforcement log does not account for it)`
        );
      }
      v.broken.push(`witness saw ${rec.omitted.length} egress the enforcement log omitted`);
    }
  }

  return finish(v, out, {
    signatureOk: true,
    witnessRoot: witnessRootHex,
    enforcementRoot: enforcementRootHex,
    canaryRoot: canaryResult.root,
    reconcile: {
      matched: rec ? rec.matched.length : 0,
      expectedBenign: rec ? rec.expectedBenign.length : 0,
      expectedBenignDetail: rec ? rec.expectedBenign.map((c) => ({ allowClass: c.allowClass, dst: `${c.flow.dstHostOrIP}:${c.flow.dstPort}` })) : [],
      omitted: rec ? rec.omitted.map((t) => `${t.proto} ${t.dstHostOrIP}:${t.dstPort}`) : [],
      omittedDetail: rec ? rec.omitted.map((t) => ({ proto: t.proto, dstHostOrIP: t.dstHostOrIP, dstPort: t.dstPort, bytesOut: t.bytesOut, bytesIn: t.bytesIn })) : [],
      phantom: rec ? [...rec.phantom] : []
    },
    anchor, runId, claimedWitnessRoot, claimedEnforcementRoot, claimedCanaryRoot, treeSizes,
    canaryHits: canary.length
  });
}

/* --- the live tamper --- */

export async function hideEnforcementRow(receipt, n) {
  const statement = statementOf(receipt);
  if (!statement || !statement.predicate) throw new Error("receipt payload is not an in-toto statement");
  const predicate = statement.predicate;
  const rows = predicate.evidence?.enforcement;
  if (!Array.isArray(rows)) throw new Error("receipt carries no embedded enforcement log to edit");
  const index = rows.findIndex((r) => Number(r?.n) === Number(n));
  if (index < 0) throw new Error(`no enforcement row with decision index n=${n}`);

  const kept = rows.filter((_, i) => i !== index);
  const leaves = [];
  for (const row of kept) leaves.push(await leafHash(canonicalJson(row)));
  const rootHex = kept.length === 0 ? toHex(await emptyRoot()) : toHex(await accumulatorRoot(leaves));

  // A throwaway key stands in for the lab's, which is not in the browser and must never be: it
  // signs the payload AND vouches the anchor submission, exactly as a real lab's own key does.
  const pair = await crypto.subtle.generateKey({ name: "Ed25519" }, true, ["sign", "verify"]);
  const labPublicKeyPem = derToPem(new Uint8Array(await crypto.subtle.exportKey("spki", pair.publicKey)));
  const sign = async (bytes) => toBase64(new Uint8Array(await crypto.subtle.sign({ name: "Ed25519" }, pair.privateKey, bytes)));
  const anchor = predicate.externalAnchor;
  const reSigned = anchor?.submission
    ? { ...anchor, submission: { ...anchor.submission, publicKey: labPublicKeyPem, signature: await sign(utf8(String(anchor.submission.body ?? ""))) } }
    : anchor;

  // Exactly the fields the lie touches: the shortened log, its root, its tree size. The witness
  // evidence, its root, the canary tree, the checkpoint body and producedAt are carried over.
  const tamperedPredicate = {
    ...predicate,
    enforcementLogMerkleRoot: rootHex,
    treeSizes: { ...(predicate.treeSizes ?? {}), enforcement: kept.length },
    evidence: { ...predicate.evidence, enforcement: kept },
    ...(reSigned ? { externalAnchor: reSigned } : {})
  };
  const tamperedStatement = {
    _type: statement._type,
    subject: [
      {
        name: String(statement.subject?.[0]?.name ?? `run/${String(predicate.runId ?? "")}`),
        digest: { sha256: await sha256Hex(canonicalJson(tamperedPredicate)) }
      }
    ],
    predicateType: statement.predicateType,
    predicate: tamperedPredicate
  };

  const payload = toBase64(utf8(canonicalJson(tamperedStatement)));
  const envelope = {
    payloadType: PAYLOAD_TYPE,
    payload,
    signatures: [{ keyid: await sha256Hex(labPublicKeyPem), sig: await sign(pae(PAYLOAD_TYPE, payload)) }]
  };
  // Non-enumerable, so JSON.stringify(envelope) still emits a clean three-field DSSE envelope.
  Object.defineProperty(envelope, "labPublicKeyPem", { value: labPublicKeyPem, enumerable: false });
  Object.defineProperty(envelope, "hiddenRow", { value: rows[index], enumerable: false });
  return envelope;
}
