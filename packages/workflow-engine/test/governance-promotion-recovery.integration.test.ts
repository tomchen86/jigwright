import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawn, spawnSync } from 'node:child_process';
import test from 'node:test';
import { captureGovernanceSource } from '../src/composition-root/governance-sources-production.ts';
import { canonicalJson } from '../src/foundation/canonical-json/canonical-json.ts';
import {
  applyWorkItemReview,
  createWorkItem,
  promoteWorkItem,
  showWorkItem,
  traceWorkItem,
  validateWorkRegistry,
  workItemDigest,
} from '../src/composition-root/work-registry-production.ts';
import {
  runGitForTest,
  configureRepositoryConsumer,
  hasCode,
} from './governance-intake-fixture.ts';

test('Work Item promotion recovers one exact item-origin transaction after every hard-crash cut', () => {
  const moduleUrl = new URL(
    '../src/composition-root/work-registry-production.ts',
    import.meta.url,
  ).href;
  const crashCuts = [
    'afterJournalPersisted',
    'afterOriginPublished',
    'afterItemPublished',
  ] as const;
  const workItemIds = [
    'WORK-01K39R0V000000000000000006',
    'WORK-01K39R0V000000000000000007',
    'WORK-01K39R0V000000000000000008',
  ] as const;

  for (const [index, crashCut] of crashCuts.entries()) {
    const repositoryRoot = fs.mkdtempSync(
      path.join(os.tmpdir(), `jigwright-work-promotion-${crashCut}-`),
    );
    configureRepositoryConsumer(repositoryRoot);
    try {
      runGitForTest(repositoryRoot, ['init', '-b', 'main']);
      const workItemId = workItemIds[index]!;
      const changeId = `crash-atomic-promotion-${index + 1}`;
      const created = createWorkItem(
        repositoryRoot,
        {
          schemaVersion: 1,
          kind: 'feature',
          lane: 'next',
          title: `Recover ${index === 0 ? 'é ' : ''}${crashCut}`,
          summary: 'Recover one exact Work Item and change-origin promotion.',
          sourceRefs: [],
        },
        {
          now: () => `2026-08-24T03:2${index}:00.000Z`,
          createId: () => workItemId,
        },
      );
      const accepted = applyWorkItemReview(
        repositoryRoot,
        created.item.id,
        {
          action: 'accept',
          expectedDigest: workItemDigest(created.item),
          summary: created.item.interpretation.summary,
        },
        () => `2026-08-24T03:2${index}:30.000Z`,
      );
      const changeDirectory = path.join(
        repositoryRoot,
        'openspec/changes',
        changeId,
      );
      fs.mkdirSync(changeDirectory, { recursive: true });
      const promotedAt = `2026-08-24T03:3${index}:00.000Z`;
      const childSource = `
        const { promoteWorkItem } = await import(${JSON.stringify(moduleUrl)});
        promoteWorkItem(
          ${JSON.stringify(repositoryRoot)},
          ${JSON.stringify(accepted.id)},
          ${JSON.stringify(changeId)},
          () => ${JSON.stringify(promotedAt)},
          ${JSON.stringify(workItemDigest(accepted))},
          { ${crashCut}() { process.exit(86); } },
        );
      `;
      const crashed = spawnSync(
        process.execPath,
        [
          '--experimental-strip-types',
          '--input-type=module',
          '--eval',
          childSource,
        ],
        { cwd: repositoryRoot },
      );
      assert.equal(
        crashed.status,
        86,
        `${crashCut}: ${crashed.stderr || crashed.stdout}`,
      );

      let exactTemporarySnapshot:
        { inode: bigint; ctimeNs: bigint; birthtimeNs: bigint } | undefined;
      if (index === 0) {
        const journalRoot = path.join(
          repositoryRoot,
          '.git/workflow-engine/work-registry/promotion-journals',
        );
        const [journalName] = fs.readdirSync(journalRoot);
        assert.ok(journalName);
        const journalPath = path.join(journalRoot, journalName);
        const journalBytes = fs.readFileSync(journalPath, 'utf8');
        const abandonedJournalTemporaryPath = path.join(
          journalRoot,
          `sha256-${'0'.repeat(64)}.json.1.00000000-0000-4000-8000-000000000000.tmp`,
        );
        const pending = JSON.parse(journalBytes) as {
          operationId: string;
          itemRelativePath: string;
          originRelativePath: string;
          after: { itemContent: string; originContent: string };
        };
        const pendingItemPath = path.join(
          repositoryRoot,
          ...pending.itemRelativePath.split('/'),
        );
        const desiredTemporaryPath = path.join(
          path.dirname(pendingItemPath),
          `.${path.basename(pendingItemPath)}.${pending.operationId.replace(':', '-')}.item-forward.desired.publish.tmp`,
        );
        const desiredItemBytes = Buffer.from(pending.after.itemContent, 'utf8');
        const multibyteStart = desiredItemBytes.indexOf(Buffer.from('é'));
        assert.notEqual(multibyteStart, -1);
        fs.writeFileSync(
          abandonedJournalTemporaryPath,
          desiredItemBytes.subarray(0, multibyteStart + 1),
          { mode: 0o400 },
        );
        assert.equal(
          fs.lstatSync(abandonedJournalTemporaryPath).mode & 0o777,
          0o400,
        );
        fs.writeFileSync(
          desiredTemporaryPath,
          desiredItemBytes.subarray(0, multibyteStart + 1),
          { mode: 0o600 },
        );
        const pendingOriginPath = path.join(
          repositoryRoot,
          ...pending.originRelativePath.split('/'),
        );
        const exactDesiredTemporaryPath = path.join(
          path.dirname(pendingOriginPath),
          `.${path.basename(pendingOriginPath)}.${pending.operationId.replace(':', '-')}.origin-forward.desired.publish.tmp`,
        );
        fs.writeFileSync(
          exactDesiredTemporaryPath,
          pending.after.originContent,
          { encoding: 'utf8', mode: 0o644 },
        );
        const exactTemporaryStats = fs.lstatSync(exactDesiredTemporaryPath, {
          bigint: true,
        });
        exactTemporarySnapshot = {
          inode: exactTemporaryStats.ino,
          ctimeNs: exactTemporaryStats.ctimeNs,
          birthtimeNs: exactTemporaryStats.birthtimeNs,
        };
        const poisoned = JSON.parse(journalBytes) as Record<string, unknown>;
        poisoned.transactionDigest = `sha256:${'f'.repeat(64)}`;
        const poisonedBytes = `${canonicalJson(poisoned)}\n`;
        fs.writeFileSync(journalPath, poisonedBytes);
        const itemPath = path.join(repositoryRoot, created.relativePath);
        const itemBytes = fs.readFileSync(itemPath, 'utf8');
        const originPath = path.join(changeDirectory, 'origin.json');

        assert.throws(
          () => validateWorkRegistry(repositoryRoot),
          hasCode('WORK_REGISTRY_TRANSACTION_INVALID'),
        );
        assert.equal(fs.readFileSync(itemPath, 'utf8'), itemBytes);
        assert.equal(fs.existsSync(originPath), false);
        assert.equal(fs.readFileSync(journalPath, 'utf8'), poisonedBytes);
        assert.equal(fs.existsSync(abandonedJournalTemporaryPath), false);
        fs.writeFileSync(journalPath, journalBytes);
        assert.equal(fs.existsSync(desiredTemporaryPath), true);
        assert.equal(fs.existsSync(exactDesiredTemporaryPath), true);
        assert.equal(fs.existsSync(pendingOriginPath), false);
        assert.notEqual(exactTemporarySnapshot.inode, 0n);
      }

      assert.deepEqual(validateWorkRegistry(repositoryRoot), {
        itemCount: 1,
        sourceCount: 0,
      });
      if (index === 0) {
        const recoveredOriginPath = path.join(changeDirectory, 'origin.json');
        assert.equal(
          fs
            .readdirSync(
              path.dirname(path.join(repositoryRoot, created.relativePath)),
            )
            .some((entry) => entry.endsWith('.desired.publish.tmp')),
          false,
        );
        const originEntries = fs.readdirSync(changeDirectory);
        assert.equal(
          originEntries.some((entry) => entry.endsWith('.desired.publish.tmp')),
          false,
        );
        const recoveredOriginStats = fs.lstatSync(recoveredOriginPath, {
          bigint: true,
        });
        assert.ok(exactTemporarySnapshot);
        assert.notDeepEqual(
          {
            inode: recoveredOriginStats.ino,
            ctimeNs: recoveredOriginStats.ctimeNs,
            birthtimeNs: recoveredOriginStats.birthtimeNs,
          },
          exactTemporarySnapshot,
        );
      }
      const resumed = promoteWorkItem(
        repositoryRoot,
        accepted.id,
        changeId,
        () => promotedAt,
        workItemDigest(accepted),
      );
      const recovered = resumed.item;
      assert.equal(recovered.stage, 'active');
      assert.deepEqual(recovered.changeRefs, [changeId]);
      assert.deepEqual(recovered.timeline.at(-1), {
        at: promotedAt,
        event: 'promoted',
        changeId,
      });
      assert.deepEqual(
        JSON.parse(
          fs.readFileSync(path.join(changeDirectory, 'origin.json'), 'utf8'),
        ),
        {
          schemaVersion: 1,
          sourceRefs: [],
          workItemRefs: [accepted.id],
        },
      );
      const journalRoot = path.join(
        repositoryRoot,
        '.git/workflow-engine/work-registry/promotion-journals',
      );
      assert.deepEqual(fs.readdirSync(journalRoot), []);
      const recoveredRoot = path.join(
        repositoryRoot,
        '.git/workflow-engine/work-registry/recovered-promotions',
      );
      const recoveredReceipts = fs.readdirSync(recoveredRoot);
      assert.equal(recoveredReceipts.length, 1);
      assert.match(recoveredReceipts[0]!, /^sha256-[0-9a-f]{64}\.json$/);
      assert.deepEqual(
        promoteWorkItem(
          repositoryRoot,
          accepted.id,
          changeId,
          () => promotedAt,
          workItemDigest(accepted),
        ),
        resumed,
      );
      assert.deepEqual(fs.readdirSync(recoveredRoot), recoveredReceipts);
      if (index === 0) {
        const archivedDirectory = path.join(
          repositoryRoot,
          'openspec/changes/archive',
          changeId,
        );
        fs.mkdirSync(path.dirname(archivedDirectory), { recursive: true });
        fs.renameSync(changeDirectory, archivedDirectory);
        assert.throws(
          () =>
            promoteWorkItem(
              repositoryRoot,
              accepted.id,
              'unrelated-later-promotion',
            ),
          hasCode('WORK_REGISTRY_PROMOTION_INELIGIBLE'),
        );
        assert.deepEqual(fs.readdirSync(recoveredRoot), recoveredReceipts);
      }
    } finally {
      fs.rmSync(repositoryRoot, { recursive: true, force: true });
    }
  }
});

