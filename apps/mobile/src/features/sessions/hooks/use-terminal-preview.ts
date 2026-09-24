import { useCallback, useEffect, useState } from 'react';

import type { TerminalPreview } from '@caxri/protocol';

import type { MobileConnectionStatus } from '../../connection/connection-state';
import { useMobileClient } from '../../connection/mobile-client-provider';

const POLL_INTERVAL_MS = 2_500;
const PREVIEW_ERROR = 'Unable to load the latest output.';

export interface TerminalPreviewLoadState {
    error: string | null;
    isLoading: boolean;
    preview: TerminalPreview | null;
    terminalId: string;
}

export interface TerminalPreviewViewState {
    error: string | null;
    isLoading: boolean;
    preview: TerminalPreview | null;
    refresh: () => void;
}

export const loadingTerminalPreviewState = (
    current: TerminalPreviewLoadState | null,
    terminalId: string,
): TerminalPreviewLoadState => ({
    error: current?.terminalId === terminalId ? current.error : null,
    isLoading: true,
    preview: current?.terminalId === terminalId ? current.preview : null,
    terminalId,
});

export const failedTerminalPreviewState = (
    current: TerminalPreviewLoadState | null,
    terminalId: string,
): TerminalPreviewLoadState => ({
    error: PREVIEW_ERROR,
    isLoading: false,
    preview: current?.terminalId === terminalId ? current.preview : null,
    terminalId,
});

export const shouldPollTerminalPreview = ({
    isForeground,
    status,
    terminalId,
    visible,
}: {
    isForeground: boolean;
    status: MobileConnectionStatus;
    terminalId: string | null;
    visible: boolean;
}): boolean => status === 'connected' && isForeground && visible && terminalId !== null;

export const useTerminalPreview = ({
    terminalId,
    visible,
}: {
    terminalId: string | null;
    visible: boolean;
}): TerminalPreviewViewState => {
    const { isForeground, request, status } = useMobileClient();
    const [previewState, setPreviewState] = useState<TerminalPreviewLoadState | null>(null);
    const [retryAttempt, setRetryAttempt] = useState(0);
    const refresh = useCallback((): void => setRetryAttempt((attempt) => attempt + 1), []);

    useEffect(() => {
        if (
            terminalId === null ||
            !shouldPollTerminalPreview({ isForeground, status, terminalId, visible })
        )
            return;
        const activeTerminalId = terminalId;
        let isActive = true;
        let isLoading = false;
        const loadPreview = async (): Promise<void> => {
            if (isLoading) return;
            isLoading = true;
            if (isActive)
                setPreviewState((current) =>
                    loadingTerminalPreviewState(current, activeTerminalId),
                );
            try {
                const next = await request('terminal.preview', { terminalId: activeTerminalId });
                if (isActive)
                    setPreviewState({
                        error: null,
                        isLoading: false,
                        preview: next,
                        terminalId: activeTerminalId,
                    });
            } catch {
                if (isActive)
                    setPreviewState((current) =>
                        failedTerminalPreviewState(current, activeTerminalId),
                    );
            } finally {
                isLoading = false;
            }
        };
        const poll = (): void => {
            // eslint-disable-next-line no-void -- The effect owns cancellation for this preview request.
            void loadPreview();
        };
        poll();
        const interval = setInterval(poll, POLL_INTERVAL_MS);
        return () => {
            isActive = false;
            clearInterval(interval);
        };
    }, [isForeground, request, retryAttempt, status, terminalId, visible]);

    const isMatching = terminalId !== null && previewState?.terminalId === terminalId;
    const isPolling = shouldPollTerminalPreview({ isForeground, status, terminalId, visible });
    return {
        error: isMatching ? previewState.error : null,
        isLoading: isPolling && (!isMatching || previewState.isLoading),
        preview: isMatching ? previewState.preview : null,
        refresh,
    };
};
