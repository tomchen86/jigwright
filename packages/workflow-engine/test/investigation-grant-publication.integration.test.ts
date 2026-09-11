import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import test from 'node:test';
import { discoverRepository } from '../src/runtime/repository-transaction/git.ts';
import {
  discardHumanResolutionGrantPublication,
  inspectHumanResolutionGrantPublicationRecoveries,
} from '../src/composition-root/investigation-retry-production.ts';
import { createHumanResolutionJournal } from '../src/modules/investigation/domain/human-resolution-journal-contract.ts';
import {
  inspectStoredHumanResolutionGrants,
  storeAvailableHumanResolutionGrant,
} from '../src/runtime/storage-journal/human-resolution-grant-store.ts';
import { writeHumanResolutionJournal } from '../src/runtime/storage-journal/human-resolution-journal.ts';
import { investigationRuntimePaths } from '../src/runtime/session-workspace/paths.ts';
import { createFixtureRepository, git, isWorkflowError } from './fixture.ts';
import {
  FIRST_INSTANT,
  INVESTIGATION_SESSION_MODULE_URL,
  runWorkflowCli,
} from './investigation-session-fixture.ts';

test('grant store preserves interrupted available publication and reclaims terminal temps', () => {
  const repository = createFixtureRepository();
  const firstGrantId = '66666666-6666-4666-8666-666666666666';
  const secondGrantId = '77777777-7777-4777-8777-777777777777';
  try {
    const repositoryState = discoverRepository(repository);
    const paths = investigationRuntimePaths(
      repositoryState.gitCommonDirectory,
      'workflow-engine',
    );
    storeAvailableHumanResolutionGrant(
      paths,
      firstGrantId,
      `${JSON.stringify({ grantId: firstGrantId })}\n`,
    );
    const grantRoot = path.join(paths.root, 'human-resolutions', 'grants');
    const available = path.join(grantRoot, 'available');
    const terminal = path.join(grantRoot, 'terminal');
    fs.mkdirSync(terminal, { recursive: true, mode: 0o700 });
    fs.chmodSync(terminal, 0o700);
    const terminalTemporary = path.join(
      terminal,
      '99999999-9999-4999-8999-999999999999.json.99999999.22222222-2222-4222-8222-222222222222.tmp',
    );
    fs.writeFileSync(terminalTemporary, '{"partial":true}\n', { mode: 0o600 });
    fs.chmodSync(terminalTemporary, 0o600);

    assert.deepEqual(
      inspectStoredHumanResolutionGrants(paths).map(({ grantId }) => grantId),
      [firstGrantId],
    );
    assert.equal(fs.existsSync(terminalTemporary), true);

    storeAvailableHumanResolutionGrant(
      paths,
      secondGrantId,
      `${JSON.stringify({ grantId: secondGrantId })}\n`,
    );
    assert.equal(fs.existsSync(terminalTemporary), false);

    const availableTemporary = path.join(
      available,
      '88888888-8888-4888-8888-888888888888.json.99999999.11111111-1111-4111-8111-111111111111.tmp',
    );
    fs.writeFileSync(availableTemporary, '{"partial":true}\n', {
      mode: 0o600,
    });
    fs.chmodSync(availableTemporary, 0o600);
    const temporaryContent = '{"partial":true}\n';
    const temporaryDigest = crypto
      .createHash('sha256')
      .update(temporaryContent)
      .digest('hex');
    assert.deepEqual(
      inspectStoredHumanResolutionGrants(paths).map(({ grantId }) => grantId),
      [firstGrantId, secondGrantId],
    );
    assert.doesNotThrow(() =>
      storeAvailableHumanResolutionGrant(
        paths,
        'abababab-abab-4aba-8aba-abababababab',
        `${JSON.stringify({
          grantId: 'abababab-abab-4aba-8aba-abababababab',
        })}\n`,
      ),
    );
    assert.equal(fs.existsSync(availableTemporary), true);

    const inspection = runWorkflowCli(
      repository,
      [
        'maintainer',
        'resolution-inspect',
        '88888888-8888-4888-8888-888888888888',
      ],
      {},
    );
    assert.equal(inspection.status, 0, inspection.stderr);
    const inspected = JSON.parse(inspection.stdout) as {
      grants: Array<{ grantId: string }>;
      publicationRecoveries: Array<{
        grantId: string;
        temporaries: Array<{
          temporaryName: string;
          rawSha256: string;
          unsafeObservationDigest: string;
          byteLength: number;
          parsedEnvelopeGrantId: string | null;
        }>;
        publicationStateDigest: string;
        auditTag: {
          status: string;
          tagRef: string | null;
          refObjectOid: string | null;
          objectType: string | null;
        };
      }>;
    };
    assert.deepEqual(inspected.grants, []);
    assert.equal(inspected.publicationRecoveries.length, 1);
    const publicationRecovery = inspected.publicationRecoveries[0]!;
    assert.equal(
      publicationRecovery.grantId,
      '88888888-8888-4888-8888-888888888888',
    );
    assert.deepEqual(publicationRecovery.temporaries, [
      {
        temporaryName: path.basename(availableTemporary),
        rawSha256: temporaryDigest,
        unsafeObservationDigest:
          publicationRecovery.temporaries[0]!.unsafeObservationDigest,
        byteLength: Buffer.byteLength(temporaryContent),
        parsedEnvelopeGrantId: null,
      },
    ]);
    assert.match(
      publicationRecovery.temporaries[0]!.unsafeObservationDigest,
      /^[0-9a-f]{64}$/,
    );
    assert.match(publicationRecovery.publicationStateDigest, /^[0-9a-f]{64}$/);
    assert.deepEqual(publicationRecovery.auditTag, {
      status: 'absent',
      tagRef: null,
      refObjectOid: null,
      objectType: null,
    });

    const unattendedDiscard = runWorkflowCli(
      repository,
      [
        'maintainer',
        'resolution-publication-discard',
        '88888888-8888-4888-8888-888888888888',
        '--expected-publication-state',
        publicationRecovery.publicationStateDigest,
        '--reason',
        'Discard an interrupted grant publication after exact inspection.',
      ],
      {},
    );
    assert.equal(unattendedDiscard.status, 12, unattendedDiscard.stderr);
    assert.equal(
      JSON.parse(unattendedDiscard.stderr).error.code,
      'MAINTAINER_INTERACTIVE_REQUIRED',
    );
    assert.equal(fs.existsSync(availableTemporary), true);

    const recovery = discardHumanResolutionGrantPublication(
      repository,
      '88888888-8888-4888-8888-888888888888',
      publicationRecovery.publicationStateDigest,
      'Discard an interrupted grant publication after exact inspection.',
    );
    assert.deepEqual(recovery, {
      action: 'quarantined',
      grantId: '88888888-8888-4888-8888-888888888888',
      publicationStateDigest: publicationRecovery.publicationStateDigest,
    });
    assert.equal(fs.existsSync(availableTemporary), false);
    assert.doesNotThrow(() =>
      storeAvailableHumanResolutionGrant(
        paths,
        'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa',
        `${JSON.stringify({
          grantId: 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa',
        })}\n`,
      ),
    );

    fs.writeFileSync(path.join(available, 'unexpected.tmp'), '', {
      mode: 0o600,
    });
    assert.throws(
      () => inspectStoredHumanResolutionGrants(paths),
      (error: unknown) =>
        isWorkflowError(error, 'HUMAN_RESOLUTION_GRANT_UNSAFE'),
    );
  } finally {
    fs.rmSync(repository, { recursive: true, force: true });
  }
});

