import crypto from 'node:crypto';
import { canonicalJson } from "../../foundation/canonical-json/canonical-json.js";
export const GLOBAL_PLAN_REVIEW_COVERAGE_POLICY_DIGEST = crypto
    .createHash('sha256')
    .update(canonicalJson({
    schemaVersion: 2,
    kind: 'plan-review-coverage-policy',
    activation: 'global',
    sampling: 'review-coverage.v1',
    evidence: 'namespace-correct-exact-location',
    targetFields: [
        'invariants',
        'risk-factors',
        'freshness',
        'evidence-mode',
        'degraded-extraction',
        'cost-profile',
    ],
}))
    .digest('hex');
