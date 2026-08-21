import { useEffect, useMemo } from 'react';

import { runCommand } from '../../commands/execute';
import { useSelectedSession, useSessions } from '../../stores/selectors';
import { useSessionNavigationHistoryStore } from './session-navigation-history';

/**
 * Chromium reports the two extra mouse buttons as `button` 3 (back) and 4 (forward). Browsers and native apps both map
 * them to history navigation, so a mouse that has them should drive the Session history too.
 */
const MOUSE_BUTTON_BACK = 3;
const MOUSE_BUTTON_FORWARD = 4;

/**
 * Feeds the Session visit history from the workbench's observed selection and binds the mouse navigation buttons.
 *
 * Recording here rather than inside each selection call site is deliberate: Sidebar clicks, the command palette, the
 * MRU switcher, Session creation, and Runtime-driven switches all converge on the selected Session, so history stays
 * correct without every future navigation source remembering to write it.
 */
export function useSessionNavigationHistory(): void {
    const selectedSessionId = useSelectedSession()?.id;
    const sessions = useSessions();
    const activeSessionIds = useMemo(
        () =>
            (sessions ?? [])
                .filter((session) => session.archivedAt === undefined)
                .map((session) => session.id),
        [sessions],
    );

    /**
     * The history ignores the Workbench snapshot while a selection it dispatched is still settling, because that
     * snapshot is that selection's own echo. Re-running once the last one settles is what reconciles a switch the
     * Runtime made on its own during that window — otherwise the effect would never fire again for a Session it already
     * saw, and the history would stay pointed at a Session the Workbench left.
     */
    const isSettlingSelection = useSessionNavigationHistoryStore((state) => state.inFlight > 0);
    useEffect(() => {
        if (!isSettlingSelection)
            useSessionNavigationHistoryStore.getState().observe(selectedSessionId);
    }, [isSettlingSelection, selectedSessionId]);

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
