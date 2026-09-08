import assert from 'node:assert/strict';
import fs from 'node:fs';
import test from 'node:test';

import { renderAgentGuidanceRules } from '../src/modules/guidance/catalog/agent-rule-registry.ts';
import { renderAgentRuleSources } from '../../../scripts/generate-agent-rule-sources.ts';
import { createGovernanceSourceV1 } from '@jigwright/core/governance-source';

test('agent rules are generated from current purpose, exact-text and command sources', () => {
  const root = new URL('../../../', import.meta.url);
  const expected = renderAgentRuleSources(
    fs.readFileSync(new URL('AGENTS.md', root), 'utf8'),
  );
  assert.equal(
    fs.readFileSync(
      new URL(
        'packages/workflow-engine/src/modules/guidance/catalog/agent-rule-sources.ts',
        root,
      ),
      'utf8',
    ),
    expected,
  );
  const rules = renderAgentGuidanceRules();
  assert.equal(
    rules.split('\n').filter((line) => line.startsWith('- ')).length,
    4,
  );
  assert.match(rules, /originalText/);
  assert.match(rules, /Finding/);
  assert.match(rules, /active task/);
  assert.match(rules, /pnpm workflow guide/);
  const text = '  使用者原話\r\n逐字保留\n';
  const source = createGovernanceSourceV1({
    semanticAuthor: 'agent',
    capturedBy: 'test',
    capturedAt: '2026-09-08T00:00:00.000Z',
    contextRef: 'test:guidance',
    text,
    supersedes: null,
  });
  assert.equal(source.text, text);
  const quoted = renderAgentRuleSources(
    "### Product purpose\n\nJigwright is the owner's coding harness.\n\nSecurity governance is supporting infrastructure.\n\n### Trust model",
  );
  assert.match(quoted, /"Jigwright is the owner's coding harness\./);
});
