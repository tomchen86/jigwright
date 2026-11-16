/**
 * Adapts the workflow check loader to the public check registry port.
 *
 * Invariants:
 * - Compile-time checks require bidirectional compatibility with the public
 *   check and registry types.
 */
import type {
  CheckDefinitionV1,
  CheckRegistryV1,
  CheckRegistryPortV1,
} from '@jigwright/core/check-registry-port';

import { loadChecksConfig } from '../../../../runtime/workflow-configuration/workflow-configuration.ts';
import {
  type CheckDefinition,
  type ChecksConfig,
} from '../../../../modules/source/check-command.ts';

type AssertTrue<Value extends true> = Value;
type AssertBidirectionalExact<Left, Right> = [Left] extends [Right]
  ? [Right] extends [Left]
    ? true
    : false
  : false;
type CheckDefinitionContractIsExact = AssertTrue<
  AssertBidirectionalExact<CheckDefinition, CheckDefinitionV1>
>;
type CheckRegistryContractIsExact = AssertTrue<
  AssertBidirectionalExact<ChecksConfig, CheckRegistryV1>
>;

export const workflowCheckRegistryPort: CheckRegistryPortV1 = {
  contractVersion: 'jigwright.check-registry-port.v1',
  load(repositoryRoot: string): CheckRegistryV1 {
    return loadChecksConfig(repositoryRoot);
  },
};
