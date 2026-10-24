/** Canonical role independence data; parsing and effects stay with their existing implementation. */

export type IndependenceDimension =
  | 'provider-independent'
  | 'principal-independent'
  | 'session-independent'
  | 'none';
