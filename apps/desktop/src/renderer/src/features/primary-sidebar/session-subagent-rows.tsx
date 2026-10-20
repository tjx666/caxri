import type { TerminalRecord } from '@caxri/protocol';
import { agentChatItemStatusLabel, agentChatTaskGlyphStatus } from '@caxri/protocol';

import { useTranslation } from '../../i18n';
import { AgentChatStatusGlyph } from '../agent-chat/tools/agent-chat-status-glyph';
import {
    primarySidebarSubagentMoreRowId,
    primarySidebarSubagentRowId,
} from './primary-sidebar-tree';
import { openSessionSubagent } from './session-subagent-commands';
import { sessionSubagentSummaries, subagentWindow } from './session-subagents';
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
    'subagent-row flex h-6 w-full cursor-pointer items-center gap-2 rounded-md border-0 bg-transparent pr-2 pl-8 text-left text-[12px] text-muted hover:bg-[color-mix(in_srgb,var(--elevated)_60%,transparent)] hover:text-foreground focus-visible:ring-1 focus-visible:ring-foreground focus-visible:outline-none';

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
    const subagents = sessionSubagentSummaries(terminal, showSubagents);
    if (!terminal || subagents.length === 0) return null;
    const terminalId = terminal.id;
    const { visible, hasToggle, hiddenCount } = subagentWindow(subagents, isExpanded);
    const moreRowId = primarySidebarSubagentMoreRowId(sessionId);
    return (
        <div
            className="subagent-list"
            role="group"
            aria-label={t('primarySidebar.subagents.ariaLabel')}
        >
            {visible.map((subagent) => {
                const rowId = primarySidebarSubagentRowId(sessionId, subagent.taskId);
                const glyphStatus = agentChatTaskGlyphStatus(subagent.status);
                const title = subagent.title || t('agentChat.tasks.subagent');
                const open = (): void => {
                    // Fire-and-forget: the selection reports its own failures through a toast.
                    // eslint-disable-next-line no-void -- intentional floating-promise discard
                    void openSessionSubagent(sessionId, terminalId, subagent.taskId);
                };
                return (
                    <button
                        key={subagent.taskId}
                        aria-label={t('primarySidebar.subagents.rowAriaLabel', {
                            status: agentChatItemStatusLabel(glyphStatus, t),
                            title,
                        })}
                        aria-level={3}
                        aria-selected={false}
                        className={ROW_CLASS_NAME}
                        data-row-id={rowId}
                        data-subagent-status={subagent.status}
                        role="treeitem"
                        tabIndex={rowId === rovingRowId ? 0 : -1}
                        onClick={open}
                    >
                        <AgentChatStatusGlyph status={glyphStatus} />
                        <span className="overflow-fade min-w-0 flex-1 whitespace-nowrap [--overflow-fade-size:16px]">
                            {title}
                        </span>
                        {subagent.agentType && (
                            <span
                                aria-hidden="true"
                                className="max-w-[40%] flex-none truncate text-[11px] opacity-70"
                            >
                                {subagent.agentType}
                            </span>
                        )}
                    </button>
                );
            })}
            {hasToggle && (
                <button
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
                    role="treeitem"
                    tabIndex={moreRowId === rovingRowId ? 0 : -1}
                    onClick={() => toggle(sessionId)}
                >
                    {isExpanded
                        ? t('primarySidebar.subagents.showFewer')
                        : t('primarySidebar.subagents.showMore', { count: hiddenCount })}
                </button>
            )}
        </div>
    );
}
