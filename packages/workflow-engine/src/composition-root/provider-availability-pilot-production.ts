import crypto from 'node:crypto';

import { createProviderAvailabilityPilotRunner } from '../runtime/provider-execution/provider-availability-pilot.ts';
import { probeBuiltInProviderFamilyEvidence } from '../runtime/provider-execution/agent-runtime-probe-evidence.ts';
import { runBuiltInProvider } from '../runtime/provider-execution/provider-runner.ts';

export const runProviderAvailabilityPilot =
  createProviderAvailabilityPilotRunner(
    Object.freeze({
      now: () => new Date(),
      randomUUID: () => crypto.randomUUID(),
      probe: probeBuiltInProviderFamilyEvidence,
      runProvider: runBuiltInProvider,
    }),
  );

export { verifyProviderAvailabilityPilot } from '../runtime/provider-execution/provider-availability-pilot.ts';
