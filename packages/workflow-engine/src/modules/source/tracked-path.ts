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

/**
 * One enumerated tree entry with preserved object identity. Path identity is raw
 * base64 plus a fatal-UTF-8 display (or null). `objectType` and `byteSize` are
 * the exact Git metadata (`byteSize` is null where Git reports no size, e.g. a
 * submodule gitlink). A regular text blob within the byte maxima and total
 * budget carries `content` plus its `contentSha256`; every other object records
 * the exact skip reason and never exposes bytes.
 */
export type TrackedTreeEntry = {
  path: TrackedTreePathIdentity;
  objectId: string;
  objectType: string;
  mode: string;
  byteSize: number | null;
  content?: Buffer;
  contentSha256?: string;
  skipReason?: TrackedTreeSkipReason;
};
