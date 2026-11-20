import { useMemo } from 'react';

import type { SessionRecord, TerminalRecord } from '@caxri/protocol';
import { defaultAppSettings } from '@caxri/protocol';

import { useSettings } from '../../../stores/selectors';
import {
    indexedSessionAgentTerminal,
    sessionTerminalIndex,
} from '../../session/session-agent-terminal';
import type { PrimarySidebarSubagentNode } from '../primary-sidebar-tree';
import { useSessionChildrenCollapseStore } from '../session-children/session-children-collapse';
import { sessionSubagentSummaries, subagentWindow } from '../session-subagents';
import { useSubagentExpansionStore } from '../subagent-expansion-store';

/**
 * The subagent rows each rendered Session shows, mirrored into the keyboard row order so arrow keys walk exactly the
 * rows on screen, plus the `primarySidebar.showSubagents` Setting that gates them (an empty map while it is off).
 *
 * `subagentHostIds` lists every rendered Session that has subagent rows to show, folded or not, which is part of what
 * gives its row a child disclosure. `subagentNodes` leaves out a folded host, whose rows are not on screen.
 */
export function useSessionSubagentNodes(
    renderedSessions: readonly SessionRecord[],
    terminals: TerminalRecord[],
): {
    showSubagents: boolean;
    subagentHostIds: ReadonlySet<string>;
    subagentNodes: Map<string, PrimarySidebarSubagentNode>;
} {
    const showSubagents =
        useSettings()?.['primarySidebar.showSubagents'] ??
        defaultAppSettings['primarySidebar.showSubagents'];
    const expandedSessionIds = useSubagentExpansionStore((state) => state.expandedSessionIds);
    const collapsedHosts = useSessionChildrenCollapseStore((state) => state.collapsed);
    const { subagentHostIds, subagentNodes } = useMemo(() => {
        const hosts = new Set<string>();
        const nodes = new Map<string, PrimarySidebarSubagentNode>();
        if (!showSubagents) return { subagentHostIds: hosts, subagentNodes: nodes };
        const index = sessionTerminalIndex(terminals);
        for (const session of renderedSessions) {
            const terminal = indexedSessionAgentTerminal(session, index);
            const subagents = sessionSubagentSummaries(terminal, true);
            if (!terminal || subagents.length === 0) continue;
            hosts.add(session.id);
            // A folded host renders no subagent rows (`SessionSubagentRows`), so arrow keys must not walk them either.
            if (collapsedHosts[session.id] === true) continue;
            const window = subagentWindow(subagents, expandedSessionIds.has(session.id));
            nodes.set(session.id, {
                taskIds: window.visible.map((subagent) => subagent.taskId),
                terminalId: terminal.id,
                ...(window.toggleIndex !== undefined && { toggleIndex: window.toggleIndex }),
            });
        }
        return { subagentHostIds: hosts, subagentNodes: nodes };
    }, [collapsedHosts, expandedSessionIds, renderedSessions, showSubagents, terminals]);
    return { showSubagents, subagentHostIds, subagentNodes };
}
