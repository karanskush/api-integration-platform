// specStore talks to Vercel Blob, so these tests cover the parts that must be
// right regardless of the network: the not-configured contract, the
// content-hash path validation, and never throwing into an import.

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const ENV = 'BLOB_READ_WRITE_TOKEN';
const original = process.env[ENV];

const HASH = 'a'.repeat(64);

afterEach(() => {
  vi.resetModules();
  vi.restoreAllMocks();
  if (original === undefined) delete process.env[ENV];
  else process.env[ENV] = original;
});

beforeEach(() => {
  delete process.env[ENV];
});

async function loadStore(blobMock?: Record<string, unknown>) {
  vi.resetModules();
  if (blobMock) vi.doMock('@vercel/blob', () => blobMock);
  return import('../specStore');
}

describe('blobReady', () => {
  it('is false without a token and true with one', async () => {
    const { blobReady } = await loadStore();
    expect(blobReady()).toBe(false);
    process.env[ENV] = 'vercel_blob_rw_token';
    expect(blobReady()).toBe(true);
  });
});

describe('putSpecSnapshot', () => {
  it('returns null when Blob is not configured, rather than throwing', async () => {
    const put = vi.fn();
    const { putSpecSnapshot } = await loadStore({ put, get: vi.fn() });
    await expect(putSpecSnapshot(HASH, '{"openapi":"3.0.0"}')).resolves.toBeNull();
    // Not configured means not attempted.
    expect(put).not.toHaveBeenCalled();
  });

  it('writes to a content-hash path with private access and returns the pathname', async () => {
    process.env[ENV] = 'token';
    const put = vi.fn().mockResolvedValue({ pathname: `specs/${HASH}.txt` });
    const { putSpecSnapshot } = await loadStore({ put, get: vi.fn() });

    await expect(putSpecSnapshot(HASH, 'spec-bytes')).resolves.toEqual({ blobRef: `specs/${HASH}.txt` });

    expect(put).toHaveBeenCalledWith(
      `specs/${HASH}.txt`,
      'spec-bytes',
      expect.objectContaining({
        // A public URL is world-readable forever to anyone who learns it, and a
        // private API's spec must not sit behind a guessable public URL.
        access: 'private',
        addRandomSuffix: false,
        // Same hash means byte-identical content, so overwriting is a no-op in
        // substance — without this a re-import of an unchanged spec throws.
        allowOverwrite: true,
      }),
    );
  });

  it('rejects a path that is not a sha256 digest', async () => {
    process.env[ENV] = 'token';
    const put = vi.fn();
    const { putSpecSnapshot } = await loadStore({ put, get: vi.fn() });

    for (const bad of ['../../etc/passwd', 'short', `${HASH}/../evil`, 'A'.repeat(64), '']) {
      await expect(putSpecSnapshot(bad, 'x')).resolves.toBeNull();
    }
    expect(put).not.toHaveBeenCalled();
  });

  // A snapshot is strictly additive: losing it costs future re-derivation, never
  // the import in flight.
  it('swallows a Blob failure and returns null', async () => {
    process.env[ENV] = 'token';
    const put = vi.fn().mockRejectedValue(new Error('blob store unavailable'));
    const { putSpecSnapshot } = await loadStore({ put, get: vi.fn() });
    await expect(putSpecSnapshot(HASH, 'x')).resolves.toBeNull();
  });
});

describe('getSpecSnapshot', () => {
  function streamOf(text: string) {
    const bytes = new TextEncoder().encode(text);
    return new ReadableStream<Uint8Array>({
      start(controller) {
        controller.enqueue(bytes);
        controller.close();
      },
    });
  }

  it('returns null when Blob is not configured or the ref is empty', async () => {
    const { getSpecSnapshot } = await loadStore({ put: vi.fn(), get: vi.fn() });
    await expect(getSpecSnapshot(`specs/${HASH}.txt`)).resolves.toBeNull();

    process.env[ENV] = 'token';
    const store = await loadStore({ put: vi.fn(), get: vi.fn() });
    await expect(store.getSpecSnapshot('')).resolves.toBeNull();
  });

  it('reads the stored text back', async () => {
    process.env[ENV] = 'token';
    const get = vi.fn().mockResolvedValue({ statusCode: 200, stream: streamOf('{"openapi":"3.1.0"}') });
    const { getSpecSnapshot } = await loadStore({ put: vi.fn(), get });

    await expect(getSpecSnapshot(`specs/${HASH}.txt`)).resolves.toBe('{"openapi":"3.1.0"}');
    // Must match how it was written or the SDK resolves the wrong URL.
    expect(get).toHaveBeenCalledWith(`specs/${HASH}.txt`, { access: 'private' });
  });

  it('returns null for a missing blob or a 304', async () => {
    process.env[ENV] = 'token';
    for (const value of [null, { statusCode: 304, stream: null }]) {
      const { getSpecSnapshot } = await loadStore({ put: vi.fn(), get: vi.fn().mockResolvedValue(value) });
      await expect(getSpecSnapshot(`specs/${HASH}.txt`)).resolves.toBeNull();
    }
  });

  it('refuses to buffer a snapshot larger than the import limit', async () => {
    process.env[ENV] = 'token';
    const oversized = new ReadableStream<Uint8Array>({
      start(controller) {
        // 6MB in 1MB chunks, past the 5MB cap.
        for (let i = 0; i < 6; i++) controller.enqueue(new Uint8Array(1024 * 1024));
        controller.close();
      },
    });
    const get = vi.fn().mockResolvedValue({ statusCode: 200, stream: oversized });
    const { getSpecSnapshot } = await loadStore({ put: vi.fn(), get });
    await expect(getSpecSnapshot(`specs/${HASH}.txt`)).resolves.toBeNull();
  });

  it('returns null rather than throwing when the read fails', async () => {
    process.env[ENV] = 'token';
    const get = vi.fn().mockRejectedValue(new Error('network'));
    const { getSpecSnapshot } = await loadStore({ put: vi.fn(), get });
    await expect(getSpecSnapshot(`specs/${HASH}.txt`)).resolves.toBeNull();
  });
});

