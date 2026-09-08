/**
 * Define persisted provider invocation, reservation, policy, and completion record shapes.
 *
 * Invariants:
 * - Schema versions, field names, unions, and optional fields retain their wire meaning.
 * - Public types remain available through provider-invocation-store.
 *
 * Depends on: provider contracts, execution policy authority, and agent runtime receipts.
 * Failure modes: Shape drift rejects durable records or misrepresents their authority.
 */
export {};