test('publication recovery is aggregate-CAS bound and quarantines every exact unpublished artifact', () => {
  const repository = createFixtureRepository();
  try {
    const repositoryState = discoverRepository(repository);
    const paths = investigationRuntimePaths(
      repositoryState.gitCommonDirectory,
      'workflow-engine',
    );
    const grantRoot = path.join(paths.root, 'human-resolutions', 'grants');
    const available = path.join(grantRoot, 'available');
    fs.mkdirSync(available, { recursive: true, mode: 0o700 });
    fs.chmodSync(available, 0o700);
    const createTemporary = (
      grantId: string,
      ownerToken: string,
      content: string,
    ) => {
      const temporary = path.join(
        available,
        `${grantId}.json.99999999.${ownerToken}.tmp`,
      );
      fs.writeFileSync(temporary, content, { mode: 0o600 });
      fs.chmodSync(temporary, 0o600);
      return temporary;
    };

    const staleGrantId = 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaa1';
    const staleTemporary = createTemporary(
      staleGrantId,
      '11111111-1111-4111-8111-111111111111',
      '{"partial":"before"}\n',
    );
    const staleInspection = inspectHumanResolutionGrantPublicationRecoveries(
      repository,
      staleGrantId,
    )[0]!;
    fs.writeFileSync(staleTemporary, '{"partial":"after"}\n', {
      mode: 0o600,
    });
    assert.throws(
      () =>
        discardHumanResolutionGrantPublication(
          repository,
          staleGrantId,
          staleInspection.publicationStateDigest,
          'Quarantine an exactly inspected interrupted publication.',
        ),
      (error: unknown) =>
        isWorkflowError(
          error,
          'HUMAN_RESOLUTION_GRANT_PUBLICATION_RECOVERY_STALE',
        ),
    );
    assert.equal(fs.existsSync(staleTemporary), true);
    const refreshed = inspectHumanResolutionGrantPublicationRecoveries(
      repository,
      staleGrantId,
    )[0]!;
    discardHumanResolutionGrantPublication(
      repository,
      staleGrantId,
      refreshed.publicationStateDigest,
      'Quarantine an exactly inspected interrupted publication.',
    );

    const multipleGrantId = 'bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbb2';
    const firstMultipleTemporary = createTemporary(
      multipleGrantId,
      '22222222-2222-4222-8222-222222222222',
      '{"partial":1}\n',
    );
    const secondMultipleTemporary = createTemporary(
      multipleGrantId,
      '33333333-3333-4333-8333-333333333333',
      '{"partial":2}\n',
    );
    const multiple = inspectHumanResolutionGrantPublicationRecoveries(
      repository,
      multipleGrantId,
    )[0]!;
    assert.equal(multiple.temporaries.length, 2);
    assert.doesNotThrow(() =>
      discardHumanResolutionGrantPublication(
        repository,
        multipleGrantId,
        multiple.publicationStateDigest,
        'Quarantine every exactly inspected publication artifact.',
      ),
    );
    assert.equal(fs.existsSync(firstMultipleTemporary), false);
    assert.equal(fs.existsSync(secondMultipleTemporary), false);

    const durableGrantId = 'cccccccc-cccc-4ccc-8ccc-ccccccccccc3';
    const durableTemporary = createTemporary(
      durableGrantId,
      '44444444-4444-4444-8444-444444444444',
      '{"partial":true}\n',
    );
    fs.writeFileSync(
      path.join(available, `${durableGrantId}.json`),
      `${JSON.stringify({ grantId: durableGrantId })}\n`,
      { mode: 0o600 },
    );
    const durable = inspectHumanResolutionGrantPublicationRecoveries(
      repository,
      durableGrantId,
    )[0]!;
    assert.match(durable.durable.availableDigest ?? '', /^[0-9a-f]{64}$/);
    assert.doesNotThrow(() =>
      discardHumanResolutionGrantPublication(
        repository,
        durableGrantId,
        durable.publicationStateDigest,
        'Quarantine only the unpublished residue without changing durable state.',
      ),
    );
    assert.equal(fs.existsSync(durableTemporary), false);
    assert.equal(
      inspectStoredHumanResolutionGrants(paths, durableGrantId)[0]?.state,
      'available',
    );

    const journalGrantId = 'dddddddd-dddd-4ddd-8ddd-ddddddddddd4';
    const journalTemporary = createTemporary(
      journalGrantId,
      '55555555-5555-4555-8555-555555555555',
      '{"partial":true}\n',
    );
    const receipts = path.join(paths.root, 'human-resolutions', 'receipts');
    fs.mkdirSync(receipts, { recursive: true, mode: 0o700 });
    fs.chmodSync(receipts, 0o700);
    fs.writeFileSync(
      path.join(receipts, `${journalGrantId}.json`),
      '{"result":"recorded"}\n',
      { mode: 0o600 },
    );
    const beforeActiveJournal =
      inspectHumanResolutionGrantPublicationRecoveries(
        repository,
        journalGrantId,
      )[0]!;
    const activeJournal = createHumanResolutionJournal({
      phase: 'prepared',
      grantId: journalGrantId,
      grantDigest: '1'.repeat(64),
      target: {
        workflowKind: 'investigation',
        changeId: 'active-journal-publication-test',
        workflowId: 'investigation-active-journal-publication-test',
      },
      beforeStateDigest: '2'.repeat(64),
      afterStateDigest: '3'.repeat(64),
      beforeResolutionRef: null,
      resolutionRefMode: 'preserve',
      plannedResolutionNodeId: '4'.repeat(64),
      plannedCurrentWorkflowRef: {
        expectedInvestigationId: null,
        expectedDigest: null,
        nextInvestigationId: null,
        nextDigest: null,
      },
      plannedStartReservation: {
        mode: 'preserve',
        expectedDigest: null,
        nextDigest: null,
        archiveDigest: null,
      },
      plannedEvidenceRefs: {
        mode: 'preserve',
        expectedDigest: null,
        nextDigest: null,
        expectedClosureDigest: null,
        nextClosureDigest: null,
        retiredRefs: {},
        retainedRefs: {},
        archiveDigest: null,
      },
      evidenceArchiveDigest: '5'.repeat(64),
      receiptDigest: '6'.repeat(64),
      createdAt: FIRST_INSTANT,
    });
    writeHumanResolutionJournal(paths, activeJournal);
    const journal = inspectHumanResolutionGrantPublicationRecoveries(
      repository,
      journalGrantId,
    )[0]!;
    assert.equal(journal.sameGrantJournalDigest, null);
    assert.match(journal.sameGrantActiveJournalDigest ?? '', /^[0-9a-f]{64}$/);
    assert.match(journal.sameGrantReceiptDigest ?? '', /^[0-9a-f]{64}$/);
    assert.notEqual(
      journal.publicationStateDigest,
      beforeActiveJournal.publicationStateDigest,
    );
    assert.throws(
      () =>
        discardHumanResolutionGrantPublication(
          repository,
          journalGrantId,
          beforeActiveJournal.publicationStateDigest,
          'Reject a stale aggregate that omitted the active journal.',
        ),
      (error: unknown) =>
        isWorkflowError(
          error,
          'HUMAN_RESOLUTION_GRANT_PUBLICATION_RECOVERY_STALE',
        ),
    );
    assert.doesNotThrow(() =>
      discardHumanResolutionGrantPublication(
        repository,
        journalGrantId,
        journal.publicationStateDigest,
        'Quarantine only the exact unpublished residue while preserving transaction state.',
      ),
    );
    assert.equal(fs.existsSync(journalTemporary), false);
    assert.equal(
      fs.existsSync(
        path.join(
          paths.root,
          'human-resolutions',
          'active',
          'active-journal-publication-test.json',
        ),
      ),
      true,
    );
    assert.equal(
      fs.existsSync(path.join(receipts, `${journalGrantId}.json`)),
      true,
    );

    const mismatchedGrantId = 'eeeeeeee-eeee-4eee-8eee-eeeeeeeeeee5';
    const envelopeGrantId = 'ffffffff-ffff-4fff-8fff-fffffffffff6';
    const mismatchedTemporary = createTemporary(
      mismatchedGrantId,
      '66666666-6666-4666-8666-666666666666',
      `${JSON.stringify({ payload: { grantId: envelopeGrantId } })}\n`,
    );
    const mismatched = inspectHumanResolutionGrantPublicationRecoveries(
      repository,
      mismatchedGrantId,
    )[0]!;
    assert.equal(
      mismatched.temporaries[0]?.parsedEnvelopeGrantId,
      envelopeGrantId,
    );
    assert.doesNotThrow(() =>
      discardHumanResolutionGrantPublication(
        repository,
        mismatchedGrantId,
        mismatched.publicationStateDigest,
        'Quarantine the exact unpublished bytes without interpreting them as authority.',
      ),
    );
    assert.equal(fs.existsSync(mismatchedTemporary), false);
  } finally {
    fs.rmSync(repository, { recursive: true, force: true });
  }
});

