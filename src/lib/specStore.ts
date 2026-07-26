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

export async function getSpecSnapshot(blobRef: string): Promise<string | null> {
  if (!blobReady() || !blobRef) return null;
  try {
    // access must match how it was written, or the SDK resolves the wrong URL.
    const result = await get(blobRef, { access: 'private' });
    if (!result || result.statusCode !== 200) return null;

    // Bounded read: a snapshot larger than the import limit means something is
    // wrong, and streaming it into memory unbounded would be the bug.
    const reader = result.stream.getReader();
    const chunks: Uint8Array[] = [];
    let total = 0;
    for (;;) {
      const { done, value } = await reader.read();
      if (done) break;
      total += value.byteLength;
      if (total > MAX_SNAPSHOT_BYTES) {
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
    console.error('[specStore] snapshot read failed', { reason: err instanceof Error ? err.name : 'unknown' });
    return null;
  }
}
