import { useState } from 'react';

import { MOBILE_SHORT_REPLY_MAX_BYTES } from '@caxri/protocol';

import { useMobileClient } from '../../connection/mobile-client-provider';
import type { MobileSessionItem } from '../session-model';
import { shortReplyDisabledReason } from '../session-model';

const textEncoder = new TextEncoder();

interface DeliveredReply {
    attentionEpoch: number;
    sessionId: string;
}

export const shortReplyByteLength = (value: string): number => textEncoder.encode(value).byteLength;

export const acceptedShortReplyDraft = (current: string, next: string): string =>
    shortReplyByteLength(next) <= MOBILE_SHORT_REPLY_MAX_BYTES ? next : current;

export const isDeliveredReplyCurrent = (
    deliveredReply: DeliveredReply | null,
    session: Pick<MobileSessionItem, 'attentionEpoch' | 'id'>,
): boolean =>
    deliveredReply?.sessionId === session.id &&
    deliveredReply.attentionEpoch === session.attentionEpoch;

export const useShortReply = ({
    isConnected,
    onRefresh,
    session,
}: {
    isConnected: boolean;
    onRefresh: () => Promise<void>;
    session: MobileSessionItem;
}) => {
    const client = useMobileClient();
    const [draft, setDraft] = useState('');
    const [deliveredReply, setDeliveredReply] = useState<DeliveredReply | null>(null);
    const [sending, setSending] = useState(false);
    const [sendError, setSendError] = useState<string | null>(null);
    const disabledReason = shortReplyDisabledReason(session, isConnected);
    const byteLength = shortReplyByteLength(draft);
    const canSend = !disabledReason && draft.trim().length > 0 && !sending;
    const isReplySent = isDeliveredReplyCurrent(deliveredReply, session);

    const updateDraft = (value: string): void => {
        setDeliveredReply(null);
        setDraft((current) => acceptedShortReplyDraft(current, value));
    };

    const send = async (): Promise<void> => {
        if (!canSend || !session.primaryAgentTerminalId) return;
        setSending(true);
        setDeliveredReply(null);
        setSendError(null);
        try {
            await client.request('terminal.send', {
                terminalId: session.primaryAgentTerminalId,
                attentionEpoch: session.attentionEpoch,
                text: draft.trim(),
                enter: true,
            });
            setDraft('');
            setDeliveredReply({
                attentionEpoch: session.attentionEpoch,
                sessionId: session.id,
            });
            /**
             * A resolved Terminal request is the delivery boundary. The follow-up dashboard refresh owns its own error
             * UI and must not relabel an accepted reply as failed.
             */
            try {
                await onRefresh();
            } catch {
                return;
            }
        } catch {
            setSendError('The reply was not sent. Your draft has been kept.');
        } finally {
            setSending(false);
        }
    };

    return {
        byteLength,
        canSend,
        disabledReason,
        draft,
        replySent: isReplySent,
        send,
        sendError,
        sending,
        updateDraft,
    };
};
