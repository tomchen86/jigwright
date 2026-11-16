/** Required registry facts and durable effects used by write and preparation use cases. */
import type { RepositoryConsumerConfigurationV1 } from '@jigwright/core/repository-consumer-port';
import type {
  ChangeOriginV1,
  WorkItemPromotionPreparationBindingV1,
  WorkItemPromotionSurveyV1,
  WorkItemV1,
} from '../../modules/governance-intake/work-registry-contracts.ts';
import type { WorkRegistryMutation } from '../../modules/governance-intake/work-registry-mutation.ts';
export type WorkRegistryWriteRepository = Readonly<{
  withRegistry<T>(root: string, operation: () => T): T;
  withPromotion<T>(
    root: string,
    operation: (mutation: WorkRegistryMutation) => T,
  ): T;
  layout(root: string): RepositoryConsumerConfigurationV1['workRegistry'];
  resolvePath(root: string, relative: string): string;
  changeDirectory(
    root: string,
    id: string,
    purpose?: 'Promotion' | 'Source linking',
  ): string;
  promotionChangeDirectory(root: string, id: string): string;
  observeChangeTarget(
    directory: string,
  ): WorkItemPromotionPreparationBindingV1['changeTarget'];
  ensureChangeDirectory(root: string, id: string): string;
  currentCommit(root: string): string;
  symbolConsumers(root: string, commit: string, symbol: string): string[];
  createId(timestamp: string): string;
  findItem(root: string, id: string): string;
  readItem(reference: string): WorkItemV1;
  readItemSnapshot(
    reference: string,
  ): Readonly<{ item: WorkItemV1; serialized: string }>;
  createItem(reference: string, item: WorkItemV1): void;
  replaceItem(reference: string, item: WorkItemV1): void;
  writeOrigin(reference: string, origin: ChangeOriginV1): void;
  writeSurvey(reference: string, survey: WorkItemPromotionSurveyV1): void;
  readRecordText(reference: string): string | null;
  readOriginBefore(reference: string, allowMissing: boolean): string | null;
}>;
