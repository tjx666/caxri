import { useEffect } from 'react';

import { useShallow } from 'zustand/react/shallow';

import { runCommand } from '../../../commands/execute';
import { useSelectedSessionId } from '../../../stores/selectors';
import { useWorkbenchStore } from '../../../stores/workbench';
import { useSessionNavigationHistoryStore } from '../session-navigation-history';

/**
 * Chromium reports the two extra mouse buttons as `button` 3 (back) and 4 (forward). Browsers and native apps both map
 * them to history navigation, so a mouse that has them should drive the Session history too.
 */
const MOUSE_BUTTON_BACK = 3;
const MOUSE_BUTTON_FORWARD = 4;

/**
 * Feeds the Session visit history from the workbench's observed selection and binds the mouse navigation buttons.
 *
 * Recording here rather than inside each selection call site is deliberate: PrimarySidebar clicks, the command palette,
 * the MRU switcher, Session creation, and Server-driven switches all converge on the selected Session, so history stays
 * correct without every future navigation source remembering to write it.
 */
export function useSessionNavigationHistory(): void {
    const selectedSessionId = useSelectedSessionId();
    /**
     * Shallow-compared ids, so a Session's activity or timestamp update does not re-prune.
     */
    const activeSessionIds = useWorkbenchStore(
        useShallow((state) =>
            (state.bootstrap?.sessions ?? [])
                .filter((session) => session.archivedAt === undefined)
                .map((session) => session.id),
        ),
    );

    useEffect(() => {
        useSessionNavigationHistoryStore.getState().recordWorkbenchSelection(selectedSessionId);
    }, [selectedSessionId]);

    useEffect(() => {
        useSessionNavigationHistoryStore.getState().prune(activeSessionIds);
    }, [activeSessionIds]);

    useEffect(() => {
        const onMouseUp = (event: MouseEvent): void => {
            if (event.button !== MOUSE_BUTTON_BACK && event.button !== MOUSE_BUTTON_FORWARD) return;
            event.preventDefault();
            /**
             * Routed through `runCommand` rather than the action directly: the side buttons are a global gesture, so
             * they have to stand down behind an open modal exactly like the keyboard binding does. Skipping the command
             * layer would let a click switch the Session underneath an open dialog.
             */
            runCommand(
                event.button === MOUSE_BUTTON_BACK
                    ? 'session.navigateBack'
                    : 'session.navigateForward',
            );
        };
        addEventListener('mouseup', onMouseUp);
        return () => removeEventListener('mouseup', onMouseUp);
    }, []);
}
