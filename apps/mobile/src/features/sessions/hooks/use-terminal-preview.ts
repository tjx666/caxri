import { useEffect, useState } from 'react';

import type { TerminalPreview } from '@caxri/protocol';

import type { MobileConnectionStatus } from '../../connection/connection-state';
import { useMobileClient } from '../../connection/mobile-client-provider';

const POLL_INTERVAL_MS = 2_500;

export const shouldPollTerminalPreview = ({
    status,
    terminalId,
    visible,
}: {
    status: MobileConnectionStatus;
    terminalId: string | null;
    visible: boolean;
}): boolean => status === 'connected' && visible && terminalId !== null;

export const useTerminalPreview = ({
    terminalId,
    visible,
}: {
    terminalId: string | null;
    visible: boolean;
}): TerminalPreview | null => {
    const { request, status } = useMobileClient();
    const [previewState, setPreviewState] = useState<{
        preview: TerminalPreview;
        terminalId: string;
    } | null>(null);

    useEffect(() => {
        if (terminalId === null || !shouldPollTerminalPreview({ status, terminalId, visible }))
            return;
        const activeTerminalId = terminalId;
        let isActive = true;
        let isLoading = false;
        const loadPreview = async (): Promise<void> => {
            if (isLoading) return;
            isLoading = true;
            try {
                const next = await request('terminal.preview', { terminalId: activeTerminalId });
                if (isActive) setPreviewState({ preview: next, terminalId: activeTerminalId });
            } catch {
                // The preserved Session state and connection banner already explain transient failures.
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
    }, [request, status, terminalId, visible]);

    return terminalId !== null && previewState?.terminalId === terminalId
        ? previewState.preview
        : null;
};
