import { useCallback, useEffect, useRef, useState } from 'react';

import type { TerminalSurface } from '@caxri/protocol';

import { useTranslation } from '../../../i18n';
import { agentChatProviderName } from '../../agent-chat/agent-chat-model';
import { useMobileClient } from '../../connection/mobile-client-provider';
import { mobileErrorMessage } from '../../connection/mobile-error-message';
import { agentSurfaceSwitchTarget } from '../agent-surface-switch';
import { useHostSessions } from '../components/host-sessions-provider';
import type { MobileSessionItem } from '../session-model';
import type { SessionScoped } from '../session-scoped-state';
import { patchSessionScoped, readSessionScoped } from '../session-scoped-state';

interface SurfaceSwitchState {
    isConfirming: boolean;
    error: string | null;
    pending: TerminalSurface | null;
}

const IDLE: SurfaceSwitchState = { error: null, isConfirming: false, pending: null };

/**
 * "Open as Chat" / "Open as Terminal" for the Session's primary Agent, through the same `terminal.switchSurface` the
 * Desktop tab rail calls. A running turn is never ended silently: the Server reports it, `confirmation` becomes
 * non-null so the header can show its confirmation sheet, and only `confirm` ("Stop and Switch") retries with
 * `interruptTurn`. On success the Session is re-read so the detail renders the new surface, and `onSwitched` moves to
 * the tab that shows it. State is kept per Session ID: on a tablet the detail stays mounted while the selection
 * changes, so a switch started on Session A must not show as pending or failed under Session B.
 */
export const useAgentSurfaceSwitch = (
    session: MobileSessionItem,
    onSwitched: (surface: TerminalSurface) => void,
) => {
    const { request } = useMobileClient();
    const { sessions } = useHostSessions();
    const { t } = useTranslation();
    const [states, setStates] = useState<SessionScoped<SurfaceSwitchState>>({});
    const sessionId = session.id;
    const { error, isConfirming, pending } = readSessionScoped(states, sessionId, IDLE);
    const patch = useCallback((id: string, next: Partial<SurfaceSwitchState>): void => {
        setStates((previous) => patchSessionScoped(previous, id, IDLE, next));
    }, []);
    /**
     * A switch finishing on Session A must not move Session B's tab, so completion checks the live selection.
     */
    const currentSessionId = useRef(sessionId);
    useEffect(() => {
        currentSessionId.current = sessionId;
    }, [sessionId]);
    const terminal = session.primaryTerminal;
    const target = agentSurfaceSwitchTarget(terminal);
    const run = useCallback(
        async (shouldInterruptTurn: boolean): Promise<void> => {
            if (!terminal || !target || pending) return;
            patch(sessionId, { error: null, pending: target });
            try {
                const result = await request('mobile.terminal.switchSurface', {
                    terminalId: terminal.id,
                    surface: target,
                    interruptTurn: shouldInterruptTurn,
                });
                if (result.status === 'turnRunning') {
                    patch(sessionId, { isConfirming: true });
                    return;
                }
                await sessions.refresh();
                if (currentSessionId.current === sessionId) onSwitched(target);
            } catch (error_) {
                patch(sessionId, {
                    error: mobileErrorMessage(
                        error_,
                        t(
                            target === 'chat'
                                ? 'sessions.surface.openAsChatFailed'
                                : 'sessions.surface.openAsTerminalFailed',
                        ),
                    ),
                });
            } finally {
                patch(sessionId, { pending: null });
            }
        },
        [onSwitched, patch, pending, request, sessionId, sessions, t, target, terminal],
    );
    const switchSurface = useCallback((): Promise<void> => run(false), [run]);
    const confirm = useCallback((): Promise<void> => run(true), [run]);
    const dismissConfirmation = useCallback(
        (): void => patch(sessionId, { isConfirming: false }),
        [patch, sessionId],
    );
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
