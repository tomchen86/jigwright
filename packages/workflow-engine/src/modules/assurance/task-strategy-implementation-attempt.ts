/** Interpret an exact effective attempt without reading its durable lineage. */
import type {
  TaskStrategyImplementationReservation,
  TaskStrategyImplementationProviderAttempt,
} from './task-strategy-implementation-record.ts';
import { canonicalJson } from '../../foundation/canonical-json/canonical-json.ts';
import { deepFreeze, sha256 } from './task-strategy-implementation-values.ts';

export function taskStrategyImplementationReservationForAttempt(
  attempt: TaskStrategyImplementationProviderAttempt,
): TaskStrategyImplementationReservation {
  return deepFreeze({
    ...attempt.root,
    assignment: attempt.assignment,
    request: attempt.request,
    authorizationNodeId: attempt.authorizationNodeId,
    reservationNodeId: attempt.reservationNodeId,
    createdAt: attempt.createdAt,
  });
}

export function taskStrategyImplementationProviderAttemptReservationDigest(
  attempt: TaskStrategyImplementationProviderAttempt,
): string {
  return attempt.retryReservation === null
    ? attempt.root.recordDigest
    : sha256(canonicalJson(attempt.retryReservation));
}
