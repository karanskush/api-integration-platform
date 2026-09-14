import { describe, expect, it } from 'vitest';
import { parseEvidencePayload } from '../evidence';

describe('parseEvidencePayload', () => {
  describe('probe.auth_reject', () => {
    it('parses a valid payload', () => {
      const result = parseEvidencePayload('probe.auth_reject', {
        statusObserved: 401,
        expectedAuth: 'bearer',
      });
      expect(result).toEqual({ statusObserved: 401, expectedAuth: 'bearer' });
    });

    it('rejects a payload missing required fields', () => {
      const result = parseEvidencePayload('probe.auth_reject', { statusObserved: 401 });
      expect(result).toBeNull();
    });
  });

  describe('probe.error_quality', () => {
    it('parses a valid payload, including the optional snippet', () => {
      const result = parseEvidencePayload('probe.error_quality', {
        actionId: 'a1',
        sampleStatus: 500,
        hasReadableMessage: false,
        snippet: '<html>Internal Server Error</html>',
      });
      expect(result).toEqual({
        actionId: 'a1',
        sampleStatus: 500,
        hasReadableMessage: false,
        snippet: '<html>Internal Server Error</html>',
      });
    });

    it('parses a valid payload without the optional snippet', () => {
      const result = parseEvidencePayload('probe.error_quality', {
        actionId: 'a1',
        sampleStatus: 400,
        hasReadableMessage: true,
      });
      expect(result).not.toBeNull();
    });

    it('rejects a payload with the wrong type for hasReadableMessage', () => {
      const result = parseEvidencePayload('probe.error_quality', {
        actionId: 'a1',
        sampleStatus: 400,
        hasReadableMessage: 'yes',
      });
      expect(result).toBeNull();
    });
  });

  describe('probe.doc_drift', () => {
    it('parses a valid payload', () => {
      const result = parseEvidencePayload('probe.doc_drift', {
        actionId: 'a1',
        matchedFields: 3,
        declaredFields: 5,
        mismatches: ['missing_field:foo', 'type_mismatch:bar'],
      });
      expect(result).toEqual({
        actionId: 'a1',
        matchedFields: 3,
        declaredFields: 5,
        mismatches: ['missing_field:foo', 'type_mismatch:bar'],
      });
    });

    it('rejects a payload where mismatches is not an array of strings', () => {
      const result = parseEvidencePayload('probe.doc_drift', {
        actionId: 'a1',
        matchedFields: 3,
        declaredFields: 5,
        mismatches: [1, 2],
      });
      expect(result).toBeNull();
    });
  });

  describe('probe.idempotency_signal', () => {
    it('parses a valid payload, including the optional matchedParam', () => {
      const result = parseEvidencePayload('probe.idempotency_signal', {
        actionId: 'a1',
        hasIdempotencySignal: true,
        matchedParam: 'Idempotency-Key',
      });
      expect(result).toEqual({ actionId: 'a1', hasIdempotencySignal: true, matchedParam: 'Idempotency-Key' });
    });

    it('rejects a payload missing hasIdempotencySignal', () => {
      const result = parseEvidencePayload('probe.idempotency_signal', { actionId: 'a1' });
      expect(result).toBeNull();
    });
  });

  describe('probe.write_lifecycle', () => {
    const payload = {
      actionId: 'a1',
      entity: 'tag',
      runId: 'r1',
      steps: { create: 201, read: 200, update: 200, readAfterUpdate: 200, delete: 204, readAfterDelete: 404 },
      idSource: 'body',
      convergence: 'immediate',
      pollCount: 0,
      schemaValid: true,
      unknownFieldCount: 1,
      serverGeneratedFieldCount: 2,
      updateReflected: true,
      useAfterFree: 'gone_404',
      cleanup: 'deleted_confirmed',
    };

    it('parses a complete lifecycle', () => {
      expect(parseEvidencePayload('probe.write_lifecycle', payload)).toEqual(payload);
    });

    it('rejects an unknown cleanup state — the vocabulary is closed', () => {
      expect(parseEvidencePayload('probe.write_lifecycle', { ...payload, cleanup: 'probably_fine' })).toBeNull();
    });

    it('rejects an entity name long enough to carry a payload', () => {
      expect(parseEvidencePayload('probe.write_lifecycle', { ...payload, entity: 'x'.repeat(65) })).toBeNull();
    });

    it('carries statuses and enums only — never an identifier field', () => {
      expect(Object.keys(payload)).not.toContain('resourceId');
      expect(JSON.stringify(parseEvidencePayload('probe.write_lifecycle', { ...payload, resourceId: 'tag_123' }))).not.toContain('tag_123');
    });
  });

  it('never throws on a malformed payload, even completely unrelated shapes', () => {
    expect(() => parseEvidencePayload('probe.auth_reject', null)).not.toThrow();
    expect(() => parseEvidencePayload('probe.auth_reject', 'not an object')).not.toThrow();
    expect(() => parseEvidencePayload('probe.auth_reject', [1, 2, 3])).not.toThrow();
    expect(parseEvidencePayload('probe.auth_reject', undefined)).toBeNull();
  });

  it('parses parser.* payloads with the shared points/maxPoints/message shape', () => {
    const result = parseEvidencePayload('parser.tool_name_quality', {
      points: 25,
      maxPoints: 25,
      message: 'All tool names are derived cleanly from the spec.',
    });
    expect(result).toEqual({ points: 25, maxPoints: 25, message: 'All tool names are derived cleanly from the spec.' });
  });
});
