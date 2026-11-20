import type { TerminalRecord } from '@caxri/protocol';

import { sessionSubagentSummaries } from '../../session-subagents';
import {
    sessionChildrenExpanded,
    useSessionChildrenCollapseStore,
} from '../session-children-collapse';

interface SessionChildRowsInput {
    /**
     * A nested row never hosts child rows of its own, so it has no disclosure.
     */
    isNested: boolean | undefined;
    /**
     * `DelegatedHostSummary.needsYou`; absent when the row hosts no nested Session.
     */
    nestedNeedsYou: boolean | undefined;
    /**
     * `DelegatedHostSummary.count`; absent when the row hosts no nested Session.
     */
    nestedSessionCount: number | undefined;
    sessionId: string;
    showSubagents: boolean;
    terminal: TerminalRecord | undefined;
}

export interface SessionChildRows {
    /**
     * Subagent rows plus nested Sessions under this row.
     */
    count: number;
    /**
     * True only while the row has child rows and the user folded them.
     */
    isCollapsed: boolean;
    /**
     * The row's `aria-expanded`: `undefined` when it has no child rows, and so no disclosure.
     */
    isExpanded: boolean | undefined;
    /**
     * True when a hidden nested Session waits on the user or failed, which a folded host marks beside its count.
     */
    needsYou: boolean;
}

/**
 * The child rows a Session row hosts (its subagents and the Sessions it delegated) and whether the user folded them
 * (issue #4065).
 */
export function useSessionChildRows({
    isNested,
    nestedNeedsYou,
    nestedSessionCount,
    sessionId,
    showSubagents,
    terminal,
}: SessionChildRowsInput): SessionChildRows {
    const count =
        isNested === true
            ? 0
            : (nestedSessionCount ?? 0) + sessionSubagentSummaries(terminal, showSubagents).length;
    const isExpanded = useSessionChildrenCollapseStore((state) =>
        sessionChildrenExpanded(sessionId, count > 0, state.collapsed),
    );
    return {
        count,
        isCollapsed: isExpanded === false,
        isExpanded,
        needsYou: nestedNeedsYou ?? false,
    };
}
