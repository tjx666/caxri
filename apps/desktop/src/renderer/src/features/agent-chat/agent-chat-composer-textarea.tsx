import type { ClipboardEvent, RefObject } from 'react';

import { MAX_AGENT_CHAT_MESSAGE_LENGTH } from '@caxri/protocol';

import { Textarea } from '../../components/ui/textarea';
import { useTranslation } from '../../i18n';
import type { useAgentChatCommandMenu } from './hooks/use-agent-chat-command-menu';
import type { useAgentChatComposerEnter } from './hooks/use-agent-chat-composer-enter';
import type { useAgentChatComposerSend } from './hooks/use-agent-chat-composer-send';
import type { useAgentChatDraftStash } from './hooks/use-agent-chat-draft-stash';
import type { useAgentChatPromptHistory } from './hooks/use-agent-chat-prompt-history';
import type { useAgentChatSessionMenu } from './hooks/use-agent-chat-session-menu';

type ComposerSend = ReturnType<typeof useAgentChatComposerSend>;

/**
 * The composer's message input. Each key goes to the first owner that claims it, in this order: the draft stash
 * (Ctrl+S), the prompt history list, the slash-command menu, the `@` Sessions menu, Goal mode, and finally Enter and
 * Escape. The history list's highlighted prompt replaces the placeholder while it is open.
 */
export function AgentChatComposerTextarea({
    composerKeys,
    draft,
    goalMode,
    history,
    inputReference,
    isEditing,
    menu,
    menuActions,
    placeholder,
    sessionMenu,
    setDraft,
    setInputFocused,
    stash,
    onPaste,
}: {
    composerKeys: ReturnType<typeof useAgentChatComposerEnter>;
    draft: string;
    goalMode: ComposerSend['goalMode'];
    history: ReturnType<typeof useAgentChatPromptHistory>;
    inputReference: RefObject<HTMLTextAreaElement | null>;
    isEditing: boolean;
    menu: ReturnType<typeof useAgentChatCommandMenu>;
    menuActions: Pick<ComposerSend, 'choose' | 'complete'>;
    placeholder: string;
    sessionMenu: ReturnType<typeof useAgentChatSessionMenu>;
    setDraft: (update: (current: string) => string) => void;
    setInputFocused: (isFocused: boolean) => void;
    stash: ReturnType<typeof useAgentChatDraftStash>;
    onPaste: (event: ClipboardEvent<HTMLTextAreaElement>) => void;
}) {
    const { t } = useTranslation();
    return (
        // Starts three lines tall, as chat composers do, so an empty box still reads as the place to write a message
        // rather than a one-line search field; it grows with the draft up to `max-h-48`.
        <Textarea
            {...(history.inputAria ?? sessionMenu.inputAria ?? menu.inputAria)}
            aria-label={t('agentChat.composer.message')}
            className="field-sizing-content max-h-48 min-h-18 resize-none rounded-none border-0 bg-transparent px-3 pt-2.5 pb-1 leading-5 focus-visible:shadow-none"
            maxLength={MAX_AGENT_CHAT_MESSAGE_LENGTH}
            placeholder={history.preview ?? placeholder}
            ref={inputReference}
            rows={1}
            value={draft}
            onChange={(event) => {
                const { value } = event.target;
                setDraft(() => value);
                history.close();
                sessionMenu.trackCaret(event.target);
            }}
            onBlur={() => {
                setInputFocused(false);
                history.close();
            }}
            onFocus={() => setInputFocused(true)}
            onClick={(event) => sessionMenu.trackCaret(event.currentTarget)}
            onKeyUp={sessionMenu.trackCaretKey}
            onSelect={(event) => sessionMenu.followSelection(event.currentTarget)}
            onKeyDown={(event) => {
                sessionMenu.notePressedKey(event);
                // "Edit from here" owns the input; stashing it would strand the edit bar without its text.
                if (!isEditing && stash.didHandleKey(event)) return;
                if (history.didHandleKey(event, menu.isOpen || sessionMenu.isOpen)) return;
                if (menu.didHandleKey(event, menuActions)) return;
                if (sessionMenu.didHandleKey(event)) return;
                if (goalMode.didHandleKey(event)) return;
                composerKeys.onKeyDown(event);
            }}
            onPaste={onPaste}
        />
    );
}
