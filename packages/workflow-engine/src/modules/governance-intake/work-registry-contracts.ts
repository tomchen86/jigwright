/** Canonical Work Item, origin, promotion and transition-policy values shared by rules and storage. */
export type WorkItemKindV1 =
  'feature' | 'bug' | 'improvement' | 'chore' | 'research';

export type WorkItemLaneV1 = 'now' | 'next' | 'later' | 'icebox' | null;

export type WorkItemStageV1 = 'inbox' | 'backlog' | 'active' | 'closed';

export type WorkItemAuthoringV1 = Readonly<{
  schemaVersion: 1;
  kind: WorkItemKindV1;
  lane: WorkItemLaneV1;
  title: string;
  summary: string;
  sourceRefs: readonly string[];
}>;

export type WorkItemV1 = Readonly<{
  schemaVersion: 1;
  id: `WORK-${string}`;
  createdAt: string;
  kind: WorkItemKindV1;
  stage: WorkItemStageV1;
  lane: WorkItemLaneV1;
  title: string;
  interpretation: Readonly<{
    summary: string;
    status: 'agent-derived' | 'maintainer-confirmed';
  }>;
  aliases: readonly string[];
  sourceRefs: readonly `SRC-${string}`[];
  blockedBy: readonly `WORK-${string}`[];
  changeRefs: readonly string[];
  timeline: readonly Readonly<{
    at: string;
    event: 'created' | 'accepted' | 'prioritized' | 'promoted' | 'closed';
    changeId: string | null;
  }>[];
  closure: null | Readonly<{
    at: string;
    outcome: 'delivered' | 'declined' | 'duplicate' | 'obsolete';
    changeId: string | null;
  }>;
}>;

export type WorkItemReviewV1 =
  | Readonly<{
      action: 'accept';
      expectedDigest: string;
      summary: string;
    }>
  | Readonly<{
      action: 'prioritize';
      expectedDigest: string;
      lane: Exclude<WorkItemLaneV1, null>;
      blockedBy: readonly string[];
    }>
  | Readonly<{
      action: 'decline';
      expectedDigest: string;
      outcome: 'declined' | 'duplicate' | 'obsolete';
    }>;

export type ChangeOriginV1 = Readonly<{
  schemaVersion: 1;
  sourceRefs: readonly `SRC-${string}`[];
  workItemRefs: readonly `WORK-${string}`[];
}>;

export type WorkItemPromotionSurveyDeclarationV1 = Readonly<{
  schemaVersion: 1;
  symbols: readonly string[];
  emptyReason: string | null;
}>;

export type WorkItemPromotionSurveyV1 = Readonly<{
  schemaVersion: 1;
  workItemId: `WORK-${string}`;
  changeId: string;
  surveyedCommit: string;
  symbols: readonly Readonly<{
    symbol: string;
    consumerPaths: readonly string[];
  }>[];
  emptyReason: string | null;
}>;

export type WorkItemPromotionSurveyBindingV1 =
  | Readonly<{
      schemaVersion: 1;
      kind: 'current-survey';
      digest: `sha256:${string}`;
    }>
  | Readonly<{
      schemaVersion: 1;
      kind: 'not-required';
      reason: 'pure-maintainer-sources';
      sourceRefsDigest: `sha256:${string}`;
    }>;

export type WorkItemPromotionChangeEntryV1 =
  | Readonly<{
      path: string;
      kind: 'directory';
      mode: number;
    }>
  | Readonly<{
      path: string;
      kind: 'file';
      mode: number;
      digest: `sha256:${string}`;
    }>;

export type WorkItemPromotionPreparationBindingV1 = Readonly<{
  schemaVersion: 1;
  changeTarget:
    | Readonly<{ kind: 'absent-change' }>
    | Readonly<{
        kind: 'existing-change';
        directoryMode: number;
        entries: readonly WorkItemPromotionChangeEntryV1[];
        originDigest: `sha256:${string}` | null;
      }>;
  sourceRefsDigest: `sha256:${string}`;
  surveyPreparation:
    | Readonly<{
        kind: 'current-survey';
        binding: Extract<
          WorkItemPromotionSurveyBindingV1,
          { kind: 'current-survey' }
        >;
      }>
    | Readonly<{
        kind: 'not-required';
        binding: Extract<
          WorkItemPromotionSurveyBindingV1,
          { kind: 'not-required' }
        >;
      }>
    | Readonly<{
        kind: 'create-current-survey';
        binding: Extract<
          WorkItemPromotionSurveyBindingV1,
          { kind: 'current-survey' }
        >;
        survey: WorkItemPromotionSurveyV1;
      }>;
}>;

