/**
 * Binds the reviewed provider command shapes the runtime runner executes,
 * and the diagnostics that read them.
 *
 * Invariants:
 * - Every known provider identifier resolves to exactly one reviewed adapter.
 */
import { claudeProviderAdapter } from '../adapters/providers/claude/claude-provider-adapter.ts';
import { codexProviderAdapter } from '../adapters/providers/codex/codex-provider-adapter.ts';
import type { BuiltInProviderAdapterCatalog } from '../modules/provider-orchestration/provider-contracts.ts';
import { evaluateAiAdapter as evaluateAiAdapterWithCatalog } from '../runtime/provider-execution/ai-adapter-evaluation.ts';

export const builtInProviderAdapters: BuiltInProviderAdapterCatalog =
  Object.freeze({
    claude: claudeProviderAdapter,
    codex: codexProviderAdapter,
  });

/** Reports configured provider capabilities against the reviewed catalog. */
export const evaluateAiAdapter = evaluateAiAdapterWithCatalog.bind(
  undefined,
  builtInProviderAdapters,
);
