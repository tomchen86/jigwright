/** Provider progress projection; publication and observation remain in storage. */
import type { AgentRuntimeProcessProgressProjection } from './agent-runtime-port.ts';
/**
 * What the current lease has been observed doing. `not-observed` is the honest
 * answer when nothing published: it means unknown, never "never started".
 */
export type ProviderInvocationActivity = Readonly<{
  state: 'not-observed' | AgentRuntimeProcessProgressProjection['processState'];
  observedAt: string | null;
  staleMs: number | null;
  eventCount: number;
  stdoutBytes: number;
  stderrBytes: number;
}>;
