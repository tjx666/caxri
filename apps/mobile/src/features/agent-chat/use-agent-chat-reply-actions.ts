import { createContext, useEffect, useMemo, useRef } from 'react';
import { Share } from 'react-native';

import * as Clipboard from 'expo-clipboard';
import * as Crypto from 'expo-crypto';

import { showToast } from '../../components/toast-store';
import { useTranslation } from '../../i18n';
import type { ConversationMessageTarget } from '../conversation/conversation-message-actions';
import { conversationActionText } from '../conversation/conversation-user-text';
import { messageReadErrorText, MessageReadOfflineError } from '../conversation/read-whole-message';
import { isAgentChatMessageClipped } from './agent-chat-message-edit';
import { sendAgentChatMessageOptimistically } from './agent-chat-pending';
import type { AgentChatReplyAvailability } from './agent-chat-reply-actions';
import { agentChatReplyFork, agentChatReplyRetry } from './agent-chat-reply-actions';
import type { AgentChatController } from './use-agent-chat';
import { useOpenSession } from './use-open-session';

/**
 * A reply action the More menu lists: whether it can run now, and running it.
 */
export interface AgentChatReplyAction {
    availability: AgentChatReplyAvailability;
    run: () => void;
}

/**
 * What a reply's action bar does, provided by the Chat view, which holds the controller and the window the actions read
 * from. A list without it (a terminal Agent's Conversation) draws no action bar.
 */
export interface AgentChatReplyHandlers {
    copy: (replyId: string) => void;
    share: (replyId: string) => void;
    selectText: (replyId: string) => void;
    /**
     * Undefined on a device without the control role, which cannot fork.
     */
    fork: (turnId: string) => AgentChatReplyAction | undefined;
    /**
     * Undefined when the turn's own message is not in what the phone holds, so Retry has nothing to send.
     */
    retry: (turnId: string) => AgentChatReplyAction | undefined;
}

export const AgentChatReplyActionsContext = createContext<AgentChatReplyHandlers | null>(null);

/**
 * A message's whole text for Copy, Share, and Retry. While the phone is connected Server Core supplies it, since the
 * window may hold only its tail; offline, or when the message left Core's projection, the held text serves unless that
 * is only a tail. A Desktop hand-off message reads as the user's note.
 */
export async function readAgentChatMessageText(
    chat: Pick<AgentChatController, 'readMessage'>,
    isConnected: boolean,
    message: Pick<ConversationMessageTarget, 'id' | 'text'>,
): Promise<string> {
    const isClipped = isAgentChatMessageClipped(message.text);
    if (!isConnected) {
        if (isClipped) throw new MessageReadOfflineError();
        return message.text;
    }
    try {
        return conversationActionText(await chat.readMessage(message.id));
    } catch (error) {
        if (isClipped) throw error;
        return message.text;
    }
}

/**
 * The handlers behind every reply's action bar. Copy and Share read the reply's whole text; Fork opens the new Session
 * once Server Core created it; Retry sends the turn's message again in its place, shown at once as a pending row the
 * way "Edit from Here" sends it.
 */
export function useAgentChatReplyActions({
    canFork,
    canSend,
    chat,
    isConnected,
    onSelectText,
    snapshot,
}: {
    canFork: boolean;
    canSend: boolean;
    chat: AgentChatController;
    isConnected: boolean;
    onSelectText: (message: ConversationMessageTarget) => void;
    /**
     * The window with the older pages the reader loaded, so an older reply finds its turn.
     */
    snapshot: AgentChatController['snapshot'];
}): AgentChatReplyHandlers {
    const { t } = useTranslation();
    const openSession = useOpenSession();
    const isLive = isConnected && chat.savedAt === undefined;
    /**
     * The handlers keep one identity for the Chat's life and read the latest state when pressed, so a streamed patch
     * never redraws every reply's bar.
     */
    const latest = useRef({
        canFork,
        canSend,
        chat,
        isConnected,
        isLive,
        onSelectText,
        openSession,
        snapshot,
        t,
    });
    useEffect(() => {
        latest.current = {
            canFork,
            canSend,
            chat,
            isConnected,
            isLive,
            onSelectText,
            openSession,
            snapshot,
            t,
        };
    });
    return useMemo(() => {
        const message = (id: string): ConversationMessageTarget => {
            const item = latest.current.snapshot?.items.find((candidate) => candidate.id === id);
            return {
                id,
                role: item?.type === 'userMessage' ? 'user' : 'agent',
                text: item && 'text' in item ? item.text : '',
            };
        };
        const read = (id: string) =>
            readAgentChatMessageText(latest.current.chat, latest.current.isConnected, message(id));
        const withText = (id: string, then: (text: string) => Promise<void>) => {
            void read(id)
                .then(then)
                .catch((error: unknown) => {
                    showToast('error', messageReadErrorText(error, latest.current.t));
                });
        };
        const offline = (): AgentChatReplyAvailability => ({
            canRun: false,
            reason: latest.current.t('chat.disabled.send.offline'),
        });
        return {
            copy: (replyId) =>
                withText(replyId, async (text) => {
                    const { t } = latest.current;
                    try {
                        await Clipboard.setStringAsync(text);
                        showToast('success', t('conversation.message.copied'));
                    } catch {
                        showToast('error', t('conversation.message.copyFailed'));
                    }
                }),
            share: (replyId) =>
                withText(replyId, async (text) => {
                    await Share.share({ message: text });
                }),
            selectText: (replyId) => latest.current.onSelectText(message(replyId)),
            fork: (turnId) => {
                const { canFork, chat, isLive, openSession, snapshot, t } = latest.current;
                if (!canFork) return;
                const target = agentChatReplyFork(snapshot, turnId, t);
                return {
                    availability: isLive ? target.availability : offline(),
                    run: () => {
                        void chat
                            .fork(target.itemId)
                            .then(openSession)
                            .catch(() => {
                                showToast('error', t('sessions.manage.forkFailed'));
                            });
                    },
                };
            },
            retry: (turnId) => {
                const { canSend, chat, isLive, snapshot, t } = latest.current;
                if (!canSend) return;
                const target = agentChatReplyRetry(snapshot, turnId, t);
                if (!target) return;
                return {
                    availability: isLive ? target.availability : offline(),
                    run: () =>
                        withText(target.itemId, async (text) => {
                            if (chat.pendingKey === null) return;
                            await sendAgentChatMessageOptimistically({
                                clearComposer: () => {},
                                key: chat.pendingKey,
                                message: {
                                    id: Crypto.randomUUID(),
                                    text,
                                    imageUris: [],
                                    delivery: undefined,
                                    replaces: target.itemId,
                                },
                                reportError: (error) => {
                                    if (error !== null)
                                        showToast('error', t('chat.reply.retryFailed'));
                                },
                                returnUnsent: () => {},
                                send: () => chat.rewind(target.itemId, text),
                                snapshot: chat.snapshot,
                            });
                        }),
                };
            },
        };
    }, []);
}
