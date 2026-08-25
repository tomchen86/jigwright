import assert from 'node:assert/strict';
import test from 'node:test';

import { parseOpenSpecValidationPayloadV1 } from '../src/validation-payload.ts';

const REPOSITORY_ROOT = '/fixture/repository';

test('OpenSpec validation payload parser preserves exact public validation facts', () => {
  const parsed = parseOpenSpecValidationPayloadV1(
    {
      items: [
        {
          id: 'alpha-spec',
          type: 'spec',
          valid: true,
          issues: [
            {
              level: 'WARNING',
              path: 'specs/alpha-spec/spec.md',
              message: 'Review this scenario.',
              line: 7,
              column: 3,
            },
          ],
          durationMs: 11,
        },
        {
          id: 'beta-spec',
          type: 'spec',
          valid: false,
          issues: [
            {
              level: 'ERROR',
              path: 'specs/beta-spec/spec.md',
              message: 'A requirement is invalid.',
            },
          ],
          durationMs: 12,
        },
      ],
      summary: {
        totals: { items: 2, passed: 1, failed: 1 },
        byType: { spec: { items: 2, passed: 1, failed: 1 } },
      },
      version: '1.0',
      root: { path: REPOSITORY_ROOT, source: 'nearest' },
    },
    { repositoryRoot: REPOSITORY_ROOT, expectedType: 'spec' },
    unreachableInvalid,
  );

  assert.deepEqual(parsed, {
    valid: false,
    items: [
      {
        id: 'alpha-spec',
        type: 'spec',
        valid: true,
        issues: [
          {
            level: 'WARNING',
            path: 'specs/alpha-spec/spec.md',
            message: 'Review this scenario.',
            line: 7,
            column: 3,
          },
        ],
      },
      {
        id: 'beta-spec',
        type: 'spec',
        valid: false,
        issues: [
          {
            level: 'ERROR',
            path: 'specs/beta-spec/spec.md',
            message: 'A requirement is invalid.',
          },
        ],
      },
    ],
    root: { path: REPOSITORY_ROOT, source: 'nearest' },
  });
});

test('OpenSpec validation payload parser preserves exact identity and summary gates', () => {
  const invalid = new Error('caller-owned invalid payload');
  const base = {
    items: [
      {
        id: 'demo-change',
        type: 'change',
        valid: true,
        issues: [],
        durationMs: 0,
      },
    ],
    summary: {
      totals: { items: 1, passed: 1, failed: 0 },
      byType: { change: { items: 1, passed: 1, failed: 0 } },
    },
    version: '1.0',
    root: { path: REPOSITORY_ROOT, source: 'nearest' },
  };
  const context = {
    repositoryRoot: REPOSITORY_ROOT,
    expectedType: 'change' as const,
    expectedId: 'demo-change',
  };

  assert.deepEqual(
    parseOpenSpecValidationPayloadV1(base, context, () => invalid),
    {
      valid: true,
      items: [
        {
          id: 'demo-change',
          type: 'change',
          valid: true,
          issues: [],
        },
      ],
      root: { path: REPOSITORY_ROOT, source: 'nearest' },
    },
  );

  for (const malformed of [
    { ...base, root: { path: '/other', source: 'nearest' } },
    { ...base, items: [{ ...base.items[0], id: 'other-change' }] },
    {
      ...base,
      summary: {
        totals: { items: 1, passed: 0, failed: 1 },
        byType: { change: { items: 1, passed: 0, failed: 1 } },
      },
    },
    { ...base, items: [...base.items, base.items[0]] },
  ]) {
    assert.throws(
      () => parseOpenSpecValidationPayloadV1(malformed, context, () => invalid),
      (error) => error === invalid,
    );
  }
});

function unreachableInvalid(): Error {
  return new Error('valid payload unexpectedly rejected');
}
