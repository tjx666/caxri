import type { RefObject } from 'react';
import { useCallback, useEffect } from 'react';

import { useOnVisible } from '@/hooks/use-on-visible';

import type { TerminalRendererController } from '../terminal-renderer';
import { terminalVisibilityRestoreScheduler } from '../terminal-visibility-restore';

/**
 * Restores one Terminal's renderer after the window becomes visible again. `rendererReference` is undefined until the
 * pane's mount effect finishes attaching, so a visibility event that fires before then (or after disposal) safely
 * no-ops instead of racing the renderer's own lifecycle. The restore itself runs on a later frame through the shared
 * scheduler, which merges the focus, visibilitychange, and pageshow events of one window restore and staggers the panes
 * of a split across frames.
 */
export function useTerminalVisibilityRestore(
    terminalId: string,
    rendererReference: RefObject<TerminalRendererController | undefined>,
): void {
    const restoreRenderer = useCallback((): void => {
        // `focus`/`pageshow` can fire while the document is still hidden during window restore; only a visible
        // document should trigger a renderer restore, matching the guard the inline listeners applied uniformly.
        if (document.visibilityState !== 'visible') return;
        terminalVisibilityRestoreScheduler.schedule(terminalId, () =>
            rendererReference.current?.restoreVisible(),
        );
    }, [rendererReference, terminalId]);
    useOnVisible(restoreRenderer, { includePageShow: true });
    useEffect(() => () => terminalVisibilityRestoreScheduler.cancel(terminalId), [terminalId]);
}