test('composite Work Registry readers hold the promotion lock across item-origin snapshots', async () => {
  const repositoryRoot = fs.mkdtempSync(
    path.join(os.tmpdir(), 'jigwright-work-promotion-read-lock-'),
  );
  configureRepositoryConsumer(repositoryRoot);
  try {
    runGitForTest(repositoryRoot, ['init', '-b', 'main']);
    const created = createWorkItem(
      repositoryRoot,
      {
        schemaVersion: 1,
        kind: 'feature',
        lane: 'next',
        title: 'Keep composite readers on one promotion snapshot',
        summary: 'Serialize the item and origin halves of public reads.',
        sourceRefs: [],
      },
      {
        now: () => '2026-08-24T03:39:00.000Z',
        createId: () => 'WORK-01K39R0V00000000000000000N',
      },
    );
    const accepted = applyWorkItemReview(
      repositoryRoot,
      created.item.id,
      {
        action: 'accept',
        expectedDigest: workItemDigest(created.item),
        summary: created.item.interpretation.summary,
      },
      () => '2026-08-24T03:39:30.000Z',
    );
    const changeId = 'promotion-reader-snapshot';
    const changesRoot = path.join(repositoryRoot, 'openspec/changes');
    fs.mkdirSync(path.join(changesRoot, changeId), { recursive: true });
    const moduleUrl = new URL(
      '../src/composition-root/work-registry-production.ts',
      import.meta.url,
    ).href;
    const readerAttempts: number[] = [];
    const runCompositeRead = async <T>(
      name: string,
      operation: (afterItemSnapshot: () => void) => T,
    ): Promise<T> => {
      const conflictMarker = path.join(repositoryRoot, `.${name}-conflict`);
      const originMarker = path.join(repositoryRoot, `.${name}-origin`);
      const releaseMarker = path.join(repositoryRoot, `.${name}-release`);
      let writerExit: Promise<number | null> | undefined;
      let writerStderr = '';
      let observedSplitState = false;
      const afterItemSnapshot = (): void => {
        const writerSource = `
          import fs from 'node:fs';
          const { promoteWorkItem } = await import(${JSON.stringify(moduleUrl)});
          try {
            promoteWorkItem(
              ${JSON.stringify(repositoryRoot)},
              ${JSON.stringify(accepted.id)},
              ${JSON.stringify(changeId)},
              () => '2026-08-24T03:40:00.000Z',
              ${JSON.stringify(workItemDigest(accepted))},
              {
                afterOriginPublished() {
                  fs.writeFileSync(${JSON.stringify(originMarker)}, 'origin');
                  const waitArray = new Int32Array(new SharedArrayBuffer(4));
                  while (!fs.existsSync(${JSON.stringify(releaseMarker)})) {
                    Atomics.wait(waitArray, 0, 0, 10);
                  }
                },
              },
            );
            process.exit(0);
          } catch (error) {
            if (error?.code === 'WORK_REGISTRY_TRANSACTION_CONFLICT') {
              fs.writeFileSync(${JSON.stringify(conflictMarker)}, 'conflict');
              process.exit(73);
            }
            console.error(error);
            process.exit(74);
          }
        `;
        const writer = spawn(
          process.execPath,
          [
            '--experimental-strip-types',
            '--input-type=module',
            '--eval',
            writerSource,
          ],
          { cwd: repositoryRoot },
        );
        writer.stderr.on('data', (chunk) => {
          writerStderr += String(chunk);
        });
        writerExit = new Promise((resolve) => writer.once('close', resolve));
        const waitArray = new Int32Array(new SharedArrayBuffer(4));
        const deadline = Date.now() + 10_000;
        while (
          !fs.existsSync(conflictMarker) &&
          !fs.existsSync(originMarker) &&
          Date.now() < deadline
        ) {
          Atomics.wait(waitArray, 0, 0, 10);
        }
        if (fs.existsSync(originMarker)) {
          observedSplitState = true;
          try {
            assert.equal(
              (
                JSON.parse(
                  fs.readFileSync(
                    path.join(repositoryRoot, created.relativePath),
                    'utf8',
                  ),
                ) as { stage: string }
              ).stage,
              'backlog',
            );
            assert.equal(
              fs.existsSync(path.join(changesRoot, changeId, 'origin.json')),
              true,
            );
          } finally {
            fs.writeFileSync(releaseMarker, 'release');
          }
          return;
        }
        if (!fs.existsSync(conflictMarker)) {
          writer.kill('SIGKILL');
          throw new Error('Concurrent promotion did not reach a test cut.');
        }
      };
      let result: T | undefined;
      let operationError: unknown;
      try {
        result = operation(afterItemSnapshot);
      } catch (error) {
        operationError = error;
      }
      assert.ok(writerExit);
      const exitCode = await writerExit;
      for (const marker of [conflictMarker, originMarker, releaseMarker]) {
        fs.rmSync(marker, { force: true });
      }
      if (operationError !== undefined) throw operationError;
      readerAttempts.push(exitCode ?? -1);
      assert.equal(exitCode, 73, writerStderr);
      assert.equal(observedSplitState, false);
      return result!;
    };

    assert.deepEqual(
      await runCompositeRead('validate-reader', (afterItemSnapshot) =>
        validateWorkRegistry(repositoryRoot, { afterItemSnapshot }),
      ),
      { itemCount: 1, sourceCount: 0 },
    );
    assert.deepEqual(
      await runCompositeRead('trace-reader', (afterItemSnapshot) =>
        traceWorkItem(repositoryRoot, accepted.id, { afterItemSnapshot }),
      ),
      { item: accepted, origins: [], sources: [] },
    );
    assert.deepEqual(readerAttempts, [73, 73]);
    assert.equal(
      fs.existsSync(path.join(changesRoot, changeId, 'origin.json')),
      false,
    );
    assert.equal(showWorkItem(repositoryRoot, accepted.id).stage, 'backlog');
  } finally {
    fs.rmSync(repositoryRoot, { recursive: true, force: true });
  }
});

