import type { MouseEvent, RefObject } from 'react';
import { useState } from 'react';

import { agentChatTextWithSessionMentions, parseAgentChatPathReferences } from '@caxri/protocol';

import { useContextMenu } from '../../../hooks/use-context-menu';
import { translate } from '../../../i18n';
import { cachedAgentChatSnapshot } from '../agent-chat-client';
import {
    agentChatRestoreKey,
    changeAgentChatGoal,
    useAgentChatRestoreStore,
} from '../agent-chat-commands';
import { isAgentChatGoalOffered } from '../composer-input/agent-chat-slash-commands';
import {
    agentChatSelectionInside,
    copyAgentChatMessageFromMenu,
    quoteAgentChatMessageFromMenu,
} from '../messages/agent-chat-message-menu-actions';
import { agentChatUserMessageMenu } from '../messages/agent-chat-user-message-menu';
import { useAgentChatEdit } from './use-agent-chat-edit';
import { useAgentChatReadBackHistory } from './use-agent-chat-read-back-history';
import { useAgentChatTerminal } from './use-agent-chat-terminal';

/**
 * A user message's Fork and Restore Code to Here in-flight states, shared by its hover-row buttons and its right-click
 * menu so neither can start a second one, and the `onContextMenu` handler that opens the menu built by
 * {@link agentChatUserMessageMenu}.
 */
export function useAgentChatUserMessageMenu({
    container,
    id,
    text,
}: {
    container: RefObject<HTMLElement | null>;
    id: string;
    text: string;
}): {
    isForking: boolean;
    isRestoring: boolean;
    fork: () => void;
    onContextMenu: (event: MouseEvent) => void;
} {
    const edit = useAgentChatEdit();
    const readBackHistory = useAgentChatReadBackHistory();
    const terminalId = useAgentChatTerminal();
    const [isForking, setIsForking] = useState(false);
    const isRestoring = useAgentChatRestoreStore(
        ({ restoring }) =>
            terminalId !== undefined && restoring.has(agentChatRestoreKey(terminalId, id)),
    );
    const fork = (): void => {
        const run = edit?.fork?.run;
        if (!run || isForking) return;
        setIsForking(true);
        void run(id, text).finally(() => setIsForking(false));
    };
    const onContextMenu = useContextMenu(() => {
        const selectedText = agentChatSelectionInside(container.current);
        /**
         * A message read back from history is outside the projection the rewind actions work on: list Edit and Fork
         * disabled with why, rather than leave the menu looking as if they never existed.
         */
        const historyReason =
            !edit && readBackHistory
                ? translate('agentChat.userMenu.historyUnavailable')
                : undefined;
        // Copy takes the user's words, not the file and folder references the provider received ahead of them, and
        // names each cited Session by its `@title` rather than its reference file.
        const words = agentChatTextWithSessionMentions(parseAgentChatPathReferences(text).text);
        return agentChatUserMessageMenu({
            text: words,
            selectedText,
            edit: edit ? edit.availability(id) : historyReason,
            fork: edit
                ? edit.fork?.availability(id)
                : readBackHistory?.canFork === true
                  ? historyReason
                  : undefined,
            restore: edit?.restore?.availability(id),
            isForking,
            isRestoring,
            onCopy: (value) => copyAgentChatMessageFromMenu(value, value !== words),
            onQuote:
                terminalId === undefined
                    ? undefined
                    : (value) => quoteAgentChatMessageFromMenu(terminalId, value),
            onSetGoal:
                terminalId !== undefined &&
                isAgentChatGoalOffered(cachedAgentChatSnapshot(terminalId)?.commands)
                    ? (objective) => changeAgentChatGoal(terminalId, { action: 'set', objective })
                    : undefined,
            onEdit: () => edit?.startEdit(id, text),
            onFork: fork,
            onRestore: () => {
                if (!isRestoring) edit?.restore?.run(id);
            },
        });
    });
    return { isForking, isRestoring, fork, onContextMenu };
}
