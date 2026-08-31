import { useState } from 'react';

import { MOBILE_SHORT_REPLY_MAX_BYTES } from '@caxri/protocol';

import { useMobileClient } from '../../connection/mobile-client-provider';
import type { MobileSessionItem } from '../session-model';
import { shortReplyDisabledReason } from '../session-model';

const textEncoder = new TextEncoder();

export const shortReplyByteLength = (value: string): number => textEncoder.encode(value).byteLength;

export const acceptedShortReplyDraft = (current: string, next: string): string =>
    shortReplyByteLength(next) <= MOBILE_SHORT_REPLY_MAX_BYTES ? next : current;

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
    const [sending, setSending] = useState(false);
    const [sendError, setSendError] = useState<string | null>(null);
    const disabledReason = shortReplyDisabledReason(session, isConnected);
    const byteLength = shortReplyByteLength(draft);
    const canSend = !disabledReason && draft.trim().length > 0 && !sending;

    const updateDraft = (value: string): void => {
        setDraft((current) => acceptedShortReplyDraft(current, value));
    };

    const send = async (): Promise<void> => {
        if (!canSend || !session.primaryAgentTerminalId) return;
        setSending(true);
        setSendError(null);
        try {
            await client.request('terminal.send', {
                terminalId: session.primaryAgentTerminalId,
                attentionEpoch: session.attentionEpoch,
                text: draft.trim(),
                enter: true,
            });
            setDraft('');
            await onRefresh();
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
        send,
        sendError,
        sending,
        updateDraft,
    };
};
