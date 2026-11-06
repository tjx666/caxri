import { useMemo } from 'react';

import type { ProjectRecord, SessionRecord, TerminalRecord } from '@caxri/protocol';

import {
    delegationFeedCreatorIdChunks,
    humanControlledSessionIds,
} from '../../../delegation/delegation-feed';
import type { DelegationFeed } from '../../../delegation/hooks/use-delegation-feed';
import { useDelegationFeed } from '../../../delegation/hooks/use-delegation-feed';
import type { DelegatedPlacement } from '../delegated-placement';
import {
    nestedHostId,
    nestedSessions,
    placeDelegatedSessions,
    selectedHostFallbackRowIds,
} from '../delegated-placement';
import type { DelegatedChildrenModel } from './use-delegated-children';
import { useDelegatedChildren } from './use-delegated-children';
import { useDelegatedPlacement } from './use-delegated-placement';

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
 * Everything the Project tree needs to nest delegated Sessions under their hosts: where each Session goes (a Session
 * the user took over leaves its host's nest), the delegation feed that tells which nested ones failed, and each host's
 * window of nested rows. One hook so the tree component makes a single call at the top and every derived structure
 * reads the same placement.
 */
export function useDelegatedSessionNesting({
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
    /**
     * Placement from the records alone decides which creators the feed reads. Reading them from the final placement
     * would drop a taken-over Session's creator once it leaves the nest, lose its `control`, and nest it again.
     */
    const recordPlacement = useDelegatedPlacement({ projects, selectedSessionId, sessions });
    const creatorIdChunks = useMemo(
        () => delegationFeedCreatorIdChunks(nestedSessions(recordPlacement)),
        [recordPlacement],
    );
    const feed = useDelegationFeed(creatorIdChunks);
    // Keyed by content: the feed's entries change on every step, but the tree is rebuilt only when a takeover moves.
    const humanControlledKey = humanControlledSessionIds(feed.entries).join('\n');
    const placement = useMemo(
        () =>
            humanControlledKey === ''
                ? recordPlacement
                : placeDelegatedSessions({
                      humanControlledSessionIds: new Set(humanControlledKey.split('\n')),
                      projects,
                      selectedSessionId,
                      sessions,
                  }),
        [humanControlledKey, projects, recordPlacement, selectedSessionId, sessions],
    );
    const children = useDelegatedChildren({
        approvalSessionIds: feed.approvalSessionIds,
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
