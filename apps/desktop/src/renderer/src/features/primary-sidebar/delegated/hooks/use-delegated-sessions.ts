import { useMemo } from 'react';

import type { ProjectRecord, SessionRecord, TerminalRecord } from '@caxri/protocol';

import type { DelegatedPlacement } from '../delegated-placement';
import { nestedHostId, nestedSessions, selectedHostFallbackRowIds } from '../delegated-placement';
import { delegationFeedCreatorIdChunks } from '../delegation-feed';
import type { DelegatedChildrenModel } from './use-delegated-children';
import { useDelegatedChildren } from './use-delegated-children';
import { useDelegatedPlacement } from './use-delegated-placement';
import type { DelegationFeed } from './use-delegation-feed';
import { useDelegationFeed } from './use-delegation-feed';

export interface DelegatedSessionsModel {
    children: DelegatedChildrenModel;
    feed: DelegationFeed;
    placement: DelegatedPlacement;
    /**
     * Rows the roving Tab stop falls back to when the selected Session is nested and its row is not on screen: its
     * host's row, then its host's group heading.
     */
    selectedFallbackRowIds: readonly string[];
    /**
     * The host of the selected Session when that Session is nested, else `undefined`. The host's row is held inside its
     * Project's window like a selected row.
     */
    selectedHostSessionId: string | undefined;
}

/**
 * Everything the Project tree needs to nest delegated Sessions under their hosts: where each Session goes, the
 * delegation feed that tells which nested ones failed, and each host's window of nested rows. One hook so the tree
 * component makes a single call at the top and every derived structure reads the same placement.
 */
export function useDelegatedSessions({
    projects,
    selectedSessionId,
    sessions,
    terminals,
}: {
    /**
     * The Projects the tree lists, not the full catalog.
     */
    projects: ReadonlyArray<Pick<ProjectRecord, 'id'>>;
    selectedSessionId: string | undefined;
    /**
     * Every Session record, archived ones included.
     */
    sessions: readonly SessionRecord[];
    terminals: readonly TerminalRecord[];
}): DelegatedSessionsModel {
    const placement = useDelegatedPlacement({ projects, selectedSessionId, sessions });
    const creatorIdChunks = useMemo(
        () => delegationFeedCreatorIdChunks(nestedSessions(placement)),
        [placement],
    );
    const feed = useDelegationFeed(creatorIdChunks);
    const children = useDelegatedChildren({
        failedSessionIds: feed.failedSessionIds,
        nestedByHost: placement.nestedByHost,
        selectedSessionId,
        terminals,
    });
    const selectedHostSessionId = nestedHostId(placement, selectedSessionId);
    const selectedFallbackRowIds = useMemo(
        () => selectedHostFallbackRowIds(placement, selectedSessionId),
        [placement, selectedSessionId],
    );
    return { children, feed, placement, selectedFallbackRowIds, selectedHostSessionId };
}
