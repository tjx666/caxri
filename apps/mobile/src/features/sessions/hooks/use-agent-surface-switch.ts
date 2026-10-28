import { useCallback, useState } from 'react';

import type { TerminalSurface } from '@caxri/protocol';

import { useTranslation } from '../../../i18n';
import { agentChatProviderName } from '../../agent-chat/agent-chat-model';
import { useMobileClient } from '../../connection/mobile-client-provider';
import { mobileErrorMessage } from '../../connection/mobile-error-message';
import { agentSurfaceSwitchTarget } from '../agent-surface-switch';
import { useHostSessions } from '../components/host-sessions-provider';
import type { MobileSessionItem } from '../session-model';

/**
 * "Open as Chat" / "Open as Terminal" for the Session's primary Agent, through the same `terminal.switchSurface` the
 * Desktop tab rail calls. A running turn is never ended silently: the Server reports it, `confirmation` becomes
 * non-null so the header can show its confirmation sheet, and only `confirm` ("Stop and Switch") retries with
 * `interruptTurn`. On success the Session is re-read so the detail renders the new surface, and `onSwitched` moves to
 * the tab that shows it.
 */
export const useAgentSurfaceSwitch = (
    session: MobileSessionItem,
    onSwitched: (surface: TerminalSurface) => void,
) => {
    const { request } = useMobileClient();
    const { sessions } = useHostSessions();
    const { t } = useTranslation();
    const [pending, setPending] = useState<TerminalSurface | null>(null);
    const [error, setError] = useState<string | null>(null);
    const [isConfirming, setConfirming] = useState(false);
    const terminal = session.primaryTerminal;
    const target = agentSurfaceSwitchTarget(terminal);
    const run = useCallback(
        async (shouldInterruptTurn: boolean): Promise<void> => {
            if (!terminal || !target || pending) return;
            setPending(target);
            setError(null);
            try {
                const result = await request('mobile.terminal.switchSurface', {
                    terminalId: terminal.id,
                    surface: target,
                    interruptTurn: shouldInterruptTurn,
                });
                if (result.status === 'turnRunning') {
                    setConfirming(true);
                    return;
                }
                await sessions.refresh();
                onSwitched(target);
            } catch (error_) {
                setError(
                    mobileErrorMessage(
                        error_,
                        t(
                            target === 'chat'
                                ? 'sessions.surface.openAsChatFailed'
                                : 'sessions.surface.openAsTerminalFailed',
                        ),
                    ),
                );
            } finally {
                setPending(null);
            }
        },
        [onSwitched, pending, request, sessions, t, target, terminal],
    );
    const switchSurface = useCallback((): Promise<void> => run(false), [run]);
    const confirm = useCallback((): Promise<void> => run(true), [run]);
    const dismissConfirmation = useCallback((): void => setConfirming(false), []);
    return {
        confirm,
        /**
         * Set while a running turn waits on the user's "Stop and Switch"; the sheet names the Agent and the surface.
         */
        confirmation:
            isConfirming && terminal && target
                ? { provider: agentChatProviderName(terminal, t), target }
                : null,
        dismissConfirmation,
        error,
        pending,
        switchSurface,
        target,
    };
};