const SPEC_VERSION_ID = 'a1b2c3d4-0000-4000-8000-000000000000';

describe('putArazzoArtifact / putEnrichedSpecArtifact', () => {
  it('return null when Blob is not configured, rather than throwing', async () => {
    const put = vi.fn();
    const { putArazzoArtifact, putEnrichedSpecArtifact } = await loadStore({ put, get: vi.fn() });
    await expect(putArazzoArtifact(SPEC_VERSION_ID, 'arazzo: 1.0.1')).resolves.toBeNull();
    await expect(putEnrichedSpecArtifact(SPEC_VERSION_ID, '{}')).resolves.toBeNull();
    expect(put).not.toHaveBeenCalled();
  });

  it('write each to its own kind-prefixed path, keyed by spec version id, with private overwrite-in-place access', async () => {
    process.env[ENV] = 'token';
    const put = vi.fn().mockResolvedValue({ pathname: 'irrelevant' });
    const { putArazzoArtifact, putEnrichedSpecArtifact } = await loadStore({ put, get: vi.fn() });

    await putArazzoArtifact(SPEC_VERSION_ID, 'arazzo: 1.0.1');
    expect(put).toHaveBeenCalledWith(
      `artifacts/arazzo/${SPEC_VERSION_ID}.yaml`,
      'arazzo: 1.0.1',
      expect.objectContaining({ access: 'private', addRandomSuffix: false, allowOverwrite: true, contentType: 'application/yaml; charset=utf-8' }),
    );

    await putEnrichedSpecArtifact(SPEC_VERSION_ID, '{"openapi":"3.1.0"}');
    expect(put).toHaveBeenCalledWith(
      `artifacts/enriched/${SPEC_VERSION_ID}.json`,
      '{"openapi":"3.1.0"}',
      expect.objectContaining({ access: 'private', addRandomSuffix: false, allowOverwrite: true, contentType: 'application/json; charset=utf-8' }),
    );
  });

  it('swallow a Blob failure and return null rather than throwing', async () => {
    process.env[ENV] = 'token';
    const put = vi.fn().mockRejectedValue(new Error('blob store unavailable'));
    const { putArazzoArtifact } = await loadStore({ put, get: vi.fn() });
    await expect(putArazzoArtifact(SPEC_VERSION_ID, 'x')).resolves.toBeNull();
  });
});

describe('getArtifactText', () => {
  function streamOf(text: string) {
    const bytes = new TextEncoder().encode(text);
    return new ReadableStream<Uint8Array>({
      start(controller) {
        controller.enqueue(bytes);
        controller.close();
      },
    });
  }

  it('reads an artifact back the same way a spec snapshot is read', async () => {
    process.env[ENV] = 'token';
    const get = vi.fn().mockResolvedValue({ statusCode: 200, stream: streamOf('arazzo: 1.0.1') });
    const { getArtifactText } = await loadStore({ put: vi.fn(), get });

    await expect(getArtifactText(`artifacts/arazzo/${SPEC_VERSION_ID}.yaml`)).resolves.toBe('arazzo: 1.0.1');
    expect(get).toHaveBeenCalledWith(`artifacts/arazzo/${SPEC_VERSION_ID}.yaml`, { access: 'private' });
  });

  it('returns null when Blob is not configured or the ref is empty', async () => {
    const { getArtifactText } = await loadStore({ put: vi.fn(), get: vi.fn() });
    await expect(getArtifactText(`artifacts/arazzo/${SPEC_VERSION_ID}.yaml`)).resolves.toBeNull();

    process.env[ENV] = 'token';
    const store = await loadStore({ put: vi.fn(), get: vi.fn() });
    await expect(store.getArtifactText('')).resolves.toBeNull();
  });

  it('returns null rather than throwing when the read fails', async () => {
    process.env[ENV] = 'token';
    const get = vi.fn().mockRejectedValue(new Error('network'));
    const { getArtifactText } = await loadStore({ put: vi.fn(), get });
    await expect(getArtifactText(`artifacts/enriched/${SPEC_VERSION_ID}.json`)).resolves.toBeNull();
  });
});
