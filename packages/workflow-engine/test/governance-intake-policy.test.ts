import assert from 'node:assert/strict';
import test from 'node:test';
import { canonicalJson } from '@jigwright/core/canonical-json';
import { createGovernanceSourceServices } from '../src/modules/governance-intake/governance-sources.ts';
import { createGovernanceFindingServices } from '../src/application/governance-intake/governance-findings.ts';
import {
  parseGovernanceSourceBytes,
  type GovernanceFindingContextV1,
} from '../src/modules/governance-intake/governance-intake.ts';
import { projectGovernanceFindings } from '../src/modules/governance-intake/governance-findings.ts';
import type { GovernanceSourceV1 } from '@jigwright/core/governance-source';

const timestamp = '2026-09-12T00:00:00.000Z';
const context: GovernanceFindingContextV1 = {
  repositoryRoot: '/repository',
  runtimeRoot: '/runtime',
  sessionId: 'session-one',
  changeId: 'one',
  branch: 'work/one',
  head: 'a'.repeat(40),
  tree: 'b'.repeat(40),
};
function fixture() {
  const sources = new Map<string, GovernanceSourceV1>(),
    records = new Map<string, Buffer>(),
    events: string[] = [];
  const sourceServices = createGovernanceSourceServices({
    readSource(_root, id) {
      events.push('source:' + id);
      const value = sources.get(id);
      if (!value) throw new Error('missing Source');
      return value;
    },
    listSources() {
      return [...sources.values()];
    },
    readAliases() {
      return {
        requirement: { title: 'Requirement', sourceRefs: [...sources.keys()] },
      };
    },
    publishSource(_root, source) {
      events.push('capture');
      if (sources.has(source.id)) return false;
      sources.set(source.id, source);
      return true;
    },
  });
  let publishOverride: ((path: string, bytes: Buffer) => boolean) | undefined;
  const findings = createGovernanceFindingServices({
    readGovernanceSource: sourceServices.readGovernanceSource,
    findingRef: {
      readFindingRef() {
        events.push('read');
        return { records: new Map(records) };
      },
      publishFindingRefRecord(_root, path, bytes) {
        events.push('publish');
        if (publishOverride) return publishOverride(path, bytes);
        const old = records.get(path);
        if (old && !old.equals(bytes)) throw new Error('collision');
        records.set(path, bytes);
        return old === undefined;
      },
    },
  });
  const capture = (
    text = '  原文\r\nsecond line  \n',
    supersedes: `SRC-${string}` | null = null,
  ) =>
    sourceServices.captureGovernanceSource('/repository', {
      semanticAuthor: 'maintainer',
      capturedBy: 'test',
      capturedAt: timestamp,
      contextRef: 'direct-human:test',
      text,
      supersedes,
    });
  const record = (sourceRefs: readonly string[] = []) =>
    findings.recordGovernanceFinding(
      context,
      { schemaVersion: 1, text: '  Finding\r\nverbatim  \n', sourceRefs },
      () => timestamp,
    );
  return {
    sources,
    records,
    events,
    sourceServices,
    findings,
    capture,
    record,
    setPublisher(value: typeof publishOverride) {
      publishOverride = value;
    },
  };
}

test('Source capture checks superseded identity before publication and retains exact wording', () => {
  const f = fixture(),
    original = f.capture();
  assert.equal(f.capture().created, false);
  f.events.length = 0;
  const correction = f.capture(' corrected \n', original.source.id);
  assert.deepEqual(f.events, ['source:' + original.source.id, 'capture']);
  assert.equal(correction.source.supersedes, original.source.id);
  f.events.length = 0;
  assert.throws(
    () => f.capture('bad', `SRC-${'0'.repeat(64)}`),
    /missing Source/,
  );
  assert.equal(f.events.includes('capture'), false);
  assert.equal(
    f.sourceServices.resolveGovernanceSourceAlias(
      '/repository',
      'requirement',
    )[0]!.text,
    original.source.text,
  );
  assert.throws(
    () =>
      f.sourceServices.resolveGovernanceSourceAlias('/repository', 'missing'),
    /Unknown Source alias/,
  );
});

test('Source byte admission rejects noncanonical identity, JSON whitespace and invalid UTF-8', () => {
  const { source } = fixture().capture();
  const bytes = Buffer.from(`${canonicalJson(source)}\n`);
  assert.deepEqual(parseGovernanceSourceBytes(bytes, source.id), source);
  assert.throws(
    () => parseGovernanceSourceBytes(bytes, `SRC-${'0'.repeat(64)}`),
    /canonical bytes/,
  );
  assert.throws(
    () =>
      parseGovernanceSourceBytes(
        Buffer.from(JSON.stringify(source)),
        source.id,
      ),
    /canonical bytes/,
  );
  assert.throws(
    () =>
      parseGovernanceSourceBytes(
        Buffer.concat([bytes, Buffer.from([0xff])]),
        source.id,
      ),
    /invalid/,
  );
});

