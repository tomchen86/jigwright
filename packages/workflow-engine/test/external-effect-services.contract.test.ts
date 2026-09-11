import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import test from 'node:test';
import { fileURLToPath } from 'node:url';
import { createExternalEffectGrantOperations } from '../src/application/control-plane/external-effect-grant.ts';
import { createPublishExecutor } from '../src/application/control-plane/publish-executor.ts';
import type { ExternalEffectGrantServices } from '../src/modules/authority/external-effect-grant-services.ts';
import { externalEffectStore } from '../src/runtime/storage-journal/external-effect-grant-store.ts';
import {
  externalEffectRepository,
  publishRepository,
} from '../src/runtime/storage-journal/external-effect-grant-repository.ts';
import { emitAudit } from '../src/runtime/storage-journal/external-effect-grant-audit.ts';
import { deriveAuthorityAuditRepositoryId } from '../src/runtime/storage-journal/authority-audit-ledger.ts';
import {
  authorityRefusalDigest,
  withAuthorityRefusalAudit,
} from '../src/modules/authority/authority-refusal-audit.ts';
import { withRepositoryLifecycleOperation } from '../src/runtime/session-workspace/session-store.ts';
import { taskMandateOperations } from '../src/composition-root/task-mandate-production.ts';
import { ExitCode, workflowError } from '../src/foundation/errors/errors.ts';
import { assertPureDependencyClosure } from './support/pure-dependency-closure.ts';
import {
  EFFECT_GRANT_ID as GRANT_ID,
  EFFECT_ISSUED_AT as NOW,
  prepareExternalEffectFixture,
  publishGrantRequest,
} from './external-effect-fixture.ts';

function servicesFixture() {
  const events: string[] = [];
  let entropy = 0;
  let locked = false;
  let failAssertionAt = Infinity;
  let failure: unknown;
  let auditFailure: unknown;
  const services: ExternalEffectGrantServices = {
    store: {
      ...externalEffectStore,
      readOptionalPrivateFile(file) {
        events.push(`read:${locked}`);
        return externalEffectStore.readOptionalPrivateFile(file);
      },
      createPrivateFileAtomic(file, bytes) {
        events.push(`create:${locked}`);
        return externalEffectStore.createPrivateFileAtomic(file, bytes);
      },
    },
    repository: {
      ...externalEffectRepository,
      createInteractiveSshSigner,
      repositoryOrigin(repository) {
        events.push(`origin:${locked}`);
        return externalEffectRepository.repositoryOrigin(repository);
      },
    },
    taskMandate: taskMandateOperations,
    audit: {
      deriveAuthorityAuditRepositoryId,
      authorityRefusalDigest,
      withAuthorityRefusalAudit,
      emitAudit(repository, options, input) {
        events.push(`audit:${input.eventType}:${locked}`);
        if (auditFailure) throw auditFailure;
        return emitAudit(repository, options, input);
      },
    },
    now() {
      events.push('clock');
      return NOW;
    },
    newTransactionEntropy() {
      events.push(`entropy:${locked}`);
      entropy++;
      return 'f'.repeat(64);
    },
    withRepositoryLifecycleOperation(runtime, operation) {
      events.push('lock');
      return withRepositoryLifecycleOperation(runtime, (assertOwned) => {
        locked = true;
        let assertions = 0;
        try {
          return operation(() => {
            events.push('owned');
            assertOwned();
            if (++assertions === failAssertionAt) throw failure;
          });
        } finally {
          locked = false;
          events.push('release');
        }
      });
    },
  };
  const operations = createExternalEffectGrantOperations(services);
  return {
    services,
    operations,
    events,
    get entropy() {
      return entropy;
    },
    loseLock(assertion: number, error: unknown) {
      failAssertionAt = assertion;
      failure = error;
    },
    failAudit(error: unknown) {
      auditFailure = error;
    },
  };
}

function issuedFixture() {
  const fixture = prepareExternalEffectFixture();
  const injected = servicesFixture();
  injected.operations.issueExternalEffectGrant(
    fixture.repository,
    publishGrantRequest(fixture),
    {
      grantId: GRANT_ID,
      now: NOW,
      signer: fixture.signer,
      onAuditRecord: fixture.audit,
    },
  );
  injected.events.length = 0;
  return { fixture, injected };
}

test('external-effect domain codecs, records, audit facts and publication rules have a complete pure dependency closure', () => {
  for (const owner of [
    'external-effect-grant',
    'external-effect-grant-envelope',
    'external-effect-grant-records',
    'external-effect-grant-audit',
    'external-effect-grant-services',
    'publish-grant',
  ]) {
    assertPureDependencyClosure(
      fileURLToPath(
        new URL(`../src/modules/authority/${owner}.ts`, import.meta.url),
      ),
    );
  }
});

