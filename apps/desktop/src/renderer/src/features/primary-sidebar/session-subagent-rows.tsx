import type { TerminalRecord } from '@caxri/protocol';
import { activeTab, agentChatItemStatusLabel, agentChatTaskGlyphStatus } from '@caxri/protocol';

import { DisclosureMotion } from '../../components/disclosure-motion';
import { Tooltip } from '../../components/ui/tooltip';
import { useTranslation } from '../../i18n';
import { cn } from '../../lib/utilities';
import { useWorkbenchStore } from '../../stores/workbench';
import { AgentChatStatusGlyph } from '../agent-chat/tools/agent-chat-status-glyph';
import {
    primarySidebarSubagentMoreRowId,
    primarySidebarSubagentRowId,
} from './primary-sidebar-tree';
import { SessionChildGuide } from './session-children/session-child-guide';
import { openSessionSubagent } from './session-subagent-commands';
import {
    activeSubagentTaskId,
    sessionSubagentSummaries,
    subagentGuideRows,
    subagentWindow,
} from './session-subagents';
import { useSubagentExpansionStore } from './subagent-expansion-store';

interface SessionSubagentRowsProperties {
    /**
     * True when the user folded the Session's child rows from its disclosure chevron (`session-children-collapse.ts`).
     */
    isCollapsed: boolean;
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
    /**
     * How many delegated Session rows the host shows after these rows. When any do, the branch guide's trunk runs on
     * into them.
     */
    nestedSessionCount?: number;
    /**
     * True when the selected Session is one of the host's delegated Sessions below, which lights this list's trunk.
     */
    selectedBelow?: boolean;
}

/**
 * Every child row shares one box: 24px tall, starting 28px in (past the branch guide), with its glyph at 34px.
 */
const ROW_CLASS_NAME =
    'subagent-row ml-7 flex h-6 w-[calc(100%-1.75rem)] cursor-pointer items-center gap-1.5 rounded-md border-0 bg-transparent px-1.5 text-left text-[12px] text-muted hover:bg-state-hover hover:text-foreground focus-visible:ring-1 focus-visible:ring-foreground focus-visible:outline-none';

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
    isCollapsed,
    sessionId,
    terminal,
    showSubagents,
    rovingRowId,
    nestedSessionCount = 0,
    selectedBelow = false,
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
    const subagentWindowResult = subagentWindow(subagents, isExpanded);
    const { visible, toggleIndex, hiddenCount } = subagentWindowResult;
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
            void openSessionSubagent(sessionId, terminalId, subagent.taskId);
        };
        const isSelected = subagent.taskId === activeTaskId;
        const status = agentChatItemStatusLabel(glyphStatus, t);
        // The row names only the task, so a long title keeps the row's width; the Agent type waits in the tooltip.
        const tooltip = [title, subagent.agentType, status].filter(Boolean).join(' · ');
        return (
            <Tooltip key={subagent.taskId} content={tooltip} hoverOnly>
                <button
                    aria-label={t('primarySidebar.subagents.rowAriaLabel', { status, title })}
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
                </button>
            </Tooltip>
        );
    });
    // The toggle sits where the folded list ends, in both states; `subagentWindow` explains why.
    if (toggleIndex !== undefined) rows.splice(toggleIndex, 0, toggleRow);
    const guide = subagentGuideRows(subagentWindowResult, activeTaskId);
    return (
        // Folding is the user's own toggle, so the list collapses over `--motion-collapse` instead of popping out.
        <DisclosureMotion animate expanded={!isCollapsed} kind="session-children">
            <div
                className="subagent-list relative"
                role="group"
                aria-label={t('primarySidebar.subagents.ariaLabel')}
            >
                <SessionChildGuide
                    className="subagent-guide"
                    continuesBelow={nestedSessionCount > 0}
                    rows={guide.rows}
                    selectedBelow={selectedBelow}
                    selectedIndex={guide.selectedIndex}
                />
                {rows}
            </div>
        </DisclosureMotion>
    );
}
