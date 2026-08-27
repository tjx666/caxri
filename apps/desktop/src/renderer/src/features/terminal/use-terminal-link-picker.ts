import { useCallback, useEffect, useReducer, useRef } from 'react';

import {
    createTerminalLinkScanner,
    registerTerminalLinkPickerHandler,
} from './terminal-link-actions';
import type { TerminalLinkScanStatus } from './terminal-link-scanner';
import type { TerminalDetectedLink } from './terminal-links';

export interface TerminalLinkPickerState {
    isOpen: boolean;
    links: TerminalDetectedLink[];
    mode: 'candidates' | 'detected';
    status: TerminalLinkScanStatus;
    isTruncated: boolean;
}

export type TerminalLinkPickerAction =
    | { type: 'close' }
    | { type: 'open' }
    | { type: 'openCandidates'; links: TerminalDetectedLink[]; isTruncated: boolean }
    | { type: 'update'; links: TerminalDetectedLink[]; status: TerminalLinkScanStatus };

const initialTerminalLinkPickerState: TerminalLinkPickerState = {
    isOpen: false,
    links: [],
    mode: 'detected',
    status: 'complete',
    isTruncated: false,
};

export function terminalLinkPickerReducer(
    state: TerminalLinkPickerState,
    action: TerminalLinkPickerAction,
): TerminalLinkPickerState {
    if (action.type === 'open')
        return {
            isOpen: true,
            links: [],
            mode: 'detected',
            status: 'scanning',
            isTruncated: false,
        };
    if (action.type === 'openCandidates')
        return {
            isOpen: true,
            links: action.links,
            mode: 'candidates',
            status: 'complete',
            isTruncated: action.isTruncated,
        };
    if (action.type === 'update') {
        if (!state.isOpen) return state;
        return { ...state, links: action.links, status: action.status };
    }
    if (!state.isOpen && state.links.length === 0) return state;
    return initialTerminalLinkPickerState;
}

export function useTerminalLinkPicker(terminalId: string, focusTerminal: () => void) {
    const [state, dispatch] = useReducer(terminalLinkPickerReducer, initialTerminalLinkPickerState);
    /**
     * Incremented on close/unmount/reopen so a stale `requestAnimationFrame` chain from a previous scan cannot keep
     * dispatching updates into a picker that has since closed or reopened for a different Terminal.
     */
    const scanTokenReference = useRef(0);

    const restoreTerminalFocus = useCallback(() => {
        requestAnimationFrame(focusTerminal);
    }, [focusTerminal]);

    const openPicker = useCallback(() => {
        const scanner = createTerminalLinkScanner(terminalId);
        if (!scanner) return;
        const token = (scanTokenReference.current += 1);
        dispatch({ type: 'open' });
        const runNextChunk = (): void => {
            if (scanTokenReference.current !== token) return;
            const chunk = scanner.scanNextChunk();
            dispatch({ type: 'update', links: chunk.links, status: chunk.status });
            if (chunk.status === 'scanning') requestAnimationFrame(runNextChunk);
        };
        runNextChunk();
    }, [terminalId]);

    const openCandidates = useCallback((links: TerminalDetectedLink[], isTruncated: boolean) => {
        scanTokenReference.current += 1;
        dispatch({ type: 'openCandidates', links, isTruncated });
    }, []);

    useEffect(
        () =>
            registerTerminalLinkPickerHandler(terminalId, {
                openCandidates,
                openDetected: openPicker,
            }),
        [openCandidates, openPicker, terminalId],
    );

    useEffect(
        () => () => {
            scanTokenReference.current += 1;
        },
        [],
    );

    const onOpenChange = useCallback(
        (isNextOpen: boolean) => {
            if (isNextOpen) {
                return;
            }

            scanTokenReference.current += 1;
            dispatch({ type: 'close' });
            restoreTerminalFocus();
        },
        [restoreTerminalFocus],
    );

    const selectLink = useCallback(
        (link: TerminalDetectedLink) => {
            scanTokenReference.current += 1;
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
