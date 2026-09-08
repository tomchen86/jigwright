/** Injected credential-safe AgentRuntime probe evidence for provider availability integration. */
import { builtInProviderDefinitionSnapshotForTest } from './fixture.ts';
import {
  createAgentRuntimeCapabilitiesV1,
  createAgentRuntimeProbeEvidenceV1,
} from '@jigwright/core/agent-runtime-port';

export function executableIdentity(providerId: 'codex' | 'claude') {
  return {
    candidatePath: `/opt/homebrew/bin/${providerId}`,
    realPath: `/opt/homebrew/bin/${providerId}`,
    device: '1',
    inode: providerId === 'codex' ? '11' : '12',
    mode: 0o100755,
    uid: 501,
    gid: 20,
    size: 1024,
    mtimeNs: '1',
    sha256: providerId === 'codex' ? 'c'.repeat(64) : 'd'.repeat(64),
  };
}

export function providerProbeEvidence(
  providerId: 'codex' | 'claude',
  observationClass: 'host-observed' | 'synthetic-fixture',
  status: 'ready' | 'unauthenticated' = 'ready',
) {
  const definition = builtInProviderDefinitionSnapshotForTest(providerId);
  const capabilities = createAgentRuntimeCapabilitiesV1({
    structuredStreaming: true,
    structuredOutput: true,
    resumableAfterTurn: false,
    forkable: false,
    reattachableInFlight: false,
    cancellationAck: true,
    usageReporting: 'none',
  });
  return createAgentRuntimeProbeEvidenceV1({
    authority: 'observation-only',
    observationClass,
    definition: {
      schemaVersion: 1,
      kind: 'built-in-provider-definition.v1',
      providerFamily: providerId,
      protocol: definition.protocol,
      definitionDigest: definition.definitionDigest,
    },
    status,
    executableIdentity: executableIdentity(providerId),
    providerVersion: `${providerId}-fixture-v1`,
    authentication:
      status === 'ready'
        ? observationClass === 'host-observed'
          ? 'authenticated'
          : 'not-observed'
        : 'unauthenticated',
    capabilities,
  });
}
