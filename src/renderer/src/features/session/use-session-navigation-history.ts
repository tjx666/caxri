import { useEffect, useMemo } from 'react';

import { useSelectedSession, useSessions } from '../../stores/selectors';
import { navigateSessionHistory } from './session-actions';
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

    useEffect(() => {
        useSessionNavigationHistoryStore.getState().observe(selectedSessionId);
    }, [selectedSessionId]);

    useEffect(() => {
        useSessionNavigationHistoryStore.getState().prune(activeSessionIds);
    }, [activeSessionIds]);

    useEffect(() => {
        const onMouseUp = (event: MouseEvent): void => {
            if (event.button !== MOUSE_BUTTON_BACK && event.button !== MOUSE_BUTTON_FORWARD) return;
            event.preventDefault();
            navigateSessionHistory(event.button === MOUSE_BUTTON_BACK ? 'back' : 'forward');
        };
        addEventListener('mouseup', onMouseUp);
        return () => removeEventListener('mouseup', onMouseUp);
    }, []);
}
