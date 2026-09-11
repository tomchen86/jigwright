/** Canonical role independence data; parsing and effects stay with their existing implementation. */

export type IndependenceDimension =
  | 'provider-independent'
  | 'principal-independent'
  | 'session-independent'
  | 'none';

export const COLLABORATION_GRANT_AUTHORIZED_EFFECT =
  'role-independence-degradation-only' as const;

export type CollaborationDegradedForm =
  'same-provider-fresh-session' | 'caller-supplied' | 'direct-human-review';
