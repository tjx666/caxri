import { useEffect, useRef } from 'react';

import { environmentTabPath } from '@caxri/protocol';

import { useDialogStore } from '../../stores/dialogs';
import { openEditorTab } from '../editor/document-commands';

/**
 * Requests the global Environment surface. A selected Session receives the single Environment tab; the sessionless
 * Workbench renders the same page in place of Welcome.
 */
export function openEnvironmentPage(): void {
    useDialogStore.getState().openEnvironment();
}

/**
 * Opens or focuses the single Environment document tab for global page requests made while a Session is selected.
 */
export function useEnvironmentTabOpener(): void {
    const request = useDialogStore((state) => state.workbenchPageRequest);
    const handledRequestId = useRef(0);
    useEffect(() => {
        if (
            request.surface !== 'environment' ||
            request.id === 0 ||
            handledRequestId.current === request.id
        )
            return;
        handledRequestId.current = request.id;
        openEditorTab(environmentTabPath());
    }, [request]);
}