test('publication recovery is per-grant, preserves audit tags and quarantines raw bytes', () => {
  const repository = createFixtureRepository();
  const firstGrantId = '12121212-1212-4212-8212-121212121212';
  const secondGrantId = '34343434-3434-4434-8434-343434343434';
  const firstContent = '{"partial":"first"}\n';
  const secondContent = '{"partial":"second"}\n';
  try {
    const repositoryState = discoverRepository(repository);
    const paths = investigationRuntimePaths(
      repositoryState.gitCommonDirectory,
      'workflow-engine',
    );
    const available = path.join(
      paths.root,
      'human-resolutions',
      'grants',
      'available',
    );
    fs.mkdirSync(available, { recursive: true, mode: 0o700 });
    fs.chmodSync(available, 0o700);
    const firstTemporary = path.join(
      available,
      `${firstGrantId}.json.99999999.77777777-7777-4777-8777-777777777777.tmp`,
    );
    const secondTemporary = path.join(
      available,
      `${secondGrantId}.json.99999999.88888888-8888-4888-8888-888888888888.tmp`,
    );
    fs.writeFileSync(firstTemporary, firstContent, { mode: 0o600 });
    fs.writeFileSync(secondTemporary, secondContent, { mode: 0o600 });
    const tagRef = `refs/tags/workflow-grant/resolution-${firstGrantId}`;
    git(repository, [
      'tag',
      '-a',
      tagRef.slice('refs/tags/'.length),
      '-m',
      'Interrupted publication audit evidence',
    ]);
    const tagObject = git(repository, ['rev-parse', tagRef]).trim();

    const inspections =
      inspectHumanResolutionGrantPublicationRecoveries(repository);
    assert.deepEqual(
      inspections.map(({ grantId }) => grantId),
      [firstGrantId, secondGrantId],
    );
    const first = inspections[0]!;
    assert.deepEqual(first.auditTag, {
      status: 'present',
      tagRef,
      refObjectOid: tagObject,
      objectType: 'tag',
    });
    const publicationRecoveries = path.join(
      paths.root,
      'human-resolutions',
      'grants',
      'publication-recoveries',
    );
    fs.mkdirSync(publicationRecoveries, { recursive: true, mode: 0o700 });
    fs.writeFileSync(
      path.join(
        publicationRecoveries,
        '67676767-6767-4767-8767-676767676767.json',
      ),
      '{"malformed":"unrelated-recovery"}\n',
      { mode: 0o600 },
    );
    assert.equal(
      inspectHumanResolutionGrantPublicationRecoveries(
        repository,
        secondGrantId,
      ).length,
      1,
    );
    writeHumanResolutionJournal(
      paths,
      createHumanResolutionJournal({
        phase: 'prepared',
        grantId: '45454545-4545-4545-8545-454545454545',
        grantDigest: '1'.repeat(64),
        target: {
          workflowKind: 'investigation',
          changeId: 'unrelated-change',
          workflowId: 'investigation-unrelated-change',
        },
        beforeStateDigest: '2'.repeat(64),
        afterStateDigest: '3'.repeat(64),
        beforeResolutionRef: null,
        resolutionRefMode: 'preserve',
        plannedResolutionNodeId: '4'.repeat(64),
        plannedCurrentWorkflowRef: {
          expectedInvestigationId: null,
          expectedDigest: null,
          nextInvestigationId: null,
          nextDigest: null,
        },
        plannedStartReservation: {
          mode: 'preserve',
          expectedDigest: null,
          nextDigest: null,
          archiveDigest: null,
        },
        plannedEvidenceRefs: {
          mode: 'preserve',
          expectedDigest: null,
          nextDigest: null,
          expectedClosureDigest: null,
          nextClosureDigest: null,
          retiredRefs: {},
          retainedRefs: {},
          archiveDigest: null,
        },
        evidenceArchiveDigest: '5'.repeat(64),
        receiptDigest: '6'.repeat(64),
        createdAt: FIRST_INSTANT,
      }),
    );
    discardHumanResolutionGrantPublication(
      repository,
      firstGrantId,
      first.publicationStateDigest,
      'Quarantine only this interrupted publication and preserve its tag.',
    );
    assert.equal(fs.existsSync(firstTemporary), false);
    assert.equal(fs.existsSync(secondTemporary), true);
    assert.equal(git(repository, ['rev-parse', tagRef]).trim(), tagObject);

    const second = inspectHumanResolutionGrantPublicationRecoveries(
      repository,
      secondGrantId,
    )[0]!;
    discardHumanResolutionGrantPublication(
      repository,
      secondGrantId,
      second.publicationStateDigest,
      'Quarantine the second independently inspected publication.',
    );
    assert.equal(fs.existsSync(secondTemporary), false);
    const quarantine = path.join(paths.root, 'human-resolutions', 'quarantine');
    assert.deepEqual(
      fs
        .readdirSync(quarantine)
        .map((name) => fs.readFileSync(path.join(quarantine, name), 'utf8'))
        .sort(),
      [firstContent, secondContent].sort(),
    );
    const recoveryReceipts = path.join(
      paths.root,
      'human-resolutions',
      'grants',
      'publication-recoveries',
    );
    for (const name of [`${firstGrantId}.json`, `${secondGrantId}.json`]) {
      assert.equal(
        JSON.parse(fs.readFileSync(path.join(recoveryReceipts, name), 'utf8'))
          .phase,
        'quarantined',
      );
    }
    assert.doesNotThrow(() =>
      storeAvailableHumanResolutionGrant(
        paths,
        '56565656-5656-4656-8656-565656565656',
        `${JSON.stringify({
          grantId: '56565656-5656-4656-8656-565656565656',
        })}\n`,
      ),
    );
  } finally {
    fs.rmSync(repository, { recursive: true, force: true });
  }
});

