import type { MethodResult } from '@caxri/protocol';

import { caxriQueryKey, queryClient } from '../../queries/client';
import { openStatusBarPicker } from '../../stores/dialogs';
import { getSelectedSession } from '../../stores/selectors';

/**
 * Whether the selected Session has a repository whose branches can be switched. The picker stays mounted even when a
 * linked worktree hides its status bar trigger, so command availability does not depend on chip visibility.
 */
export function canSwitchBranch(): boolean {
    const session = getSelectedSession();
    if (!session) return false;
    const overview = queryClient.getQueryData<MethodResult<'projectStatus.overview'>>(
        caxriQueryKey('projectStatus.overview', { sessionId: session.id }),
    );
    return Boolean(overview?.repository);
}

export function switchBranchFromCommand(): void {
    openStatusBarPicker('branch');
}

/**
 * The Workbench Root chip renders for every selected Session, so its only precondition is that one is selected.
 */
export function canSelectWorkbenchRoot(): boolean {
    return Boolean(getSelectedSession());
}

export function selectWorkbenchRootFromCommand(): void {
    openStatusBarPicker('workbenchRoot');
}
