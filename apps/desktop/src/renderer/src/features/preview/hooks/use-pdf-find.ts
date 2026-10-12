import type { RefObject } from 'react';
import { useCallback, useRef, useState } from 'react';

import type { PdfViewerSession } from '../pdf-document';
import type { PdfFindResult } from '../pdf-find';
import { EMPTY_PDF_FIND_RESULT } from '../pdf-find';

export interface PdfFind {
    isOpen: boolean;
    query: string;
    result: PdfFindResult;
    /**
     * Bumped each time the bar is asked for, so `Cmd+F` while it is already open selects the query again.
     */
    focusRevision: number;
    open: () => void;
    close: () => void;
    changeQuery: (query: string) => void;
    next: () => void;
    previous: () => void;
    /**
     * Repaints the open query in a viewer session that just mounted, so a reload after the file changed on disk keeps
     * its highlights.
     */
    attach: (session: PdfViewerSession) => void;
    /**
     * The viewer session's report of its matches. Stable, like `attach`.
     */
    report: (result: PdfFindResult) => void;
}

/**
 * Find in a PDF preview. The query survives closing the bar, like the editor's Find widget: reopening repaints its
 * matches and selects it, so typing replaces it. Closing clears the highlights and returns focus to the document
 * through `focusDocument`.
 */
export function usePdfFind(
    sessionReference: RefObject<PdfViewerSession | undefined>,
    focusDocument: () => void,
): PdfFind {
    const [isOpen, setIsOpen] = useState(false);
    const [query, setQuery] = useState('');
    const [result, setResult] = useState(EMPTY_PDF_FIND_RESULT);
    const [focusRevision, setFocusRevision] = useState(0);
    /**
     * Mirrors the two values `attach` reads from the viewer session's asynchronous mount, which runs outside render.
     * Written only in the handlers below, next to the state updates they mirror.
     */
    const latest = useRef({ isOpen, query });
    /**
     * Stable, so the viewer mount effect can call it without remounting when find state changes.
     */
    const attach = useCallback((session: PdfViewerSession) => {
        setResult(EMPTY_PDF_FIND_RESULT);
        if (latest.current.isOpen && latest.current.query)
            session.search(latest.current.query, 'refresh');
    }, []);

    return {
        isOpen,
        query,
        result,
        focusRevision,
        open: () => {
            if (!latest.current.isOpen && latest.current.query)
                sessionReference.current?.search(latest.current.query, 'refresh');
            latest.current.isOpen = true;
            setIsOpen(true);
            setFocusRevision((revision) => revision + 1);
        },
        close: () => {
            latest.current.isOpen = false;
            setIsOpen(false);
            sessionReference.current?.closeFind();
            focusDocument();
        },
        changeQuery: (next) => {
            latest.current.query = next;
            setQuery(next);
            sessionReference.current?.search(next, 'query');
        },
        next: () => sessionReference.current?.search(query, 'next'),
        previous: () => sessionReference.current?.search(query, 'previous'),
        attach,
        report: setResult,
    };
}