test('publication recovery resumes after a prepared receipt crash', () => {
  const repository = createFixtureRepository();
  const grantId = '78787878-7878-4878-8878-787878787878';
  const reason =
    'Resume exact interrupted publication quarantine after process death.';
  try {
    const repositoryState = discoverRepository(repository);
    const paths = investigationRuntimePaths(
      repositoryState.gitCommonDirectory,
      'workflow-engine',
    );
    const available = path.join(
      paths.root,
      'human-resolutions',
      'grants',
      'available',
    );
    fs.mkdirSync(available, { recursive: true, mode: 0o700 });
    fs.chmodSync(available, 0o700);
    const temporary = path.join(
      available,
      `${grantId}.json.99999999.99999999-9999-4999-8999-999999999999.tmp`,
    );
    fs.writeFileSync(temporary, '{"partial":"crash"}\n', { mode: 0o600 });
    const inspection = inspectHumanResolutionGrantPublicationRecoveries(
      repository,
      grantId,
    )[0]!;
    const child = spawnSync(
      process.execPath,
      [
        '--experimental-strip-types',
        '--input-type=module',
        '--eval',
        `
          const fs = (await import('node:fs')).default;
          const originalRename = fs.renameSync.bind(fs);
          fs.renameSync = (source, target) => {
            if (
              String(source).includes(${JSON.stringify(grantId)}) &&
              String(target).endsWith('.grant-publication.artifact')
            ) {
              process.kill(process.pid, 'SIGKILL');
            }
            return originalRename(source, target);
          };
          const { discardHumanResolutionGrantPublication } =
            await import(${JSON.stringify(INVESTIGATION_SESSION_MODULE_URL)});
          discardHumanResolutionGrantPublication(
            ${JSON.stringify(repository)},
            ${JSON.stringify(grantId)},
            ${JSON.stringify(inspection.publicationStateDigest)},
            ${JSON.stringify(reason)},
          );
        `,
      ],
      { cwd: repository, encoding: 'utf8' },
    );
    assert.equal(child.signal, 'SIGKILL');
    assert.equal(fs.existsSync(temporary), true);
    const recoveryReceipts = path.join(
      paths.root,
      'human-resolutions',
      'grants',
      'publication-recoveries',
    );
    const receiptName = fs.readdirSync(recoveryReceipts)[0]!;
    assert.equal(
      JSON.parse(
        fs.readFileSync(path.join(recoveryReceipts, receiptName), 'utf8'),
      ).phase,
      'prepared',
    );

    assert.deepEqual(
      discardHumanResolutionGrantPublication(
        repository,
        grantId,
        inspection.publicationStateDigest,
        reason,
      ),
      {
        action: 'quarantined',
        grantId,
        publicationStateDigest: inspection.publicationStateDigest,
      },
    );
    assert.equal(fs.existsSync(temporary), false);
    assert.equal(
      JSON.parse(
        fs.readFileSync(path.join(recoveryReceipts, receiptName), 'utf8'),
      ).phase,
      'quarantined',
    );
  } finally {
    fs.rmSync(repository, { recursive: true, force: true });
  }
});

