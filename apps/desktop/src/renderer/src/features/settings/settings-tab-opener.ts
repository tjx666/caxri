import { useEffect, useRef } from 'react';

import { settingsTabPath } from '@caxri/protocol';

import { useDialogStore } from '../../stores/dialogs';
import { openEditorTab } from '../editor/document-commands';

/**
 * Answers every `dialogs.openSettings(...)` call by opening or refocusing the Settings Workbench tab.
 *
 * This lives outside `stores/dialogs.ts` on purpose: the low-level dialog store stays free of a dependency on the
 * Editor's document-command module, and every existing `openSettings` call site (the menu, the command palette,
 * `Cmd+,`, the GPU crash card, the notification center) keeps bumping the same `settingsRequest` revision without
 * knowing a tab exists on the other end. `openEditorTab` selects the tab if it is already open in the active pane, so
 * repeat requests (the same shortcut pressed twice) are idempotent rather than opening a second occurrence.
 *
 * Before the first Project is added there is no selected Session to open a tab into, so `openEditorTab` drops the
 * request here; the Workbench's `NoSessionSurface` answers the same revision by showing Settings in place of the
 * Welcome view instead.
 */
export function useSettingsTabOpener(): void {
    const requestId = useDialogStore((state) => state.settingsRequest.id);
    const handledRequestId = useRef(0);
    useEffect(() => {
        if (requestId === 0 || handledRequestId.current === requestId) return;
        handledRequestId.current = requestId;
        openEditorTab(settingsTabPath());
    }, [requestId]);
}
