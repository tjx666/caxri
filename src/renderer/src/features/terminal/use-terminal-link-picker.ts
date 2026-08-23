import { useCallback, useEffect, useState } from 'react';

import {
    getTerminalDetectedLinks,
    registerTerminalLinkPickerHandler,
} from './terminal-link-actions';
import type { TerminalDetectedLink } from './terminal-links';

export function useTerminalLinkPicker(terminalId: string, focusTerminal: () => void) {
    const [isOpen, setIsOpen] = useState(false);
    const [links, setLinks] = useState<TerminalDetectedLink[]>([]);

    const restoreTerminalFocus = useCallback(() => {
        requestAnimationFrame(focusTerminal);
    }, [focusTerminal]);

    const openPicker = useCallback(() => {
        setLinks(getTerminalDetectedLinks(terminalId));
        setIsOpen(true);
    }, [terminalId]);

    useEffect(
        () => registerTerminalLinkPickerHandler(terminalId, openPicker),
        [openPicker, terminalId],
    );

    const onOpenChange = useCallback(
        (isNextOpen: boolean) => {
            setIsOpen(isNextOpen);
            if (!isNextOpen) restoreTerminalFocus();
        },
        [restoreTerminalFocus],
    );

    const selectLink = useCallback(
        (link: TerminalDetectedLink) => {
            setIsOpen(false);
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

    return { isOpen, links, onOpenChange, selectLink };
}
