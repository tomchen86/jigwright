/** Binds consumer setup to repository storage, host providers and guidance projection. */
import { createConsumerSetupService } from '../application/adoption/consumer-setup.ts';
import { createConsumerSetupStorage } from '../runtime/adoption/consumer-setup-storage.ts';
import {
  guidanceSuggestions,
  installAgentGuidance,
} from './agent-guidance-production.ts';
export {
  configuredJigwrightEnvironment,
  readSetupAnswers,
} from '../runtime/adoption/consumer-setup-storage.ts';
export {
  SETUP_QUESTIONS,
  initError,
} from '../modules/adoption/setup-questions.ts';
export type { Answers } from '../modules/adoption/setup-questions.ts';
export function createConsumerSetup(repositoryRoot: string) {
  const { repository, host } = createConsumerSetupStorage(repositoryRoot);
  return createConsumerSetupService(repository, host, {
    suggestions: () => guidanceSuggestions(repository.root),
    install: (targets, options) =>
      installAgentGuidance(repository.root, targets, options),
  });
}
