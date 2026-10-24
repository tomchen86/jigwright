/** A paired Work Item/origin change; journal layout and recovery storage remain private to runtime. */
import type {
  ChangeOriginV1,
  WorkItemPromotionGrantBindingV1,
  WorkItemPromotionTestHooks,
  WorkItemV1,
} from './work-registry-contracts.ts';
import type { WorkItemSourceUpdateV1 } from './work-registry-source-update.ts';
export type WorkItemRecordChange = Readonly<{
  itemPath: string;
  originPath: string;
  itemBefore: string;
  originBefore: string | null;
  item: WorkItemV1;
  origin: ChangeOriginV1;
  grantBinding: WorkItemPromotionGrantBindingV1 | null;
  sourceUpdate?: WorkItemSourceUpdateV1;
}>;
export type WorkItemPromotionResult = Readonly<{
  item: WorkItemV1;
  originPath: string;
}>;
export type WorkRegistryMutation = Readonly<{
  recover(): void;
  replay(
    id: WorkItemV1['id'],
    changeId: string,
    expectedDigest: string | undefined,
    grant: WorkItemPromotionGrantBindingV1 | null,
  ): WorkItemPromotionResult | null;
  hasReceipt(
    id: WorkItemV1['id'],
    changeId: string,
    expectedDigest: string,
    grant: WorkItemPromotionGrantBindingV1,
  ): boolean;
  commit(
    change: WorkItemRecordChange,
    hooks: WorkItemPromotionTestHooks,
  ): WorkItemPromotionResult;
}>;