test('Work Item promotion resumes durable rollback after hard crashes in either tracked file', () => {
  const moduleUrl = new URL(
    '../src/composition-root/work-registry-production.ts',
    import.meta.url,
  ).href;
  const cases = [
    {
      name: 'origin',
      workItemId: 'WORK-01K39R0V00000000000000000P',
      failHook: 'afterOriginPublished',
      crashHook: 'afterOriginRollbackCaptured',
    },
    {
      name: 'item',
      workItemId: 'WORK-01K39R0V00000000000000000Q',
      failHook: 'afterItemPublished',
      crashHook: 'afterItemRollbackCaptured',
    },
  ] as const;

  for (const [index, rollbackCase] of cases.entries()) {
    const repositoryRoot = fs.mkdtempSync(
      path.join(
        os.tmpdir(),
        `jigwright-work-promotion-rollback-${rollbackCase.name}-`,
      ),
    );
    configureRepositoryConsumer(repositoryRoot);
    try {
      runGitForTest(repositoryRoot, ['init', '-b', 'main']);
      const changeId = `rollback-${rollbackCase.name}`;
      const created = createWorkItem(
        repositoryRoot,
        {
          schemaVersion: 1,
          kind: 'feature',
          lane: 'next',
          title: `Recover ${rollbackCase.name} rollback`,
          summary: 'Resume the durable rollback direction after process loss.',
          sourceRefs: [],
        },
        {
          now: () => `2026-08-24T03:5${index}:00.000Z`,
          createId: () => rollbackCase.workItemId,
        },
      );
      const accepted = applyWorkItemReview(
        repositoryRoot,
        created.item.id,
        {
          action: 'accept',
          expectedDigest: workItemDigest(created.item),
          summary: created.item.interpretation.summary,
        },
        () => `2026-08-24T03:5${index}:30.000Z`,
      );
      const changeDirectory = path.join(
        repositoryRoot,
        'openspec/changes',
        changeId,
      );
      fs.mkdirSync(changeDirectory, { recursive: true });
      const itemPath = path.join(repositoryRoot, created.relativePath);
      const itemBefore = fs.readFileSync(itemPath, 'utf8');
      const originPath = path.join(changeDirectory, 'origin.json');
      const childSource = `
        const { promoteWorkItem } = await import(${JSON.stringify(moduleUrl)});
        promoteWorkItem(
          ${JSON.stringify(repositoryRoot)},
          ${JSON.stringify(accepted.id)},
          ${JSON.stringify(changeId)},
          () => ${JSON.stringify(`2026-08-24T03:5${index}:45.000Z`)},
          ${JSON.stringify(workItemDigest(accepted))},
          {
            ${rollbackCase.failHook}() { throw new Error('force rollback'); },
            ${rollbackCase.crashHook}() { process.exit(87); },
          },
        );
      `;
      const crashed = spawnSync(
        process.execPath,
        [
          '--experimental-strip-types',
          '--input-type=module',
          '--eval',
          childSource,
        ],
        { cwd: repositoryRoot, encoding: 'utf8' },
      );
      assert.equal(
        crashed.status,
        87,
        `${rollbackCase.name}: ${crashed.stderr || crashed.stdout}`,
      );
      const journalRoot = path.join(
        repositoryRoot,
        '.git/workflow-engine/work-registry/promotion-journals',
      );
      assert.deepEqual(
        fs
          .readdirSync(journalRoot)
          .map((entry) =>
            entry.replace(/^sha256-[0-9a-f]{64}/, 'sha256-<digest>'),
          ),
        ['sha256-<digest>.rollback.json'],
      );
      const concurrentOrigin = `${canonicalJson({
        schemaVersion: 1,
        sourceRefs: [],
        workItemRefs: [],
      })}\n`;
      if (rollbackCase.name === 'origin') {
        assert.equal(fs.existsSync(originPath), false);
        fs.writeFileSync(originPath, concurrentOrigin, {
          encoding: 'utf8',
          mode: 0o644,
        });
      }

      assert.deepEqual(validateWorkRegistry(repositoryRoot), {
        itemCount: 1,
        sourceCount: 0,
      });
      assert.equal(fs.readFileSync(itemPath, 'utf8'), itemBefore);
      assert.equal(showWorkItem(repositoryRoot, accepted.id).stage, 'backlog');
      if (rollbackCase.name === 'origin') {
        assert.equal(fs.readFileSync(originPath, 'utf8'), concurrentOrigin);
      } else {
        assert.equal(fs.existsSync(originPath), false);
      }
      assert.deepEqual(fs.readdirSync(journalRoot), []);

      const retried = promoteWorkItem(
        repositoryRoot,
        accepted.id,
        changeId,
        () => `2026-08-24T03:5${index}:50.000Z`,
        workItemDigest(accepted),
      );
      assert.equal(retried.item.stage, 'active');
      assert.equal(fs.existsSync(originPath), true);
    } finally {
      fs.rmSync(repositoryRoot, { recursive: true, force: true });
    }
  }
});

