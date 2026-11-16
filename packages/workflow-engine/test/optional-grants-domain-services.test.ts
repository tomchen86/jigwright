import assert from 'node:assert/strict';
import path from 'node:path';
import test from 'node:test';
import {
  createCollaborationGrantCodec,
  type CollaborationGrantOperations,
  type CollaborationGrantUseIdentity,
} from '../src/modules/authority/collaboration-grant-codec.ts';
import { assertPureDependencyClosure } from './support/pure-dependency-closure.ts';

test('required Grant operations are lazy, instance-local, and preserve failure identity', () => {
  const unexpected = (): never => {
    throw new Error('Unrequested Grant operation');
  };
  const operations: CollaborationGrantOperations = {
    canonicalCollaborationGrantEnvelopeBytesV1: unexpected,
    canonicalCollaborationGrantPayloadBytesV1: unexpected,
    parseCollaborationGrantEnvelopeV1: unexpected,
    selectCollaborationGrantSignatureNamespaceV1: unexpected,
    readAndVerifyCollaborationGrantEnvelopeV1: unexpected,
    canonicalSignedAttestationEnvelopeBytesV1: unexpected,
    canonicalSignedAttestationPayloadBytesV1: unexpected,
    parseSignedAttestationEnvelopeV1: unexpected,
    readAndVerifySignedAttestationEnvelopeV1: unexpected,
    assertUniqueGrantUseClaimsV1: unexpected,
  };
  const calls: string[] = [];
  const uses: readonly CollaborationGrantUseIdentity[] = [];
  const unavailable = Object.assign(new Error('Optional Grants unavailable'), {
    code: 'JIGWRIGHT_OPTIONAL_GRANTS_UNAVAILABLE',
  });
  const absent = createCollaborationGrantCodec({
    ...operations,
    assertUniqueGrantUseClaimsV1(input) {
      assert.equal(input, uses);
      calls.push('absent');
      throw unavailable;
    },
  });
  const present = createCollaborationGrantCodec({
    ...operations,
    assertUniqueGrantUseClaimsV1(input) {
      assert.equal(input, uses);
      calls.push('present');
    },
  });
  assert.deepEqual(calls, []);
  assert.throws(
    () => absent.assertUniqueCollaborationGrantUses(uses),
    (error) => error === unavailable,
  );
  present.assertUniqueCollaborationGrantUses(uses);
  assert.throws(
    () => absent.assertUniqueCollaborationGrantUses(uses),
    (error) => error === unavailable,
  );
  assert.deepEqual(calls, ['absent', 'present', 'absent']);
});

test('Grant domain services and canonical contracts have no runtime or application dependency closure', () => {
  const src = path.resolve(import.meta.dirname, '../src');
  for (const entry of [
    'authority/collaboration-grant-codec.ts',
    'authority/collaboration-grant-use.ts',
    'authority/collaboration-grant-records.ts',
    'authority/role-context-sharing-grant.ts',
    'authority/role-context-sharing-consumed-replay.ts',
    'provider-orchestration/role-scheduler.ts',
    'provider-orchestration/role-result-admission.ts',
    'provider-orchestration/role-admission-contracts.ts',
  ]) {
    assertPureDependencyClosure(path.join(src, 'modules', entry));
  }
});
