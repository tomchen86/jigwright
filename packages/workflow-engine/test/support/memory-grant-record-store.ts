import { canonicalJson } from '../../src/foundation/canonical-json/canonical-json.ts';
import {
  challengeUnavailable,
  parseGrantRecord,
  storeUnsafe,
} from '../../src/modules/authority/grant-records.ts';
import {
  createGrantRecordStore,
  type GrantRecordPersistence,
} from '../../src/modules/authority/grant-record-store.ts';

/** A second persistence implementation with actual canonical bytes and CAS. */
export function createMemoryGrantRecordStore(events: string[] = []) {
  const records = new Map<string, string>();
  let initialized = false;
  const persistence: GrantRecordPersistence = {
    initialize() {
      events.push('initialize');
      initialized = true;
    },
    assertAccessible() {
      events.push('accessible');
      if (!initialized) throw storeUnsafe();
    },
    read(challengeId) {
      events.push('read');
      const bytes = records.get(challengeId);
      return bytes === undefined ? null : parseGrantRecord(bytes);
    },
    list() {
      events.push('list');
      return Object.freeze(
        [...records]
          .sort(([left], [right]) => left.localeCompare(right))
          .map(([, bytes]) => parseGrantRecord(bytes)),
      );
    },
    create(challengeId, record) {
      events.push('create');
      if (records.has(challengeId)) throw storeUnsafe();
      records.set(challengeId, `${canonicalJson(record)}\n`);
    },
    replace(challengeId, expected, replacement) {
      events.push(`replace:${replacement.state}`);
      if (records.get(challengeId) !== `${canonicalJson(expected)}\n`) {
        throw challengeUnavailable(challengeId);
      }
      records.set(challengeId, `${canonicalJson(replacement)}\n`);
    },
  };
  return { records, persistence, store: createGrantRecordStore(persistence) };
}