export type WorkItemPriorityRecommendationV1 = Readonly<{
  workItemId: `WORK-${string}`;
  currentLane: WorkItemLaneV1;
  suggestedLane: WorkItemLaneV1;
  reasons: readonly string[];
}>;

export type WorkRegistryInventoryV1 = Readonly<{
  schemaVersion: 1;
  itemCount: number;
  sourceCount: number;
  items: readonly Readonly<{
    id: `WORK-${string}`;
    title: string;
    stage: WorkItemStageV1;
    lane: WorkItemLaneV1;
    aliases: readonly string[];
    blockedBy: readonly `WORK-${string}`[];
  }>[];
  stages: Readonly<Record<WorkItemStageV1, number>>;
  lanes: Readonly<
    Record<Exclude<WorkItemLaneV1, null> | 'unprioritized', number>
  >;
  currentItemIds: readonly `WORK-${string}`[];
  blockedItemIds: readonly `WORK-${string}`[];
}>;

export type WorkRegistryGovernedTransition =
  'intake' | 'prioritize' | 'promote';

export type WorkItemPromotionGrantBindingV1 = Readonly<{
  schemaVersion: 1;
  challengeId: string;
  operationId: string;
  approvalSubjectDigest: `sha256:${string}`;
  surveyBinding: WorkItemPromotionSurveyBindingV1;
}>;

export type WorkRegistryTransitionPolicyV1 = Readonly<{
  schemaVersion: 1;
  transitions: Readonly<
    Record<WorkRegistryGovernedTransition, 'ordinary' | 'central-grant'>
  >;
}>;

export type WorkRegistryGrantRequiredDetailsV1 =
  | Readonly<{
      schemaVersion: 1;
      kind: 'work-registry-grant-required.v1';
      operation: 'review';
      transition: 'intake' | 'prioritize';
      workItemId: string;
      review: WorkItemReviewV1;
    }>
  | Readonly<{
      schemaVersion: 1;
      kind: 'work-registry-grant-required.v1';
      operation: 'promote';
      transition: 'promote';
      workItemId: string;
      changeId: string;
      expectedDigest: string;
    }>;

export type WorkItemPromotionTestHooks = Readonly<{
  /** Test-only hard-crash cut after durable intent and before tracked writes. */
  afterJournalPersisted?: () => void;
  /** Test-only ancestor swap after initial origin-parent validation. */
  afterOriginParentCapabilityAcquired?: () => void;
  /** Test-only hard-crash cut after origin publication and before item CAS. */
  afterOriginPublished?: () => void;
  /** Test-only hard-crash cut after both tracked writes and before cleanup. */
  afterItemPublished?: () => void;
  /** Test-only hard-crash cut after origin rollback captured prior bytes. */
  afterOriginRollbackCaptured?: () => void;
  /** Test-only hard-crash cut after item rollback captured prior bytes. */
  afterItemRollbackCaptured?: () => void;
  /** Test-only crash cut after tracked commit and durable journal cleanup. */
  afterTransactionCommitted?: () => void;
}>;

/** Observe a current origin through the registry validation and recovery boundary. */
export type CurrentChangeOriginReader = (
  root: string,
  changeId: string,
) => ChangeOriginV1 | null;

/** Registry operations required to prepare a change from an exact Source. */
export type WorkRegistryChangePreparation = Readonly<{
  ensureWorkItemPromotionChangeDirectory(
    repositoryRoot: string,
    changeId: string,
  ): string;
  linkSourceToChange(
    repositoryRoot: string,
    sourceId: string,
    changeId: string,
  ): {
    origin: ChangeOriginV1;
    originPath: string;
    created: boolean;
  };
  readCurrentChangeOrigin: CurrentChangeOriginReader;
}>;

/** Reconcile archived registry items at the caller's exact archive timestamp. */
export type ArchivedWorkItemReconciler = (
  repositoryRoot: string,
  changeId: string,
  archivedChangeRoot: string,
  closedAt: string,
) => { closedItemIds: string[]; outputPaths: string[] };
