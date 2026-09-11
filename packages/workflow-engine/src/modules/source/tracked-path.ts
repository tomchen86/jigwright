/** Mutable tracked path observations and exact skip reasons. */
export type TrackedTreePathIdentity = {
  rawBase64: string;
  utf8: string | null;
};

export type TrackedTreeSkipReason =
  | 'symlink'
  | 'submodule'
  | 'binary'
  | 'invalid-utf8'
  | 'oversize'
  | 'sensitive-path'
  | 'sensitive-suppressed'
  | 'total-budget'
  | 'unsupported';