test('publication recovery remains visible after rename and terminally reserves the discarded grant ID', () => {
  const repository = createFixtureRepository();
  const grantId = '89898989-8989-4989-8989-898989898989';
  const otherGrantId = '90909090-9090-4090-8090-909090909090';
  const reason =
    'Resume an exact publication quarantine after the artifact rename became durable.';
  try {
    const repositoryState = discoverRepository(repository);
    const paths = investigationRuntimePaths(
      repositoryState.gitCommonDirectory,
      'workflow-engine',
    );
    const available = path.join(
      paths.root,
      'human-resolutions',
      'grants',
      'available',
    );
    fs.mkdirSync(available, { recursive: true, mode: 0o700 });
    fs.chmodSync(available, 0o700);
    const temporary = path.join(
      available,
      `${grantId}.json.99999999.10101010-1010-4010-8010-101010101010.tmp`,
    );
    fs.writeFileSync(temporary, '{"partial":"post-rename-crash"}\n', {
      mode: 0o600,
    });
    const tagRef = `refs/tags/workflow-grant/resolution-${grantId}`;
    git(repository, [
      'tag',
      '-a',
      tagRef.slice('refs/tags/'.length),
      '-m',
      'Bind the publication recovery preimage',
    ]);
    const tagObject = git(repository, ['rev-parse', tagRef]).trim();
    const inspection = inspectHumanResolutionGrantPublicationRecoveries(
      repository,
      grantId,
    )[0]!;
    const child = spawnSync(
      process.execPath,
      [
        '--experimental-strip-types',
        '--input-type=module',
        '--eval',
        `
          const fs = (await import('node:fs')).default;
          const originalRename = fs.renameSync.bind(fs);
          fs.renameSync = (source, target) => {
            const result = originalRename(source, target);
            if (
              String(source).includes(${JSON.stringify(grantId)}) &&
              String(target).endsWith('.grant-publication.artifact')
            ) {
              process.kill(process.pid, 'SIGKILL');
            }
            return result;
          };
          const { discardHumanResolutionGrantPublication } =
            await import(${JSON.stringify(INVESTIGATION_SESSION_MODULE_URL)});
          discardHumanResolutionGrantPublication(
            ${JSON.stringify(repository)},
            ${JSON.stringify(grantId)},
            ${JSON.stringify(inspection.publicationStateDigest)},
            ${JSON.stringify(reason)},
          );
        `,
      ],
      { cwd: repository, encoding: 'utf8' },
    );
    assert.equal(child.signal, 'SIGKILL');
    assert.equal(fs.existsSync(temporary), false);
    git(repository, ['tag', '-d', tagRef.slice('refs/tags/'.length)]);

    const visibleAfterRename = inspectHumanResolutionGrantPublicationRecoveries(
      repository,
      grantId,
    );
    assert.equal(visibleAfterRename.length, 1);
    assert.equal(
      visibleAfterRename[0]?.publicationStateDigest,
      inspection.publicationStateDigest,
    );
    assert.deepEqual(
      visibleAfterRename[0]?.temporaries.map(
        ({ temporaryName }) => temporaryName,
      ),
      [path.basename(temporary)],
    );
    assert.deepEqual(visibleAfterRename[0]?.auditTag, {
      status: 'present',
      tagRef,
      refObjectOid: tagObject,
      objectType: 'tag',
    });

    assert.throws(
      () =>
        storeAvailableHumanResolutionGrant(
          paths,
          grantId,
          `${JSON.stringify({ grantId })}\n`,
        ),
      (error: unknown) =>
        isWorkflowError(error, 'HUMAN_RESOLUTION_GRANT_EXISTS'),
    );
    assert.deepEqual(
      discardHumanResolutionGrantPublication(
        repository,
        grantId,
        inspection.publicationStateDigest,
        reason,
      ),
      {
        action: 'quarantined',
        grantId,
        publicationStateDigest: inspection.publicationStateDigest,
      },
    );
    assert.throws(
      () =>
        storeAvailableHumanResolutionGrant(
          paths,
          grantId,
          `${JSON.stringify({ grantId })}\n`,
        ),
      (error: unknown) =>
        isWorkflowError(error, 'HUMAN_RESOLUTION_GRANT_EXISTS'),
    );
    assert.doesNotThrow(() =>
      storeAvailableHumanResolutionGrant(
        paths,
        otherGrantId,
        `${JSON.stringify({ grantId: otherGrantId })}\n`,
      ),
    );
  } finally {
    fs.rmSync(repository, { recursive: true, force: true });
  }
});

