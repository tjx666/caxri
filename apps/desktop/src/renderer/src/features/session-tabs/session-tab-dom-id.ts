import { workTabId } from '../tabs/work-tab-accessibility';

/**
 * A tab's DOM id, shared with the strip's roving focus. Prefixed so it can never collide with a pane tab's id.
 */
export function sessionTabDomId(sessionId: string): string {
    return `session-${workTabId(sessionId)}`;
}
