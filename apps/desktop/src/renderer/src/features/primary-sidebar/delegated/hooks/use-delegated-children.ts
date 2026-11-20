import { useCallback, useMemo, useState } from 'react';

import type { SessionListWindow, SessionRecord, TerminalRecord } from '@caxri/protocol';
import { nextRevealedSessionCount } from '@caxri/protocol';

import { useTranslation } from '../../../../i18n';
import {
    indexedSessionAgentTerminal,
    sessionTerminalIndex,
} from '../../../session/session-agent-terminal';
import type { PrimarySidebarDelegatedNode } from '../../primary-sidebar-tree';
import { useSessionChildrenCollapseStore } from '../../session-children/session-children-collapse';
import { sessionStatus } from '../../session-status';
import type { DelegatedHostSummary } from '../delegated-child-window';
import { delegatedChildWindow, delegatedHostSummary } from '../delegated-child-window';

interface UseDelegatedChildrenInput {
    /**
     * Nested Sessions whose permission request waits on the user (`useDelegationFeed`); they stay listed while it does.
     */
    approvalSessionIds: ReadonlySet<string>;
    /**
     * Nested Sessions whose delegation failed (`useDelegationFeed`); a failure keeps its row out of the folded part.
     */
    failedSessionIds: ReadonlySet<string>;
    /**
     * Nested Sessions per host in sidebar order (`DelegatedPlacement.nestedByHost`).
     */
    nestedByHost: ReadonlyMap<string, readonly SessionRecord[]>;
    selectedSessionId: string | undefined;
    terminals: readonly TerminalRecord[];
}

export interface DelegatedChildrenModel {
    /**
     * Steps one host's window forward. Takes the window's `windowCount`, like `useProjectSessionWindows`, so a window
     * clamped to a short list steps from what is on screen.
     */
    revealMore: (hostSessionId: string, windowCount: number) => void;
    /**
     * The keyboard row model's view of each host's nested rows (`flattenPrimarySidebarRows`'s `delegated` argument).
     */
    rowNodes: ReadonlyMap<string, PrimarySidebarDelegatedNode>;
    /**
     * What each host row says about its nested Sessions (`delegatedHostSummary`), keyed by host Session id.
     */
    summaries: ReadonlyMap<string, DelegatedHostSummary>;
    /**
     * Each host's window: the visible nested Sessions, plus the counts the reveal row shows.
     */
    windows: ReadonlyMap<string, SessionListWindow<SessionRecord>>;
}

/**
 * Owns how many settled nested Sessions each host shows. A nested Session with a status to show (running, unread or
 * waiting for you, usage wait, detached, failed) is always listed; the settled ones fold behind the host's `Show N
 * more` row after the newest few. A host the user collapsed (`session-children-collapse.ts`) lists only the selected
 * one. Revealed counts live in memory only, like every other window in this sidebar: a relaunch starts from the short
 * list again.
 */
export function useDelegatedChildren({
    approvalSessionIds,
    failedSessionIds,
    nestedByHost,
    selectedSessionId,
    terminals,
}: UseDelegatedChildrenInput): DelegatedChildrenModel {
    const { t } = useTranslation();
    const [revealedCounts, setRevealedCounts] = useState<Record<string, number>>({});
    const collapsedHosts = useSessionChildrenCollapseStore((state) => state.collapsed);
    const { summaries, windows } = useMemo(() => {
        const built = new Map<string, SessionListWindow<SessionRecord>>();
        const builtSummaries = new Map<string, DelegatedHostSummary>();
        if (nestedByHost.size === 0) return { summaries: builtSummaries, windows: built };
        const terminalIndex = sessionTerminalIndex(terminals);
        for (const [hostSessionId, children] of nestedByHost) {
            const statusKinds = new Map<string, string>();
            const activeSessionIds = new Set<string>();
            for (const child of children) {
                const status = sessionStatus(
                    child,
                    indexedSessionAgentTerminal(child, terminalIndex) ?? {},
                    t,
                    {
                        approvalPending: approvalSessionIds.has(child.id),
                        delegationFailed: failedSessionIds.has(child.id),
                        nested: true,
                    },
                );
                statusKinds.set(child.id, status.kind);
                if (status.kind !== 'default') activeSessionIds.add(child.id);
            }
            builtSummaries.set(
                hostSessionId,
                delegatedHostSummary(children, statusKinds, selectedSessionId),
            );
            built.set(
                hostSessionId,
                delegatedChildWindow(children, {
                    activeSessionIds,
                    isCollapsed: collapsedHosts[hostSessionId] === true,
                    revealedCount: revealedCounts[hostSessionId],
                    selectedSessionId,
                }),
            );
        }
        return { summaries: builtSummaries, windows: built };
    }, [
        approvalSessionIds,
        collapsedHosts,
        failedSessionIds,
        nestedByHost,
        revealedCounts,
        selectedSessionId,
        t,
        terminals,
    ]);
    const rowNodes = useMemo(() => {
        const nodes = new Map<string, PrimarySidebarDelegatedNode>();
        for (const [hostSessionId, window] of windows)
            nodes.set(hostSessionId, {
                hasHiddenSessions: window.hiddenCount > 0,
                sessionIds: window.visibleSessions.map((session) => session.id),
            });
        return nodes;
    }, [windows]);
    const revealMore = useCallback((hostSessionId: string, windowCount: number): void => {
        setRevealedCounts((current) => ({
            ...current,
            [hostSessionId]: nextRevealedSessionCount(windowCount),
        }));
    }, []);
    return { revealMore, rowNodes, summaries, windows };
}
