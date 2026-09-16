import type { MethodResult } from '@caxri/protocol';

import { caxriQueryKey, queryClient } from '../../queries/client';
import { openStatusBarPicker } from '../../stores/dialogs';
import { getSelectedSession } from '../../stores/selectors';

/**
 * Whether the status bar is currently showing the branch chip, which is the control `git.switchBranch` asks to open.
 * Read from the same cached `projectStatus.overview` the chip itself renders from, so the palette cannot offer a Switch
 * Branch that would land on a chip that is not there — a Session outside a repository has no branch to leave.
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