test('Finding capture reads Sources before clock and store, preserving canonical identity and bytes', () => {
  const f = fixture(),
    source = f.capture().source;
  f.events.length = 0;
  const captured = f.findings.recordGovernanceFinding(
    context,
    { schemaVersion: 1, text: ' \r\nexact  ', sourceRefs: [source.id] },
    () => {
      f.events.push('clock');
      return timestamp;
    },
  );
  assert.deepEqual(f.events, [
    'source:' + source.id,
    'clock',
    'read',
    'publish',
  ]);
  assert.equal(captured.finding.text, ' \r\nexact  ');
  assert.equal(
    [...f.records.values()][0]!.toString(),
    `${canonicalJson(captured.finding)}\n`,
  );
  assert.equal(
    f.findings.listGovernanceFindings('/runtime')[0]!.disposition,
    'pending',
  );
  f.events.length = 0;
  assert.throws(() => f.record([source.id, source.id]), /duplicated/);
  assert.deepEqual(f.events, []);
});

test('Finding terminal disposition replays without reading clock or replacing history', () => {
  const f = fixture(),
    finding = f.record().finding;
  const first = f.findings.dismissGovernanceFinding(
    '/runtime',
    finding.id,
    ' Keep exact reason ',
    () => timestamp,
  );
  assert.equal(first.created, true);
  const before = [...f.records].map(([p, b]) => [p, b.toString()]);
  assert.equal(
    f.findings.dismissGovernanceFinding(
      '/runtime',
      finding.id,
      ' Keep exact reason ',
      () => {
        throw new Error('clock must not run');
      },
    ).created,
    false,
  );
  assert.throws(
    () =>
      f.findings.dismissGovernanceFinding('/runtime', finding.id, 'different'),
    /different terminal/,
  );
  assert.deepEqual(
    [...f.records].map(([p, b]) => [p, b.toString()]),
    before,
  );
});

test('Finding CAS races accept an identical decision with a different timestamp and reject conflicting decisions', () => {
  const f = fixture(),
    finding = f.record().finding;
  f.setPublisher((path, bytes) => {
    const receipt = JSON.parse(bytes.toString());
    receipt.recordedAt = '2026-09-12T00:00:01.000Z';
    f.records.set(path, Buffer.from(`${canonicalJson(receipt)}\n`));
    throw new Error('CAS race');
  });
  const result = f.findings.dismissGovernanceFinding(
    '/runtime',
    finding.id,
    'reason',
    () => timestamp,
  );
  assert.equal(result.created, false);
  assert.equal(result.finding.disposedAt, '2026-09-12T00:00:01.000Z');
  const g = fixture(),
    other = g.record().finding;
  g.setPublisher((path, bytes) => {
    const receipt = JSON.parse(bytes.toString());
    receipt.reason = 'competing';
    g.records.set(path, Buffer.from(`${canonicalJson(receipt)}\n`));
    throw new Error('CAS race');
  });
  assert.throws(
    () =>
      g.findings.dismissGovernanceFinding(
        '/runtime',
        other.id,
        'reason',
        () => timestamp,
      ),
    /CAS race/,
  );
});

test('Finding projection rejects mismatched sessions, orphan receipts, noncanonical bytes and timestamps before capture', () => {
  const f = fixture(),
    finding = f.record().finding;
  const [[recordPath, bytes]] = [...f.records] as [[string, Buffer]];
  assert.throws(
    () =>
      projectGovernanceFindings(
        new Map([[recordPath.replace('session-one', 'session-two'), bytes]]),
      ),
    /session and path/,
  );
  assert.throws(
    () =>
      projectGovernanceFindings(
        new Map([[recordPath, Buffer.from(bytes.toString().trim())]]),
      ),
    /canonical bytes/,
  );
  assert.throws(
    () =>
      f.findings.dismissGovernanceFinding(
        '/runtime',
        finding.id,
        'reason',
        () => '2026-09-11T00:00:00.000Z',
      ),
    /predates/,
  );
  f.findings.dismissGovernanceFinding(
    '/runtime',
    finding.id,
    'reason',
    () => timestamp,
  );
  f.records.delete(recordPath);
  assert.throws(
    () => projectGovernanceFindings(f.records),
    /no immutable Finding/,
  );
});
