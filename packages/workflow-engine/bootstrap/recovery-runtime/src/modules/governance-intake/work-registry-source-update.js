import { boundedText, hasExactKeys, isRecord, registryInvalid, sourceReferences, } from "./work-registry-record.js";
export function parseWorkItemSourceUpdate(value) {
    if (!isRecord(value) ||
        !hasExactKeys(value, ['replaces', 'retainReplacedOrigin', 'sourceRef']) ||
        typeof value.sourceRef !== 'string' ||
        (value.replaces !== null && typeof value.replaces !== 'string') ||
        typeof value.retainReplacedOrigin !== 'boolean')
        throw registryInvalid('Work Item Source update is invalid.');
    const [sourceRef] = sourceReferences([value.sourceRef]);
    const replaces = value.replaces === null ? null : sourceReferences([value.replaces])[0];
    if (sourceRef === replaces ||
        (replaces === null && value.retainReplacedOrigin))
        throw registryInvalid('Work Item Source replacement is invalid.');
    return {
        sourceRef: sourceRef,
        replaces,
        retainReplacedOrigin: value.retainReplacedOrigin,
    };
}
export function projectWorkItemSourceUpdate(item, update) {
    if (item.stage === 'closed' || item.closure !== null)
        throw registryInvalid('A closed Work Item cannot receive a Source.');
    if (update.replaces !== null && !item.sourceRefs.includes(update.replaces)) {
        if (item.sourceRefs.includes(update.sourceRef))
            return item;
        throw registryInvalid('The Source being corrected is not linked to this Work Item.');
    }
    const sourceRefs = sourceReferences([
        ...new Set([
            ...item.sourceRefs.filter((ref) => ref !== update.replaces),
            update.sourceRef,
        ]),
    ]);
    if (JSON.stringify(sourceRefs) === JSON.stringify(item.sourceRefs))
        return item;
    return {
        ...item,
        title: update.replaces !== null &&
            item.title === `Review captured Source ${update.replaces}`
            ? `Review captured Source ${update.sourceRef}`
            : item.title,
        sourceRefs,
        interpretation: {
            summary: update.replaces === null &&
                ['bug', 'chore', 'research'].includes(item.kind)
                ? item.interpretation.summary
                : boundedText(`Interpret and disposition linked Sources: ${sourceRefs.join(', ')}.`, 2_000, 'summary'),
            status: 'agent-derived',
        },
    };
}
export function projectSourceUpdateOrigin(origin, item, update) {
    return {
        schemaVersion: 1,
        sourceRefs: sourceReferences([
            ...new Set([
                ...origin.sourceRefs.filter((ref) => ref !== update.replaces || update.retainReplacedOrigin),
                ...item.sourceRefs,
            ]),
        ]),
        workItemRefs: [...new Set([...origin.workItemRefs, item.id])].sort(),
    };
}
