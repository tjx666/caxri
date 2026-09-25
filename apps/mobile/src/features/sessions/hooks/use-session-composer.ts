import { useCallback, useEffect, useSyncExternalStore } from 'react';

import { encodeHex } from '@caxri/mobile-transport';
import { MOBILE_AGENT_SUBMIT_MAX_BYTES } from '@caxri/protocol';
import * as Crypto from 'expo-crypto';

import { useMobileClient } from '../../connection/mobile-client-provider';
import { MobileGatewayRequestError } from '../../connection/mobile-gateway-client';
import {
    composerByteLength,
    composerDisabledReason,
    composerMutationIdForAttempt,
    composerTextError,
    reconcileStopWithSession,
    sessionComposerDeliveryStore,
    stopDisabledReason,
} from '../session-composer-state';
import type { MobileSessionItem } from '../session-model';

const submitFailureMessage = (error: MobileGatewayRequestError): string => {
    switch (error.code) {
        case 'FORBIDDEN':
            return 'This device no longer has access to this Agent. Your message was kept.';
        case 'NOT_FOUND':
            return 'The Agent target changed. Refresh the Session before sending again.';
        case 'UNAVAILABLE':
            return 'The Agent is unavailable. Your message was kept.';
        case 'CONFLICT':
            return 'This send attempt conflicted with another request. Your message was kept.';
        default:
            return 'The message was not sent. Your draft was kept.';
    }
};

const refreshAfterAcceptedAction = async (onRefresh: () => Promise<void>): Promise<void> => {
    try {
        await onRefresh();
    } catch {
        // The accepted command is final; a dashboard refresh has independent recovery.
    }
};

export const useSessionComposer = ({
    deviceRole,
    draft,
    hostId,
    isConnected,
    onDraftChange,
    onRefresh,
    session,
}: {
    deviceRole: 'view' | 'reply' | 'control' | null;
    draft: string;
    hostId: string;
    isConnected: boolean;
    onDraftChange: (draft: string) => void;
    onRefresh: () => Promise<void>;
    session: MobileSessionItem;
}) => {
    const { request } = useMobileClient();
    const stateKey = `${hostId}\u{0}${session.id}`;
    const subscribe = useCallback(
        (listener: () => void) => sessionComposerDeliveryStore.subscribe(stateKey, listener),
        [stateKey],
    );
    const snapshot = useCallback(() => sessionComposerDeliveryStore.get(stateKey), [stateKey]);
    const delivery = useSyncExternalStore(subscribe, snapshot, snapshot);
    const currentEndpoint = session.primaryAgentEndpoint;
    const terminalProcessState = session.primaryTerminal?.lastProcessState;
    useEffect(() => {
        const next = reconcileStopWithSession(
            delivery,
            currentEndpoint,
            terminalProcessState,
            session.lastActivityState,
        );
        if (next !== delivery) sessionComposerDeliveryStore.set(stateKey, next);
    }, [currentEndpoint, delivery, session.lastActivityState, stateKey, terminalProcessState]);
    const isBusy = delivery.kind === 'sending' || delivery.kind === 'stopping';
    const isSending = delivery.kind === 'sending';
    const isRunning = session.lastActivityState === 'running';
    const isShowStop = isRunning && draft.trim().length === 0;
    const targetReason = isShowStop
        ? stopDisabledReason(session, isConnected, deviceRole)
        : composerDisabledReason(session, isConnected, deviceRole);
    const inputError =
        isShowStop || draft.length === 0
            ? null
            : composerTextError(draft, MOBILE_AGENT_SUBMIT_MAX_BYTES);
    const disabledReason = targetReason ?? inputError;
    const canSubmit = !isBusy && !disabledReason && (isShowStop || draft.trim().length > 0);

    const updateDraft = useCallback(
        (value: string): void => {
            if (isBusy) return;
            if (value === draft) return;
            sessionComposerDeliveryStore.set(stateKey, { kind: 'idle' });
            onDraftChange(value);
        },
        [draft, isBusy, onDraftChange, stateKey],
    );

    const submit = useCallback(async (): Promise<void> => {
        if (!canSubmit || !session.primaryAgentEndpoint) return;
        const current = sessionComposerDeliveryStore.get(stateKey);
        if (current.kind === 'sending' || current.kind === 'stopping') return;
        if (isShowStop) {
            sessionComposerDeliveryStore.set(stateKey, {
                kind: 'stopping',
                endpoint: session.primaryAgentEndpoint,
            });
            try {
                await request('agent.control.interrupt', {
                    endpoint: session.primaryAgentEndpoint,
                });
                await refreshAfterAcceptedAction(onRefresh);
            } catch (error) {
                if (sessionComposerDeliveryStore.get(stateKey).kind !== 'stopping') return;
                sessionComposerDeliveryStore.set(
                    stateKey,
                    error instanceof MobileGatewayRequestError
                        ? { kind: 'stop-failed', message: 'The Agent was not stopped. Try again.' }
                        : { kind: 'stop-unknown' },
                );
            }
            return;
        }
        if (!session.primaryAgentTerminalId) return;
        const mutationId = composerMutationIdForAttempt(
            current,
            draft,
            () => `mobile_submit_${encodeHex(Crypto.getRandomBytes(16))}`,
        );
        const text = draft;
        sessionComposerDeliveryStore.set(stateKey, { kind: 'sending', mutationId, text });
        try {
            const result = await request('mobile.agent.submit', {
                sessionId: session.id,
                terminalId: session.primaryAgentTerminalId,
                endpoint: session.primaryAgentEndpoint,
                clientMutationId: mutationId,
                text,
            });
            if (result.outcome === 'unknown') {
                sessionComposerDeliveryStore.set(stateKey, { kind: 'unknown', mutationId, text });
                return;
            }
            onDraftChange('');
            sessionComposerDeliveryStore.set(stateKey, { kind: 'accepted', mutationId });
            await refreshAfterAcceptedAction(onRefresh);
        } catch (error) {
            sessionComposerDeliveryStore.set(
                stateKey,
                error instanceof MobileGatewayRequestError
                    ? { kind: 'failed', message: submitFailureMessage(error) }
                    : error instanceof Error && error.message === 'Caxri is reconnecting.'
                      ? { kind: 'failed', message: 'Reconnect to Caxri before sending again.' }
                      : { kind: 'unknown', mutationId, text },
            );
        }
    }, [canSubmit, draft, onDraftChange, onRefresh, request, session, isShowStop, stateKey]);

    return {
        byteLength: composerByteLength(draft),
        canSubmit,
        delivery,
        disabledReason,
        sending: isSending,
        showStop: isShowStop,
        submit,
        updateDraft,
    };
};
