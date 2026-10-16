import { useEffect } from 'react';

import { setSessionRowHovered } from '../session-row-hover-store';

export function useSessionRowHover(rowId: string | undefined, sessionId: string) {
    const actionRowId = rowId ?? sessionId;
    useEffect(() => () => setSessionRowHovered(actionRowId, false), [actionRowId]);
    /**
     * A removed row can move this row under the pointer without a new enter event. Refresh on pointer movement too; the
     * hover store ignores unchanged owners.
     */
    const hoverActions = () => setSessionRowHovered(actionRowId, true);
    const leaveActions = () => setSessionRowHovered(actionRowId, false);
    return { actionRowId, hoverActions, leaveActions };
}