test('publication recovery reclaims receipt publication temps before and after artifact quarantine', () => {
  for (const killOnReceiptRename of [1, 2]) {
    const repository = createFixtureRepository();
    const grantId =
      killOnReceiptRename === 1
        ? '91919191-9191-4191-8191-919191919191'
        : '92929292-9292-4292-8292-929292929292';
    const reason =
      'Recover an interrupted publication-recovery receipt write exactly.';
    try {
      const repositoryState = discoverRepository(repository);
      const paths = investigationRuntimePaths(
        repositoryState.gitCommonDirectory,
        'workflow-engine',
      );
      const available = path.join(
        paths.root,
        'human-resolutions',
        'grants',
        'available',
      );
      const recoveryDirectory = path.join(
        paths.root,
        'human-resolutions',
        'grants',
        'publication-recoveries',
      );
      const receiptPath = path.join(recoveryDirectory, `${grantId}.json`);
      fs.mkdirSync(available, { recursive: true, mode: 0o700 });
      fs.chmodSync(available, 0o700);
      const temporary = path.join(
        available,
        `${grantId}.json.99999999.20202020-2020-4020-8020-202020202020.tmp`,
      );
      fs.writeFileSync(
        temporary,
        `{"partial":"receipt-rename-${killOnReceiptRename}"}\n`,
        { mode: 0o600 },
      );
      const inspection = inspectHumanResolutionGrantPublicationRecoveries(
        repository,
        grantId,
      )[0]!;
      const child = spawnSync(
        process.execPath,
        [
          '--experimental-strip-types',
          '--input-type=module',
          '--eval',
          `
            const fs = (await import('node:fs')).default;
            const originalRename = fs.renameSync.bind(fs);
            let receiptRenames = 0;
            fs.renameSync = (source, target) => {
              if (String(target) === ${JSON.stringify(receiptPath)}) {
                receiptRenames += 1;
                if (receiptRenames === ${killOnReceiptRename}) {
                  process.kill(process.pid, 'SIGKILL');
                }
              }
              return originalRename(source, target);
            };
            const { discardHumanResolutionGrantPublication } =
              await import(${JSON.stringify(INVESTIGATION_SESSION_MODULE_URL)});
            discardHumanResolutionGrantPublication(
              ${JSON.stringify(repository)},
              ${JSON.stringify(grantId)},
              ${JSON.stringify(inspection.publicationStateDigest)},
              ${JSON.stringify(reason)},
            );
          `,
        ],
        { cwd: repository, encoding: 'utf8' },
      );
      assert.equal(child.signal, 'SIGKILL');
      assert.equal(
        fs
          .readdirSync(recoveryDirectory)
          .filter((name) => name.endsWith('.tmp')).length,
        1,
      );

      const visible = inspectHumanResolutionGrantPublicationRecoveries(
        repository,
        grantId,
      );
      assert.equal(visible.length, 1);
      assert.equal(
        visible[0]?.publicationStateDigest,
        inspection.publicationStateDigest,
      );
      assert.equal(
        fs
          .readdirSync(recoveryDirectory)
          .filter((name) => name.endsWith('.tmp')).length,
        0,
      );
      assert.doesNotThrow(() =>
        discardHumanResolutionGrantPublication(
          repository,
          grantId,
          inspection.publicationStateDigest,
          reason,
        ),
      );
      assert.equal(
        JSON.parse(fs.readFileSync(receiptPath, 'utf8')).phase,
        'quarantined',
      );
    } finally {
      fs.rmSync(repository, { recursive: true, force: true });
    }
  }
});
