import type { TerminalRecord, TerminalSubagentSummary } from '@caxri/protocol';

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
     * Whether the show-more/show-fewer row exists: the Session has more subagents than the collapsed window.
     */
    hasToggle: boolean;
    visible: TerminalSubagentSummary[];
}

/**
 * The subagents a Session renders: the newest {@link DEFAULT_VISIBLE_SUBAGENT_COUNT} until the user expands the list.
 */
export function subagentWindow(
    subagents: readonly TerminalSubagentSummary[],
    isExpanded: boolean,
): SubagentWindow {
    const ordered = orderSubagents(subagents);
    const hasToggle = ordered.length > DEFAULT_VISIBLE_SUBAGENT_COUNT;
    const visible = isExpanded ? ordered : ordered.slice(0, DEFAULT_VISIBLE_SUBAGENT_COUNT);
    return { hasToggle, hiddenCount: ordered.length - visible.length, visible };
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
