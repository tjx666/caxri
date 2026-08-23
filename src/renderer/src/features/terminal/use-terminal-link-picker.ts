import { useCallback, useEffect, useReducer } from 'react';

import {
    getTerminalDetectedLinks,
    registerTerminalLinkPickerHandler,
} from './terminal-link-actions';
import type { TerminalDetectedLink } from './terminal-links';

export interface TerminalLinkPickerState {
    isOpen: boolean;
    links: TerminalDetectedLink[];
}

export type TerminalLinkPickerAction =
    { type: 'close' } | { type: 'open'; links: TerminalDetectedLink[] };

const initialTerminalLinkPickerState: TerminalLinkPickerState = { isOpen: false, links: [] };

export function terminalLinkPickerReducer(
    state: TerminalLinkPickerState,
    action: TerminalLinkPickerAction,
): TerminalLinkPickerState {
    if (action.type === 'open') return { isOpen: true, links: action.links };
    if (!state.isOpen && state.links.length === 0) return state;
    return initialTerminalLinkPickerState;
}

export function useTerminalLinkPicker(terminalId: string, focusTerminal: () => void) {
    const [state, dispatch] = useReducer(terminalLinkPickerReducer, initialTerminalLinkPickerState);

    const restoreTerminalFocus = useCallback(() => {
        requestAnimationFrame(focusTerminal);
    }, [focusTerminal]);

    const openPicker = useCallback(() => {
        dispatch({ type: 'open', links: getTerminalDetectedLinks(terminalId) });
    }, [terminalId]);

    useEffect(
        () => registerTerminalLinkPickerHandler(terminalId, openPicker),
        [openPicker, terminalId],
    );

    const onOpenChange = useCallback(
        (isNextOpen: boolean) => {
            if (isNextOpen) {
                return;
            }

            dispatch({ type: 'close' });
            restoreTerminalFocus();
        },
        [restoreTerminalFocus],
    );

    const selectLink = useCallback(
        (link: TerminalDetectedLink) => {
            dispatch({ type: 'close' });
            /**
             * Native confirmation dialogs restore focus to their caller, while an authorized file activation moves it
             * onwards to the Editor. Focusing xterm first gives cancel/failure a stable destination without preventing
             * the existing Editor path from taking focus after a successful open.
             */
            requestAnimationFrame(() => {
                focusTerminal();
                link.activate();
            });
        },
        [focusTerminal],
    );

    return { ...state, onOpenChange, selectLink };
}