test('required external-effect and publication construction performs no observations and invalid issue input fails before clock access', () => {
  const f = servicesFixture();
  const execute = createPublishExecutor({
    grants: f.operations,
    repository: publishRepository,
    createProductionPublishRunner() {
      assert.fail('construction created a runner');
    },
    now() {
      assert.fail('construction read a clock');
    },
    environment() {
      assert.fail('construction read environment');
    },
  });
  assert.equal(typeof execute, 'function');
  assert.equal(f.events.length, 0);
  assert.throws(
    () =>
      f.operations.issueExternalEffectGrant('/never-read', null as never, {
        grantId: GRANT_ID,
      }),
    TypeError,
  );
  assert.throws(
    () =>
      f.operations.issueExternalEffectGrant('/never-read', {} as never, {
        grantId: GRANT_ID,
      }),
    { code: 'EXTERNAL_EFFECT_GRANT_INVALID' },
  );
  assert.equal(f.events.length, 0);
  assert.equal(f.entropy, 0);
});

test('reservation reads and validates fresh state under lock, then creates entropy once and never on reserved replay', () => {
  const { fixture, injected: f } = issuedFixture();
  try {
    const options = {
      now: NOW,
      signer: fixture.signer,
      onAuditRecord: fixture.audit,
    };
    const first = f.operations.reserveExternalEffectGrant(
      fixture.repository,
      GRANT_ID,
      options,
    );
    assert.equal(first.state, 'reserved');
    assert.equal(first.transactionToken, `${GRANT_ID}.${'f'.repeat(64)}`);
    assert.equal(f.entropy, 1);
    assert.ok(f.events.indexOf('lock') < f.events.indexOf('read:true'));
    assert.ok(
      f.events.indexOf('origin:true') < f.events.indexOf('entropy:true'),
    );
    assert.ok(
      f.events.indexOf('entropy:true') <
        f.events.indexOf('audit:grant-reserved:true'),
    );
    assert.ok(
      f.events.indexOf('audit:grant-reserved:true') <
        f.events.indexOf('create:true'),
    );
    const replay = f.operations.reserveExternalEffectGrant(
      fixture.repository,
      GRANT_ID,
      options,
    );
    assert.equal(replay.transactionToken, first.transactionToken);
    assert.equal(f.entropy, 1);
  } finally {
    fixture.dispose();
  }
});

test('reservation audit failure preserves the original error, releases the lock and publishes no transaction', () => {
  const { fixture, injected: f } = issuedFixture();
  try {
    const failure = workflowError(
      'TEST_AUDIT_APPEND_FAILURE',
      'expected failure',
      ExitCode.verification,
    );
    f.failAudit(failure);
    assert.throws(
      () =>
        f.operations.reserveExternalEffectGrant(fixture.repository, GRANT_ID, {
          now: NOW,
          signer: fixture.signer,
        }),
      (error) => error === failure,
    );
    assert.equal(f.events.at(-1), 'release');
    assert.equal(f.events.includes('create:true'), false);
    assert.equal(f.entropy, 1);
    const paths = externalEffectStore.externalEffectStorePaths(
      path.join(fixture.repository, '.git'),
    );
    assert.equal(
      fs.existsSync(
        externalEffectStore.grantPath(paths.transactions, GRANT_ID),
      ),
      false,
    );
    assert.equal(
      fs.existsSync(externalEffectStore.grantPath(paths.available, GRANT_ID)),
      true,
    );
  } finally {
    fixture.dispose();
  }
});

test('post-publication ownership failure retains the exact transaction bytes and replay does not regenerate entropy', () => {
  const { fixture, injected: f } = issuedFixture();
  try {
    const failure = workflowError(
      'TEST_LIFECYCLE_OWNERSHIP_LOST',
      'expected failure',
      ExitCode.conflict,
    );
    f.loseLock(3, failure);
    const options = {
      now: NOW,
      signer: fixture.signer,
      onAuditRecord: fixture.audit,
    };
    assert.throws(
      () =>
        f.operations.reserveExternalEffectGrant(
          fixture.repository,
          GRANT_ID,
          options,
        ),
      (error) => error === failure,
    );
    assert.equal(f.events.at(-1), 'release');
    const paths = externalEffectStore.externalEffectStorePaths(
      path.join(fixture.repository, '.git'),
    );
    const record = externalEffectStore.grantPath(paths.transactions, GRANT_ID);
    const bytes = fs.readFileSync(record, 'utf8');
    assert.equal(
      fs.existsSync(externalEffectStore.grantPath(paths.available, GRANT_ID)),
      false,
    );
    f.loseLock(Infinity, undefined);
    assert.equal(
      f.operations.reserveExternalEffectGrant(
        fixture.repository,
        GRANT_ID,
        options,
      ).state,
      'reserved',
    );
    assert.equal(fs.readFileSync(record, 'utf8'), bytes);
    assert.equal(f.entropy, 1);
  } finally {
    fixture.dispose();
  }
});

import { createInteractiveSshSigner } from '../src/adapters/signing/ssh/maintainer-signer.ts';
