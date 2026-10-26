import type { FileSearchTerminationReason } from '@caxri/protocol';

import type { Translate } from '../../i18n';
import { formatCount } from '../../lib/locale-format';

export type ProjectSearchDisplayState =
    'empty' | 'error' | 'idle' | 'incomplete' | 'results' | 'searching';

interface ProjectSearchDisplayInput {
    active: boolean;
    settled: boolean;
    fetching: boolean;
    failed: boolean;
    matchCount: number | undefined;
    truncated: boolean | undefined;
    canceled: boolean | undefined;
}

/**
 * Keeps an incomplete Server result distinct from a definitive empty search. A large Project may exhaust a safety bound
 * before reaching a matching file, so rendering that state as "No results" would be a false answer.
 */
export function projectSearchDisplayState({
    active,
    settled,
    fetching,
    failed,
    matchCount,
    truncated,
    canceled,
}: ProjectSearchDisplayInput): ProjectSearchDisplayState {
    if (!active) return 'idle';
    if (!settled) return 'searching';
    if (failed) return 'error';
    if (matchCount === 0 && (truncated || canceled)) return 'incomplete';
    if (!fetching && matchCount === 0) return 'empty';
    return 'results';
}

export function projectSearchTerminationMessage(
    t: Translate,
    reason: FileSearchTerminationReason,
    scannedFiles: number,
    hasMatches: boolean,
): string | undefined {
    const next = t(
        hasMatches
            ? 'projectSearch.termination.showingPartial'
            : 'projectSearch.termination.narrowSearch',
    );
    const count = formatCount(scannedFiles);
    switch (reason) {
        case 'completed':
            return;
        case 'canceled':
            return t('projectSearch.termination.canceled');
        case 'timeout':
            return t('projectSearch.termination.timeout', { count, next });
        case 'file-limit':
            return t('projectSearch.termination.fileLimit', { count, next });
        case 'result-limit':
            return t('projectSearch.termination.resultLimit');
        case 'payload-limit':
            return t('projectSearch.termination.payloadLimit');
    }
}
