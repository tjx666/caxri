import { useEffect } from 'react';

import { closeSettings, useDialogStore } from '../../stores/dialogs';
import { useWorkbenchStore } from '../../stores/workbench';

/**
 * Whether a selection change seen while the Settings page is up means the user went to another Session. The page covers
 * the Workbench, so a Session picked from the Primary Side Bar, the Session switcher, or a notification is one the user
 * wants to see. A selection that moved only because the covered Session was deleted (the Server falls back to a
 * neighbour) is not a navigation, so Settings stays where the user left it.
 */
export function shouldCloseSettingsForSelection(
    previousSessionId: string | undefined,
    nextSessionId: string | undefined,
    liveSessionIds: ReadonlySet<string>,
): boolean {
    if (!previousSessionId || !nextSessionId || previousSessionId === nextSessionId) return false;
    return liveSessionIds.has(previousSessionId);
}

/**
 * Closes the Settings page, without handing focus back, when the user selects another Session underneath it. Observed
 * on the store rather than at each selection entry point, because some selections arrive from Main (a notification
 * click, Caxri Bot's reveal) without passing through any Renderer command.
 */
export function useSettingsPageSelectionClose(): void {
    useEffect(
        () =>
            useWorkbenchStore.subscribe((state, previous) => {
                if (!useDialogStore.getState().settingsPageOpen) return;
                const nextSessionId = state.bootstrap?.selectedSessionId;
                const previousSessionId = previous.bootstrap?.selectedSessionId;
                if (nextSessionId === previousSessionId) return;
                const liveSessionIds = new Set(state.bootstrap?.sessions.map(({ id }) => id));
                if (
                    shouldCloseSettingsForSelection(
                        previousSessionId,
                        nextSessionId,
                        liveSessionIds,
                    )
                )
                    closeSettings({ restoreFocus: false });
            }),
        [],
    );
}
