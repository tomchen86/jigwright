/**
 * Exposes atomic text replacement and its safety error to repository
 * transactions.
 *
 * Invariants:
 * - This facade re-exports its defining modules without local wrappers or
 *   duplicate implementations.
 */
export {
  AtomicTextSafetyError,
  replaceTextAtomic,
} from '../../foundation/filesystem/atomic-text.ts';
