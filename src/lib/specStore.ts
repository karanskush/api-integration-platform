// Raw spec snapshots in Vercel Blob (TECH_IMPLEMENTATION.md §2: "Object
// storage — Vercel Blob, spec snapshots versioned by content hash").
//
// spec_versions.blobRef has existed since Phase 1 and was always null, which
// left the platform storing a *derived* model of every spec and never the bytes
// it came from. That is a real gap, not a cosmetic one:
//
//   * doc-drift diffing and re-normalization after a parser improvement both
//     need the original document, not the IR we distilled from it;
//   * "reverted" in reimportApi() can only restore a version whose action rows
//     survive — with the raw bytes, any past version can be re-derived;
//   * a provider disputing a score has a right to see exactly what was graded.
//
// Content-hash addressing makes writes idempotent: the same spec always lands on
// the same path, so re-importing an unchanged spec overwrites itself with
// identical content rather than accumulating copies.
//
// PRIVATE access, deliberately. A public blob URL is world-readable forever to
// anyone who learns it, and private APIs (visibility.ts) must not have their
// spec sitting behind a guessable public URL. Reads go through get(), which
// authenticates with the store token.

import { get, put } from '@vercel/blob';

const PREFIX = 'specs';

export function blobReady(): boolean {
  return Boolean(process.env.BLOB_READ_WRITE_TOKEN);
}

// Content hash is the whole path. It is already a sha256 hex digest computed by
// persist.ts, so it needs no sanitizing — but validate the shape anyway rather
// than interpolating an unchecked value into a storage path (path traversal
// through a blob key is cheap to prevent and expensive to discover).
const SHA256_HEX = /^[0-9a-f]{64}$/;

function pathFor(contentHash: string): string {
  return `${PREFIX}/${contentHash}.txt`;
}

export type SnapshotResult = { blobRef: string } | null;

// Returns the pathname to store in spec_versions.blob_ref, or null when Blob
// isn't configured — the same "degrade cleanly, don't crash" contract every
// other optional integration here follows. A missing snapshot costs future
// re-derivation, never the current import.
export async function putSpecSnapshot(contentHash: string, rawText: string): Promise<SnapshotResult> {
  if (!blobReady()) return null;
  // A malformed hash is a caller bug, not a transient outage — log it as its
  // own thing rather than letting it land in the catch below and read like the
  // blob store is down.
  if (!SHA256_HEX.test(contentHash)) {
    console.error('[specStore] refusing a non-sha256 snapshot path');
    return null;
  }
  try {
    const result = await put(pathFor(contentHash), rawText, {
      access: 'private',
      contentType: 'text/plain; charset=utf-8',
      addRandomSuffix: false,
      // Same hash means byte-identical content, so an overwrite is a no-op in
      // substance. Without this, a re-import of an unchanged spec would throw.
      allowOverwrite: true,
      // Specs are immutable at a given hash — cache hard.
      cacheControlMaxAge: 31_536_000,
    });
    return { blobRef: result.pathname };
  } catch (err) {
    // Never fail an import because the snapshot could not be written.
    console.error('[specStore] snapshot write failed', {
      contentHash: contentHash.slice(0, 12),
      reason: err instanceof Error ? err.name : 'unknown',
    });
    return null;
  }
}

const MAX_SNAPSHOT_BYTES = 5 * 1024 * 1024;

// Shared bounded-read: any blob this module writes is capped and private, so
// reading it back is identical work regardless of which kind it is.
async function readPrivateBlob(blobRef: string, maxBytes: number, logLabel: string): Promise<string | null> {
  if (!blobReady() || !blobRef) return null;
  try {
    // access must match how it was written, or the SDK resolves the wrong URL.
    const result = await get(blobRef, { access: 'private' });
    if (!result || result.statusCode !== 200) return null;

    const reader = result.stream.getReader();
    const chunks: Uint8Array[] = [];
    let total = 0;
    for (;;) {
      const { done, value } = await reader.read();
      if (done) break;
      total += value.byteLength;
      if (total > maxBytes) {
        await reader.cancel().catch(() => {});
        return null;
      }
      chunks.push(value);
    }
    const body = new Uint8Array(total);
    let offset = 0;
    for (const chunk of chunks) {
      body.set(chunk, offset);
      offset += chunk.byteLength;
    }
    return new TextDecoder().decode(body);
  } catch (err) {
    console.error(`[specStore] ${logLabel} read failed`, { reason: err instanceof Error ? err.name : 'unknown' });
    return null;
  }
}

export async function getSpecSnapshot(blobRef: string): Promise<string | null> {
  return readPrivateBlob(blobRef, MAX_SNAPSHOT_BYTES, 'snapshot');
}

// The deep-analysis pipeline's portable artifacts (Arazzo workflow doc,
// enriched OpenAPI) — same access model as the raw spec snapshot above and
// for the same reason: a private API's derived artifacts must not sit behind
// a guessable public URL just because the artifact itself is "just" a
// derived summary. Keyed by spec_version_id (not content hash) since these
// are regenerated whenever a clarification answer changes the picture, not
// only when the spec bytes themselves change.
const ARTIFACT_PREFIX = 'artifacts';
const MAX_ARTIFACT_BYTES = 5 * 1024 * 1024;

function artifactPathFor(specVersionId: string, kind: 'arazzo' | 'enriched', extension: string): string {
  return `${ARTIFACT_PREFIX}/${kind}/${specVersionId}.${extension}`;
}

async function putArtifact(
  path: string,
  text: string,
  contentType: string,
  logLabel: string,
): Promise<SnapshotResult> {
  if (!blobReady()) return null;
  try {
    const result = await put(path, text, {
      access: 'private',
      contentType,
      addRandomSuffix: false,
      allowOverwrite: true, // regenerated in place whenever the picture changes
    });
    return { blobRef: result.pathname };
  } catch (err) {
    console.error(`[specStore] ${logLabel} write failed`, { reason: err instanceof Error ? err.name : 'unknown' });
    return null;
  }
}

export async function putArazzoArtifact(specVersionId: string, yamlText: string): Promise<SnapshotResult> {
  return putArtifact(artifactPathFor(specVersionId, 'arazzo', 'yaml'), yamlText, 'application/yaml; charset=utf-8', 'arazzo artifact');
}

export async function putEnrichedSpecArtifact(specVersionId: string, jsonText: string): Promise<SnapshotResult> {
  return putArtifact(
    artifactPathFor(specVersionId, 'enriched', 'json'),
    jsonText,
    'application/json; charset=utf-8',
    'enriched-spec artifact',
  );
}

export async function getArtifactText(blobRef: string): Promise<string | null> {
  return readPrivateBlob(blobRef, MAX_ARTIFACT_BYTES, 'artifact');
}
