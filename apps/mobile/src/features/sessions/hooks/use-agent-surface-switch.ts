import { useCallback, useState } from 'react';
import { Alert } from 'react-native';

import type { TerminalSurface } from '@caxri/protocol';

import type { Translate } from '../../../i18n';
import { useTranslation } from '../../../i18n';
import { agentChatProviderName } from '../../agent-chat/agent-chat-model';
import { useMobileClient } from '../../connection/mobile-client-provider';
import { mobileErrorMessage } from '../../connection/mobile-error-message';
import { agentSurfaceSwitchTarget } from '../agent-surface-switch';
import { useHostSessions } from '../components/host-sessions-provider';
import type { MobileSessionItem } from '../session-model';

/**
 * Asks before a switch ends the Agent's running turn, with Desktop's words. Dismissing the alert counts as Cancel.
 */
const confirmStopRunningTurn = (
    surface: TerminalSurface,
    provider: string,
    t: Translate,
): Promise<boolean> =>
    new Promise((resolve) => {
        Alert.alert(
            t('sessions.surface.turnGuardTitle'),
            t(
                surface === 'chat'
                    ? 'sessions.surface.confirmSwitchToChat'
                    : 'sessions.surface.confirmSwitchToTerminal',
                { provider },
            ),
            [
                { onPress: () => resolve(false), style: 'cancel', text: t('common.cancel') },
                {
                    onPress: () => resolve(true),
                    style: 'destructive',
                    text: t('sessions.surface.confirmSwitchLabel'),
                },
            ],
            { cancelable: true, onDismiss: () => resolve(false) },
        );
    });

/**
 * "Open as Chat" / "Open as Terminal" for the Session's primary Agent, through the same `terminal.switchSurface` the
 * Desktop tab rail calls. A running turn is never ended silently: the Server reports it, and only an explicit "Stop and
 * Switch" retries with `interruptTurn`. On success the Session is re-read so the detail renders the new surface, and
 * `onSwitched` moves to the tab that shows it.
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
    const terminal = session.primaryTerminal;
    const target = agentSurfaceSwitchTarget(terminal);
    const switchSurface = useCallback(async (): Promise<void> => {
        if (!terminal || !target || pending) return;
        setPending(target);
        setError(null);
        try {
            const send = (shouldInterruptTurn: boolean) =>
                request('mobile.terminal.switchSurface', {
                    terminalId: terminal.id,
                    surface: target,
                    interruptTurn: shouldInterruptTurn,
                });
            let result = await send(false);
            if (result.status === 'turnRunning') {
                const isConfirmed = await confirmStopRunningTurn(
                    target,
                    agentChatProviderName(terminal, t),
                    t,
                );
                if (!isConfirmed) return;
                result = await send(true);
            }
            if (result.status !== 'switched') return;
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
    }, [onSwitched, pending, request, sessions, t, target, terminal]);
    return { error, pending, switchSurface, target };
};
