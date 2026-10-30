import { useCallback, useEffect, useSyncExternalStore } from 'react';

import { encodeHex } from '@caxri/mobile-transport';
import { MOBILE_AGENT_SUBMIT_MAX_BYTES } from '@caxri/protocol';
import * as Crypto from 'expo-crypto';

import type { Translate } from '../../../i18n';
import { useTranslation } from '../../../i18n';
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

const submitFailureMessage = (error: MobileGatewayRequestError, t: Translate): string => {
    switch (error.code) {
        case 'FORBIDDEN':
            return t('sessions.composer.submitForbidden');
        case 'NOT_FOUND':
            return t('sessions.composer.submitNotFound');
        case 'UNAVAILABLE':
            return t('sessions.composer.submitUnavailable');
        case 'CONFLICT':
            return t('sessions.composer.submitConflict');
        default:
            return t('sessions.composer.submitFailed');
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
    attachmentIds,
    attachmentWaitReason,
    fileAttachmentIds,
    onAttachmentsSent,
    deviceRole,
    draft,
    hostId,
    isConnected,
    onDraftChange,
    onRefresh,
    session,
}: {
    attachmentIds: string[];
    /**
     * Why Send waits on the attached images, or `null` once they are all uploaded.
     */
    attachmentWaitReason: string | null;
    /**
     * Uploaded files the Agent receives as paths after the text.
     */
    fileAttachmentIds: string[];
    onAttachmentsSent: () => void;
    deviceRole: 'view' | 'reply' | 'control' | null;
    draft: string;
    hostId: string;
    isConnected: boolean;
    onDraftChange: (draft: string) => void;
    onRefresh: () => Promise<void>;
    session: MobileSessionItem;
}) => {
    const { request } = useMobileClient();
    const { t } = useTranslation();
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
            session.agentActivityState,
        );
        if (next !== delivery) sessionComposerDeliveryStore.set(stateKey, next);
    }, [currentEndpoint, delivery, session.agentActivityState, stateKey, terminalProcessState]);
    const isBusy = delivery.kind === 'sending' || delivery.kind === 'stopping';
    const isSending = delivery.kind === 'sending';
    const isRunning = session.agentActivityState === 'running';
    const hasPendingAttachment = attachmentWaitReason !== null;
    const isShowStop =
        isRunning &&
        draft.trim().length === 0 &&
        attachmentIds.length === 0 &&
        fileAttachmentIds.length === 0 &&
        !hasPendingAttachment;
    const targetReason = isShowStop
        ? stopDisabledReason(session, isConnected, deviceRole, t)
        : composerDisabledReason(session, isConnected, deviceRole, t);
    const inputError =
        draft.trim().length === 0
            ? null
            : composerTextError(draft, MOBILE_AGENT_SUBMIT_MAX_BYTES, t);
    const disabledReason = targetReason ?? attachmentWaitReason ?? inputError;
    const canSubmit =
        !isBusy &&
        !disabledReason &&
        (isShowStop ||
            draft.trim().length > 0 ||
            attachmentIds.length > 0 ||
            fileAttachmentIds.length > 0);

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
                        ? { kind: 'stop-failed', message: t('sessions.composer.stopFailed') }
                        : { kind: 'stop-unknown' },
                );
            }
            return;
        }
        if (!session.primaryAgentTerminalId) return;
        const text =
            draft.trim().length > 0
                ? draft
                : fileAttachmentIds.length > 0
                  ? 'Please inspect the attached files.'
                  : 'Please inspect the attached image.';
        const attemptKey = JSON.stringify([text, attachmentIds, fileAttachmentIds]);
        const mutationId = composerMutationIdForAttempt(
            current,
            attemptKey,
            () => `mobile_submit_${encodeHex(Crypto.getRandomBytes(16))}`,
        );
        sessionComposerDeliveryStore.set(stateKey, {
            kind: 'sending',
            mutationId,
            text: attemptKey,
        });
        try {
            const result = await request('mobile.agent.submit', {
                sessionId: session.id,
                terminalId: session.primaryAgentTerminalId,
                endpoint: session.primaryAgentEndpoint,
                clientMutationId: mutationId,
                text,
                attachmentIds,
                ...(fileAttachmentIds.length > 0 && { fileAttachmentIds }),
            });
            if (result.outcome === 'unknown') {
                sessionComposerDeliveryStore.set(stateKey, {
                    kind: 'unknown',
                    mutationId,
                    text: attemptKey,
                });
                return;
            }
            onDraftChange('');
            onAttachmentsSent();
            sessionComposerDeliveryStore.set(stateKey, { kind: 'accepted', mutationId });
            await refreshAfterAcceptedAction(onRefresh);
        } catch (error) {
            sessionComposerDeliveryStore.set(
                stateKey,
                error instanceof MobileGatewayRequestError
                    ? { kind: 'failed', message: submitFailureMessage(error, t) }
                    : error instanceof Error && error.message === 'Caxri is reconnecting.'
                      ? { kind: 'failed', message: t('sessions.composer.reconnectToResend') }
                      : { kind: 'unknown', mutationId, text: attemptKey },
            );
        }
    }, [
        attachmentIds,
        canSubmit,
        fileAttachmentIds,
        draft,
        onAttachmentsSent,
        onDraftChange,
        onRefresh,
        request,
        session,
        isShowStop,
        stateKey,
        t,
    ]);

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
