/**
 * Binds the provider availability pilot runner to production probes,
 * execution and clocks.
 *
 * Invariants:
 * - The runner receives the built-in probe and provider implementation
 *   through a frozen dependency object.
 */
import { builtInProviderAdapters } from './built-in-provider-adapter-production.ts';
import crypto from 'node:crypto';

import { createProviderAvailabilityPilotRunner } from '../runtime/provider-execution/provider-availability-pilot.ts';
import { probeBuiltInProviderFamilyEvidence } from '../runtime/provider-execution/agent-runtime-probe-evidence.ts';
import { runBuiltInProvider } from '../runtime/provider-execution/provider-runner.ts';

export const runProviderAvailabilityPilot =
  createProviderAvailabilityPilotRunner(
    Object.freeze({
      now: () => new Date(),
      randomUUID: () => crypto.randomUUID(),
      probe: probeBuiltInProviderFamilyEvidence.bind(
        undefined,
        builtInProviderAdapters,
      ),
      runProvider: runBuiltInProvider.bind(undefined, builtInProviderAdapters),
    }),
  );

export { verifyProviderAvailabilityPilot } from '../runtime/provider-execution/provider-availability-pilot.ts';
