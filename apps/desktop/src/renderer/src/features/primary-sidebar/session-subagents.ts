import type { PaneResource, TerminalRecord, TerminalSubagentSummary } from '@caxri/protocol';
import { parseAgentTaskTab } from '@caxri/protocol';

/**
 * Pure rules for the subagent rows nested under a Chat Session in the PrimarySidebar (see `docs/agent-chat.md`). Kept
 * out of the components so ordering and the show-more window are covered by fast unit tests.
 */

/**
 * Subagents a Session shows before its show-more row appears (LobeHub's thread list collapses the same way).
 */
export const DEFAULT_VISIBLE_SUBAGENT_COUNT = 3;

const EMPTY_SUBAGENTS: readonly TerminalSubagentSummary[] = [];

/**
 * The persisted subagents of the Terminal that stands for a Session, or none. Only a Chat Terminal has them: a PTY
 * Agent reports no per-subagent identity, and the Setting turns the rows off altogether. Returns the record's own array
 * so a Terminal refresh that changed nothing keeps its identity and the rows stay un-rendered.
 */
export function sessionSubagentSummaries(
    terminal: TerminalRecord | undefined,
    isEnabled: boolean,
): readonly TerminalSubagentSummary[] {
    if (!isEnabled || terminal?.surface !== 'chat') return EMPTY_SUBAGENTS;
    return terminal.subagents ?? EMPTY_SUBAGENTS;
}

function recency(subagent: TerminalSubagentSummary): number {
    return subagent.status === 'running'
        ? subagent.startedAt
        : (subagent.endedAt ?? subagent.startedAt);
}

/**
 * Running subagents first, then the ended ones; each group newest first by when it started (running) or ended.
 */
export function orderSubagents(
    subagents: readonly TerminalSubagentSummary[],
): TerminalSubagentSummary[] {
    return subagents.toSorted(
        (left, right) =>
            Number(right.status === 'running') - Number(left.status === 'running') ||
            recency(right) - recency(left) ||
            left.taskId.localeCompare(right.taskId),
    );
}

export interface SubagentWindow {
    /**
     * Subagents the collapsed window hides; `0` when everything fits.
     */
    hiddenCount: number;
    /**
     * Where the show-more/show-fewer row sits among `visible`: before the subagent at this index. Absent when the
     * Session has no more subagents than the collapsed window, so there is nothing to toggle.
     */
    toggleIndex?: number;
    visible: TerminalSubagentSummary[];
}

/**
 * The subagents a Session renders: the newest {@link DEFAULT_VISIBLE_SUBAGENT_COUNT} until the user expands the list.
 *
 * The toggle row stays right after those first few in both states instead of trailing the list. Expanding then opens
 * the rest below the row the pointer and focus are already on, and folding them again happens in the same place; a
 * trailing "Show fewer" ended up below every subagent, out of reach of a long list, so it was never used and the list
 * stayed long.
 */
export function subagentWindow(
    subagents: readonly TerminalSubagentSummary[],
    isExpanded: boolean,
): SubagentWindow {
    const ordered = orderSubagents(subagents);
    if (ordered.length <= DEFAULT_VISIBLE_SUBAGENT_COUNT)
        return { hiddenCount: 0, visible: ordered };
    const visible = isExpanded ? ordered : ordered.slice(0, DEFAULT_VISIBLE_SUBAGENT_COUNT);
    return {
        hiddenCount: ordered.length - visible.length,
        toggleIndex: DEFAULT_VISIBLE_SUBAGENT_COUNT,
        visible,
    };
}

/**
 * The roving row id when it belongs to this Session's subagent rows, otherwise `undefined`. Handing a row list only its
 * own answer keeps its memo boundary intact while focus moves between other rows.
 */
export function rovingSubagentRowId(
    rovingRowId: string | undefined,
    sessionId: string,
): string | undefined {
    if (rovingRowId === undefined) return undefined;
    return rovingRowId.startsWith(`subagent:${sessionId}:`) ||
        rovingRowId === `subagent-more:${sessionId}`
        ? rovingRowId
        : undefined;
}

/**
 * The task id of the subagent whose task tab is the active pane tab, when that tab belongs to `terminalId`'s Chat. The
 * sidebar marks that subagent row as selected, the way the Session row is for the open Session.
 */
export function activeSubagentTaskId(
    resource: PaneResource | undefined,
    terminalId: string | undefined,
): string | undefined {
    if (terminalId === undefined || resource?.kind !== 'file') return undefined;
    const task = parseAgentTaskTab(resource.path);
    return task?.terminalId === terminalId ? task.taskId : undefined;
}
