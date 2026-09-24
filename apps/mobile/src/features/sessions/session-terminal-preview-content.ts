import type { TerminalPreviewViewState } from './hooks/use-terminal-preview';
import type { MobileSessionItem } from './session-model';
import { terminalPreviewFallback } from './session-model';

export const sessionTerminalPreviewContent = (
    session: MobileSessionItem,
    {
        error,
        isLoading,
        preview,
    }: Pick<TerminalPreviewViewState, 'error' | 'isLoading' | 'preview'>,
): string => {
    if (preview) {
        if (preview.content) return preview.content;
        if (preview.availability === 'unavailable') return 'Output is unavailable.';
        return terminalPreviewFallback(session, preview.availability);
    }
    if (!session.primaryAgentTerminalId) return 'This Session has no primary Agent output.';
    if (isLoading) return 'Loading the latest Agent output…';
    return error ? 'Latest Agent output could not be loaded.' : 'Output is unavailable.';
};
