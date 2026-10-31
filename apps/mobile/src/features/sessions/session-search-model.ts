import type {
    MobileDeviceRole,
    MobileSessionSearchEntry,
    MobileSessionSearchResult,
} from '@caxri/protocol';

import type { Translate } from '../../i18n';
import { translate } from '../../i18n';

/**
 * Typing waits this long before asking the computer, so a word costs one search rather than one per keystroke.
 */
export const SESSION_SEARCH_DEBOUNCE_MS = 250;
/**
 * While the computer is still indexing conversation history, the results refresh at this cadence so new matches appear
 * without another keystroke.
 */
export const SESSION_SEARCH_INDEXING_REFRESH_MS = 2_000;

/**
 * What tapping a result does: open a Session, or restore an archived one and then open it. Restoring needs a control
 * device, so on view and reply devices an archived result has no action.
 */
export type SessionSearchRowAction = 'open' | 'restore';

export const sessionSearchRowAction = (
    entry: Pick<MobileSessionSearchEntry, 'status'>,
    role: MobileDeviceRole | null,
): SessionSearchRowAction | undefined => {
    if (entry.status === 'open') return 'open';
    return role === 'control' ? 'restore' : undefined;
};

/**
 * Why the list is empty: no Session matches the typed query, or there is no Session to list at all.
 */
export const sessionSearchEmptyKey = (searchedQuery: string, result?: MobileSessionSearchResult) =>
    result?.index.state === 'indexing'
        ? ('sessions.search.emptyWhileIndexing' as const)
        : searchedQuery === ''
          ? ('sessions.search.noSessions' as const)
          : ('sessions.search.noResults' as const);

/**
 * The muted line under the filters: index progress, or why only titles were searched.
 */
export const sessionSearchIndexNotice = (
    result: MobileSessionSearchResult | undefined,
    t: Translate = translate,
): string | undefined => {
    if (result?.index.state === 'indexing')
        return t('sessions.search.indexing', { pending: result.index.pending });
    if (result?.index.state === 'unavailable') return t('sessions.search.unavailable');
    return undefined;
};

/**
 * What the result row says under its title about where the query matched; a title match needs no explanation.
 */
export const sessionSearchMatchLabel = (
    entry: Pick<MobileSessionSearchEntry, 'match'>,
    t: Translate = translate,
): string | undefined => {
    if (entry.match.field === 'id') return t('sessions.search.matchedId');
    if (entry.match.field === 'path') return t('sessions.search.matchedPath');
    return undefined;
};
