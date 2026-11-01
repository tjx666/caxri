import { useEffect, useRef } from 'react';

import { environmentTabPath } from '@caxri/protocol';

import { closeSettings, useDialogStore } from '../../stores/dialogs';
import { openEditorTab } from '../editor/document-commands';

/**
 * Requests the global Environment surface. A selected Session receives the single Environment tab; the sessionless
 * Workbench renders the same page in place of Welcome. Settings is a window-level page that hides the whole Workbench,
 * so it closes first; otherwise the status-bar warning chip would open the page behind Settings and look inert.
 */
export function openEnvironmentPage(): void {
    closeSettings({ restoreFocus: false });
    useDialogStore.getState().openEnvironment();
}

/**
 * Opens or focuses the single Environment document tab for global page requests made while a Session is selected.
 */
export function useEnvironmentTabOpener(): void {
    const requestId = useDialogStore((state) => state.environmentPageRequestId);
    const handledRequestId = useRef(0);
    useEffect(() => {
        if (requestId === 0 || handledRequestId.current === requestId) return;
        handledRequestId.current = requestId;
        openEditorTab(environmentTabPath());
    }, [requestId]);
}
