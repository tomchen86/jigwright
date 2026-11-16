/** Canonical investigation protocol versions, assurance label, and diagnostic catalogs. */
export const INVESTIGATION_MANIFEST_V3_SCHEMA_VERSION = 3;
export const INVESTIGATION_MANIFEST_V3_KIND = 'manifest-first-investigation';
export const INVESTIGATION_V3_KNOWN_FAILURE_CODES = [
    'SCHEMA_V1_FORBIDDEN',
    'TERM_INTEGRITY_MISMATCH',
    'REPLAY_INPUT_MISSING',
    'REPLAY_CLOSURE_UNSUPPORTED',
    'MANIFEST_UNREPRESENTABLE',
    'RECONSTRUCTION_MISMATCH',
    'SEMANTIC_COMPLETENESS_FAILURE',
    'SOURCE_ANCHOR_UNRESOLVED',
    'REVIEW_TARGET_STALE',
    'PROJECTION_PIPELINE_FORBIDDEN',
    'PUBLICATION_RECOVERY_REQUIRED',
];
export const INVESTIGATION_V3_ATTEMPTED_TRANSITIONS = [
    'build-draft',
    'draft-seal',
    'authority-validation',
    'publication',
];
export const SEMANTIC_ASSURANCE = 'actor-attested-not-engine-verified';
export const INVESTIGATION_ROOT_CANONICALIZATION_VERSION = 'investigation-root-canonicalization.v3';
export const INVESTIGATION_TERM_NORMALIZATION_VERSION = 'investigation-term-v1';