test('Work Item promotion CAS preserves a concurrent canonical origin update after origin publication', () => {
  const repositoryRoot = fs.mkdtempSync(
    path.join(os.tmpdir(), 'jigwright-work-promotion-cas-'),
  );
  const externalRoot = fs.mkdtempSync(
    path.join(os.tmpdir(), 'jigwright-work-promotion-external-'),
  );
  configureRepositoryConsumer(repositoryRoot);
  try {
    runGitForTest(repositoryRoot, ['init', '-b', 'main']);
    const source = captureGovernanceSource(repositoryRoot, {
      semanticAuthor: 'maintainer',
      capturedBy: 'jigwright',
      capturedAt: '2026-08-24T03:40:00.000Z',
      contextRef: 'direct-human:thread/work-promotion-cas',
      text: 'Preserve this concurrent canonical origin citation.\n',
      supersedes: null,
    }).source;
    const created = createWorkItem(
      repositoryRoot,
      {
        schemaVersion: 1,
        kind: 'feature',
        lane: 'next',
        title: 'Preserve concurrent origin facts',
        summary: 'Use exact compare-and-swap for promotion provenance.',
        sourceRefs: [],
      },
      {
        now: () => '2026-08-24T03:41:00.000Z',
        createId: () => 'WORK-01K39R0V000000000000000009',
      },
    );
    const accepted = applyWorkItemReview(
      repositoryRoot,
      created.item.id,
      {
        action: 'accept',
        expectedDigest: workItemDigest(created.item),
        summary: created.item.interpretation.summary,
      },
      () => '2026-08-24T03:41:30.000Z',
    );
    const changeDirectory = path.join(
      repositoryRoot,
      'openspec/changes/promotion-cas',
    );
    fs.mkdirSync(changeDirectory, { recursive: true });
    const originPath = path.join(changeDirectory, 'origin.json');
    const concurrentOrigin = `${canonicalJson({
      schemaVersion: 1,
      sourceRefs: [source.id],
      workItemRefs: [],
    })}\n`;

    assert.throws(
      () =>
        promoteWorkItem(
          repositoryRoot,
          accepted.id,
          'promotion-cas',
          () => '2026-08-24T03:42:00.000Z',
          workItemDigest(accepted),
          {
            afterOriginPublished() {
              fs.writeFileSync(originPath, concurrentOrigin, {
                encoding: 'utf8',
                mode: 0o644,
              });
            },
          },
        ),
      hasCode('WORK_REGISTRY_TRANSACTION_CONFLICT'),
    );
    assert.equal(fs.readFileSync(originPath, 'utf8'), concurrentOrigin);
    assert.deepEqual(showWorkItem(repositoryRoot, accepted.id), accepted);

    const promoted = promoteWorkItem(
      repositoryRoot,
      accepted.id,
      'promotion-cas',
      () => '2026-08-24T03:42:30.000Z',
      workItemDigest(accepted),
    );
    assert.equal(promoted.item.stage, 'active');
    assert.deepEqual(JSON.parse(fs.readFileSync(originPath, 'utf8')), {
      schemaVersion: 1,
      sourceRefs: [source.id],
      workItemRefs: [accepted.id],
    });

    const capabilityCreated = createWorkItem(
      repositoryRoot,
      {
        schemaVersion: 1,
        kind: 'feature',
        lane: 'next',
        title: 'Hold the exact origin parent capability',
        summary: 'Never follow a replacement ancestor during durable replay.',
        sourceRefs: [],
      },
      {
        now: () => '2026-08-24T03:43:00.000Z',
        createId: () => 'WORK-01K39R0V00000000000000000A',
      },
    );
    const capabilityAccepted = applyWorkItemReview(
      repositoryRoot,
      capabilityCreated.item.id,
      {
        action: 'accept',
        expectedDigest: workItemDigest(capabilityCreated.item),
        summary: capabilityCreated.item.interpretation.summary,
      },
      () => '2026-08-24T03:43:30.000Z',
    );
    const capabilityChangeDirectory = path.join(
      repositoryRoot,
      'openspec/changes/promotion-parent-capability',
    );
    const displacedChangeDirectory = path.join(
      externalRoot,
      'promotion-parent-capability',
    );
    fs.mkdirSync(capabilityChangeDirectory, { recursive: true });
    const capabilityItemPath = path.join(
      repositoryRoot,
      capabilityCreated.relativePath,
    );
    const capabilityItemBefore = fs.readFileSync(capabilityItemPath, 'utf8');

    assert.throws(
      () =>
        promoteWorkItem(
          repositoryRoot,
          capabilityAccepted.id,
          'promotion-parent-capability',
          () => '2026-08-24T03:44:00.000Z',
          workItemDigest(capabilityAccepted),
          {
            afterOriginParentCapabilityAcquired() {
              fs.renameSync(
                capabilityChangeDirectory,
                displacedChangeDirectory,
              );
              fs.symlinkSync(
                externalRoot,
                capabilityChangeDirectory,
                process.platform === 'win32' ? 'junction' : 'dir',
              );
            },
          },
        ),
      hasCode('WORK_REGISTRY_TRANSACTION_INVALID'),
    );
    assert.equal(
      fs.readFileSync(capabilityItemPath, 'utf8'),
      capabilityItemBefore,
    );
    assert.equal(
      fs.existsSync(path.join(displacedChangeDirectory, 'origin.json')),
      false,
    );
    assert.equal(fs.existsSync(path.join(externalRoot, 'origin.json')), false);
    fs.unlinkSync(capabilityChangeDirectory);
    fs.renameSync(displacedChangeDirectory, capabilityChangeDirectory);
    assert.deepEqual(validateWorkRegistry(repositoryRoot), {
      itemCount: 2,
      sourceCount: 1,
    });
    assert.equal(
      showWorkItem(repositoryRoot, capabilityAccepted.id).stage,
      'backlog',
    );
    assert.equal(
      fs.existsSync(path.join(capabilityChangeDirectory, 'origin.json')),
      false,
    );
    assert.equal(fs.existsSync(path.join(externalRoot, 'origin.json')), false);
    const capabilityRetried = promoteWorkItem(
      repositoryRoot,
      capabilityAccepted.id,
      'promotion-parent-capability',
      () => '2026-08-24T03:44:30.000Z',
      workItemDigest(capabilityAccepted),
    );
    assert.equal(capabilityRetried.item.stage, 'active');
    assert.equal(
      fs.existsSync(path.join(capabilityChangeDirectory, 'origin.json')),
      true,
    );
  } finally {
    fs.rmSync(repositoryRoot, { recursive: true, force: true });
    fs.rmSync(externalRoot, { recursive: true, force: true });
  }
});
