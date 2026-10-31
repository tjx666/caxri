import { useEffect, useRef, useState } from 'react';

import type { AgentAction } from '@caxri/protocol';
import {
    agentChatDraftWithReturnedMessage,
    agentChatTextWithPathReferences,
    parseAgentChatCommand,
    sentenceStartProvider,
} from '@caxri/protocol';
import * as Crypto from 'expo-crypto';

import { useTranslation } from '../../i18n';
import type { FileAttachments } from '../sessions/hooks/use-file-attachments';
import type { useImageAttachments } from '../sessions/hooks/use-image-attachments';
import { shouldHoldAgentChatSendAsText } from './agent-chat-commands';
import type { AgentChatHandoffSource } from './agent-chat-handoff';
import { agentChatHandoffText } from './agent-chat-handoff';
import { isAgentChatStopping } from './agent-chat-model';
import { sendAgentChatMessageOptimistically } from './agent-chat-pending';
import type { AgentChatController } from './use-agent-chat';
import { useAgentChatCommandRun } from './use-agent-chat-command-run';

/**
 * Runs the composer's one action (send, or Stop on an empty draft during a turn) and keeps its error state. A message
 * leaves the composer at once and shows as `Sending…` where it lands, as on Desktop (`agent-chat-pending.ts`); a failed
 * send puts its text, images, and files back ahead of anything typed since. Files reach the Agent as paths cited ahead
 * of the text, as Desktop's file cards do, so the pending row already shows them as the chips the sent message will
 * have. Stop stays pending, keyed by the turn it stopped, until that turn ends, like the Desktop composer and the
 * Terminal composer's "Stopping Agent…" state; the interrupt request returning only means the provider was asked. A
 * draft naming a listed slash command runs it instead of sending (`useAgentChatCommandRun`); a bare `/word` the menu
 * has no row for is held once, as Desktop's first Enter is, and a second tap on the same draft sends it as text
 * (`shouldHoldAgentChatSendAsText`).
 */
export const useAgentChatComposerAction = ({
    activeTurnId,
    chat,
    draft,
    files,
    images,
    handoffSource,
    isStopAction,
    menuMatches,
    onDraftChange,
    provider,
}: {
    activeTurnId: string | undefined;
    chat: AgentChatController;
    draft: string;
    files: FileAttachments;
    images: ReturnType<typeof useImageAttachments>;
    /**
     * What a `/new-session` draft names: this Chat's Session, its Project, and its Agent.
     */
    handoffSource: AgentChatHandoffSource;
    isStopAction: boolean;
    /**
     * The command menu's rows for `draft` (`agentChatMenuMatches`).
     */
    menuMatches: readonly AgentAction[] | undefined;
    onDraftChange: (draft: string) => void;
    provider: string;
}) => {
    const { t } = useTranslation();
    const [stoppingTurnId, setStoppingTurnId] = useState<string>();
    const [error, setError] = useState<string | null>(null);
    const [isSendingEdit, setSendingEdit] = useState(false);
    /**
     * The draft a first tap was held for because no command matches it. Any edit ends the confirmation; reset during
     * render, as Desktop's command menu does.
     */
    const [confirmedDraft, setConfirmedDraft] = useState<string>();
    if (confirmedDraft !== undefined && confirmedDraft !== draft) setConfirmedDraft(undefined);
    const isStopping = isAgentChatStopping(stoppingTurnId, activeTurnId);
    /**
     * What the user has typed by the time a send fails, so the returned message goes ahead of it.
     */
    const latestDraft = useRef(draft);
    useEffect(() => {
        latestDraft.current = draft;
    }, [draft]);
    const commands = useAgentChatCommandRun({ chat, onDraftChange, reportError: setError });
    const run = async (delivery?: 'steer'): Promise<void> => {
        setError(null);
        if (isStopAction) {
            if (!activeTurnId || isStopping) return;
            setStoppingTurnId(activeTurnId);
            try {
                await chat.interrupt();
            } catch {
                setStoppingTurnId(undefined);
                setError(
                    t('chat.composer.stopFailed', { provider: sentenceStartProvider(provider) }),
                );
            }
            return;
        }
        /**
         * An edit sends its text as the replacement message, never as a command. It shows at once as a pending row
         * while the message it replaces and everything after it leave the timeline (`replaces`); the composer gets back
         * the draft the edit held. A failed edit brings the old content back and puts the edit, with its text, back.
         */
        const edit = chat.editing;
        if (edit) {
            if (chat.pendingKey === null) return;
            const text = draft.trim();
            setSendingEdit(true);
            try {
                await sendAgentChatMessageOptimistically({
                    clearComposer: () => {
                        chat.setEditing(undefined);
                        onDraftChange(edit.previousDraft);
                    },
                    key: chat.pendingKey,
                    message: {
                        id: Crypto.randomUUID(),
                        text,
                        imageUris: [],
                        delivery: undefined,
                        replaces: edit.itemId,
                    },
                    reportError: (message) =>
                        setError(message === null ? null : t('chat.edit.failed')),
                    returnUnsent: () => {
                        chat.setEditing(edit);
                        onDraftChange(text);
                    },
                    send: () => chat.rewind(edit.itemId, text),
                    snapshot: chat.snapshot,
                });
            } finally {
                setSendingEdit(false);
            }
            return;
        }
        if (shouldHoldAgentChatSendAsText({ confirmedDraft, draft, matches: menuMatches })) {
            setConfirmedDraft(draft);
            return;
        }
        /**
         * `/new-session [next task]` is Caxri's own command: it sends the hand-off instructions as an ordinary message,
         * ahead of any provider command of that name. When the Project or Agent is unknown it says so rather than send
         * the literal command to the Agent.
         */
        const handoff = agentChatHandoffText(draft, handoffSource);
        if (handoff === null) {
            setError(t('chat.handoff.unavailable'));
            return;
        }
        const command =
            handoff === undefined && parseAgentChatCommand(draft, chat.snapshot?.commands);
        if (command) {
            await commands.run(command);
            return;
        }
        if (chat.pendingKey === null) return;
        const text = draft.trim();
        const sentText = handoff ?? text;
        const sentImages = images.attachments;
        const references = images.readyChatImages;
        const sentFiles = files.attachments;
        const message = agentChatTextWithPathReferences(
            sentText,
            files.readyPaths.map((path) => ({ path, isDirectory: false })),
            provider,
        );
        await sendAgentChatMessageOptimistically({
            clearComposer: () => {
                onDraftChange('');
                images.clear();
                files.clear();
            },
            key: chat.pendingKey,
            message: {
                id: Crypto.randomUUID(),
                text: message,
                imageUris: sentImages.map((image) => image.uri),
                delivery,
            },
            reportError: setError,
            returnUnsent: () => {
                if (text)
                    onDraftChange(agentChatDraftWithReturnedMessage(latestDraft.current, text));
                images.restore(sentImages);
                files.restore(sentFiles);
            },
            send: () => chat.send(message, references, delivery, files.readyIds),
            snapshot: chat.snapshot,
        });
    };
    return {
        chooseCommand: commands.choose,
        confirmsSendAsText: confirmedDraft === draft,
        error,
        isRunningCommand: commands.isRunning,
        isSendingEdit,
        isStopping,
        run,
    };
};
