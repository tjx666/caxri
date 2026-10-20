import { useMemo } from 'react';

import type { SessionRecord, TerminalRecord } from '@caxri/protocol';
import { defaultAppSettings } from '@caxri/protocol';

import { useSettings } from '../../../stores/selectors';
import {
    indexedSessionAgentTerminal,
    sessionTerminalIndex,
} from '../../session/session-agent-terminal';
import type { PrimarySidebarSubagentNode } from '../primary-sidebar-tree';
import { sessionSubagentSummaries, subagentWindow } from '../session-subagents';
import { useSubagentExpansionStore } from '../subagent-expansion-store';

/**
 * The subagent rows each rendered Session shows, mirrored into the keyboard row order so arrow keys walk exactly the
 * rows on screen, plus the `primarySidebar.showSubagents` Setting that gates them (an empty map while it is off).
 */
export function useSessionSubagentNodes(
    renderedSessions: readonly SessionRecord[],
    terminals: TerminalRecord[],
): { showSubagents: boolean; subagentNodes: Map<string, PrimarySidebarSubagentNode> } {
    const showSubagents =
        useSettings()?.['primarySidebar.showSubagents'] ??
        defaultAppSettings['primarySidebar.showSubagents'];
    const expandedSessionIds = useSubagentExpansionStore((state) => state.expandedSessionIds);
    const subagentNodes = useMemo(() => {
        const nodes = new Map<string, PrimarySidebarSubagentNode>();
        if (!showSubagents) return nodes;
        const index = sessionTerminalIndex(terminals);
        for (const session of renderedSessions) {
            const terminal = indexedSessionAgentTerminal(session, index);
            const subagents = sessionSubagentSummaries(terminal, true);
            if (!terminal || subagents.length === 0) continue;
            const window = subagentWindow(subagents, expandedSessionIds.has(session.id));
            nodes.set(session.id, {
                hasToggle: window.hasToggle,
                taskIds: window.visible.map((subagent) => subagent.taskId),
                terminalId: terminal.id,
            });
        }
        return nodes;
    }, [expandedSessionIds, renderedSessions, showSubagents, terminals]);
    return { showSubagents, subagentNodes };
}
