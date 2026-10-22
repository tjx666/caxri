import type { TerminalRecord } from '@caxri/protocol';
import { activeTab, agentChatItemStatusLabel, agentChatTaskGlyphStatus } from '@caxri/protocol';

import { Tooltip } from '../../components/ui/tooltip';
import { useTranslation } from '../../i18n';
import { cn } from '../../lib/utilities';
import { useWorkbenchStore } from '../../stores/workbench';
import { AgentChatStatusGlyph } from '../agent-chat/tools/agent-chat-status-glyph';
import {
    primarySidebarSubagentMoreRowId,
    primarySidebarSubagentRowId,
} from './primary-sidebar-tree';
import { openSessionSubagent } from './session-subagent-commands';
import {
    activeSubagentTaskId,
    sessionSubagentSummaries,
    subagentWindow,
} from './session-subagents';
import { useSubagentExpansionStore } from './subagent-expansion-store';

interface SessionSubagentRowsProperties {
    sessionId: string;
    /**
     * The Session's Agent Terminal record; its own `subagents` array keeps its identity across a refresh that changed
     * no subagent, so these rows stay untouched.
     */
    terminal: TerminalRecord | undefined;
    /**
     * Whether the Setting lists subagents at all (`primarySidebar.showSubagents`).
     */
    showSubagents: boolean;
    /**
     * The roving row id when it is one of these rows; see `rovingSubagentRowId`.
     */
    rovingRowId?: string;
}

const ROW_CLASS_NAME =
    'subagent-row flex h-6 w-full cursor-pointer items-center gap-2 rounded-md border-0 bg-transparent pr-2 pl-8 text-left text-[12px] text-muted hover:bg-state-hover hover:text-foreground focus-visible:ring-1 focus-visible:ring-foreground focus-visible:outline-none';

/**
 * The subagents a Chat Session started, as rows one level under the Session row (issue caxri#2260). Callers render it
 * through `memo` with props that keep their identity across unrelated refreshes, so a streaming task update on one Chat
 * renders neither the other Sessions' rows nor these rows again: the persisted summaries change only on a start, a
 * rename, or a status change.
 *
 * Each row is its own `treeitem` at level 3 holding the roving Tab stop when focused. Activating it selects the Session
 * and opens the task beside its Chat; nothing here starts a provider.
 */
export function SessionSubagentRows({
    sessionId,
    terminal,
    showSubagents,
    rovingRowId,
}: SessionSubagentRowsProperties) {
    const { t } = useTranslation();
    const isExpanded = useSubagentExpansionStore((state) =>
        state.expandedSessionIds.has(sessionId),
    );
    const toggle = useSubagentExpansionStore((state) => state.toggle);
    // A primitive, so a work-tab switch re-renders only the rows whose selected state changed.
    const activeTaskId = useWorkbenchStore((state) => {
        const layout = state.bootstrap?.sessionStates.find(
            (item) => item.sessionId === sessionId,
        )?.paneLayout;
        return activeSubagentTaskId(layout && activeTab(layout)?.resource, terminal?.id);
    });
    const subagents = sessionSubagentSummaries(terminal, showSubagents);
    if (!terminal || subagents.length === 0) return null;
    const terminalId = terminal.id;
    const { visible, toggleIndex, hiddenCount } = subagentWindow(subagents, isExpanded);
    const moreRowId = primarySidebarSubagentMoreRowId(sessionId);
    const toggleRow = (
        <button
            key={moreRowId}
            aria-label={t(
                isExpanded
                    ? 'primarySidebar.subagents.showFewerAriaLabel'
                    : 'primarySidebar.subagents.showMoreAriaLabel',
                { count: hiddenCount },
            )}
            aria-level={3}
            aria-selected={false}
            className={ROW_CLASS_NAME}
            data-row-id={moreRowId}
            // An action row with no children of its own, so no `aria-expanded`; the label names what it does next.
            data-subagent-toggle={isExpanded ? 'expanded' : 'folded'}
            role="treeitem"
            tabIndex={moreRowId === rovingRowId ? 0 : -1}
            onClick={() => toggle(sessionId)}
        >
            {/* The status glyph's slot, so the label lines up with the subagent titles above and below it. */}
            <span aria-hidden="true" className="size-3.5 shrink-0" />
            {isExpanded
                ? t('primarySidebar.subagents.showFewer')
                : t('primarySidebar.subagents.showMore', { count: hiddenCount })}
        </button>
    );
    const rows = visible.map((subagent) => {
        const rowId = primarySidebarSubagentRowId(sessionId, subagent.taskId);
        const glyphStatus = agentChatTaskGlyphStatus(subagent.status);
        const title = subagent.title || t('agentChat.tasks.subagent');
        const open = (): void => {
            // Fire-and-forget: the selection reports its own failures through a toast.
            // eslint-disable-next-line no-void -- intentional floating-promise discard
            void openSessionSubagent(sessionId, terminalId, subagent.taskId);
        };
        const isSelected = subagent.taskId === activeTaskId;
        return (
            <Tooltip key={subagent.taskId} content={title} hoverOnly>
                <button
                    aria-label={t('primarySidebar.subagents.rowAriaLabel', {
                        status: agentChatItemStatusLabel(glyphStatus, t),
                        title,
                    })}
                    aria-level={3}
                    aria-selected={isSelected}
                    className={cn(
                        ROW_CLASS_NAME,
                        isSelected && 'active bg-elevated text-foreground',
                    )}
                    data-row-id={rowId}
                    data-subagent-status={subagent.status}
                    role="treeitem"
                    tabIndex={rowId === rovingRowId ? 0 : -1}
                    onClick={open}
                >
                    <AgentChatStatusGlyph status={glyphStatus} />
                    <span className="min-w-0 flex-1 truncate">{title}</span>
                    {subagent.agentType && (
                        <span
                            aria-hidden="true"
                            className="max-w-[40%] shrink-0 truncate text-[11px]"
                        >
                            {subagent.agentType}
                        </span>
                    )}
                </button>
            </Tooltip>
        );
    });
    // The toggle sits where the folded list ends, in both states; `subagentWindow` explains why.
    if (toggleIndex !== undefined) rows.splice(toggleIndex, 0, toggleRow);
    return (
        <div
            className="subagent-list relative"
            role="group"
            aria-label={t('primarySidebar.subagents.ariaLabel')}
        >
            {/*
             * Decorative indent guide under the Session's Agent icon (x = row padding + half the 14px icon), tying the
             * rows to the Session above them the way Claude Desktop's sidebar does. Not a click target: a 1px line is
             * too thin to hit and invisible to the keyboard, so folding stays on the toggle row.
             */}
            <span
                aria-hidden="true"
                className="subagent-guide pointer-events-none absolute top-0 bottom-1.5 left-[15px] w-px bg-border"
            />
            {rows}
        </div>
    );
}
