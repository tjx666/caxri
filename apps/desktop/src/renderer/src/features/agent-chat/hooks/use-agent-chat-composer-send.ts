import type { AgentAction, AgentChatCommand } from '@caxri/protocol';
import {
    AGENT_CHAT_GOAL_COMMAND,
    agentChatDraftWithReturnedMessage,
    completeAgentChatAction,
} from '@caxri/protocol';

import { recordRecentAgentAction } from '../../agent-actions/agent-actions-commands';
import { setAgentChatGoalMode, useAgentChatGoalModeStore } from '../activity/agent-chat-goal-mode';
import type { AgentChatComposerKeyEvent } from '../composer/agent-chat-composer-view';
import {
    agentChatGoalModeDraft,
    isAgentChatGoalAction,
    isAgentChatGoalOffered,
} from '../composer-input/agent-chat-slash-commands';
import { agentChatCompactCommand } from '../context/agent-chat-context';
import type { useAgentChatAttachments } from './use-agent-chat-attachments';
import { useAgentChatComposerEdit } from './use-agent-chat-composer-edit';
import { useAgentChatSubmit } from './use-agent-chat-submit';
import { useAgentChatUnsentReturns } from './use-agent-chat-unsent-returns';

/**
 * Everything the composer can deliver: the typed draft (sent, queued, or steered, or sent in place of an earlier
 * message while "Edit from here" is in progress), a command picked from the slash menu, and the provider's compact
 * command offered by the context alert and meter. In Goal mode (`agent-chat-goal-mode.ts`) the draft is set as the
 * provider's goal instead, and the mode ends once Server Core accepts it; choosing `/goal` from the slash menu or Goal
 * from the Add menu enters the mode, and Backspace in an empty input leaves it.
 */
export function useAgentChatComposerSend({
    canSend,
    commands,
    draft,
    edit: editInput,
    focusInput,
    images,
    isAttaching,
    onSent,
    setDraft,
    terminalId,
}: {
    /**
     * Whether the Chat accepts a message right now (no `agentChatSendBlock`).
     */
    canSend: boolean;
    commands: readonly AgentChatCommand[] | undefined;
    draft: string;
    /**
     * What "Edit from here" needs beyond the draft (`useAgentChatComposerEdit`).
     */
    edit: Omit<
        Parameters<typeof useAgentChatComposerEdit>[0],
        | 'attachments'
        | 'canSend'
        | 'draft'
        | 'focusInput'
        | 'setDraft'
        | 'submitEdit'
        | 'terminalId'
    >;
    focusInput: () => void;
    images: Pick<
        ReturnType<typeof useAgentChatAttachments>,
        'addCards' | 'attachments' | 'clearSent' | 'removeCards' | 'restoreUnsent'
    >;
    /**
     * Whether picked images are still being read or a long paste saved (`useAgentChatComposerInput`), which holds Send.
     */
    isAttaching: boolean;
    onSent?: () => void;
    setDraft: (update: (current: string) => string) => void;
    terminalId: string;
}) {
    const {
        isSending,
        runCommand,
        submit: submitDraft,
        submitEdit,
    } = useAgentChatSubmit({
        attachments: images.attachments,
        clearSent: images.clearSent,
        commands,
        onSent,
        providerName: editInput.providerName,
        setDraft,
        terminalId,
    });
    useAgentChatUnsentReturns(terminalId, (text, attachments) => {
        if (text) setDraft((current) => agentChatDraftWithReturnedMessage(current, text));
        images.restoreUnsent(attachments);
    });
    const edit = useAgentChatComposerEdit({
        ...editInput,
        attachments: images,
        canSend,
        draft,
        focusInput,
        setDraft,
        submitEdit,
        terminalId,
    });
    const isGoalModeOn = useAgentChatGoalModeStore((state) => state.terminalIds.has(terminalId));
    const isGoalOffered = isAgentChatGoalOffered(commands) && !edit.isEditing;
    const isGoalMode = isGoalModeOn && isGoalOffered;
    const enterGoalMode = (): void => {
        setDraft(agentChatGoalModeDraft);
        setAgentChatGoalMode(terminalId, true);
        focusInput();
    };
    const exitGoalMode = (): void => {
        setAgentChatGoalMode(terminalId, false);
        focusInput();
    };
    // A goal is text only, so attached images alone do not make it sendable.
    const hasContent = draft.trim().length > 0 || (!isGoalMode && images.attachments.length > 0);
    const isSendable = edit.canSend && !isSending && !isAttaching && hasContent;
    const submit = async (delivery?: 'steer'): Promise<void> => {
        if (!isSendable) return;
        if (isGoalMode) {
            const isSet = await runCommand(draft, {
                name: AGENT_CHAT_GOAL_COMMAND,
                arguments: draft.trim(),
            });
            if (isSet) setAgentChatGoalMode(terminalId, false);
            return;
        }
        // Send, like Enter, steers while the running turn takes a steered message by default.
        const sentDelivery =
            delivery ?? (editInput.isSteerDefault && editInput.isTurnRunning ? 'steer' : undefined);
        await edit.submit(draft, async () => submitDraft(draft, sentDelivery));
    };
    const compactCommand = agentChatCompactCommand(commands);
    /**
     * Runs the provider's compact command from the context alert or the meter's card, the same path a typed `/compact`
     * takes.
     */
    const compact =
        compactCommand && canSend
            ? (): void => {
                  focusInput();
                  if (isSending) return;
                  // eslint-disable-next-line no-void -- runCommand reports its own failures through tryCommand
                  void runCommand(
                      `/${compactCommand.name}`,
                      { name: compactCommand.name },
                      { isFromDraft: false },
                  );
              }
            : undefined;
    /**
     * Promotes a row picked from the slash menu in the provider's recents, which a bare `/` lists first next time
     * (`agentChatRecentMenuActions`). The menu has closed by the time the write lands, so the settings push that
     * carries it is early enough and nothing waits for it.
     */
    const recordRecent = (action: AgentAction): void => {
        // eslint-disable-next-line no-void -- recordRecentAgentAction reports its own failures through tryCommand
        void recordRecentAgentAction(terminalId, action.invocation);
    };
    /**
     * Tab: put the row's text into the input and stop there, so the user can add arguments or press Enter to run it.
     */
    const complete = (action: AgentAction): void => {
        recordRecent(action);
        if (isGoalOffered && isAgentChatGoalAction(action)) {
            setDraft(() => '');
            enterGoalMode();
            return;
        }
        setDraft(() => completeAgentChatAction(action));
        focusInput();
    };
    const choose = (action: AgentAction): void => {
        if (isGoalOffered && isAgentChatGoalAction(action)) {
            complete(action);
            return;
        }
        recordRecent(action);
        const completed = completeAgentChatAction(action);
        setDraft(() => completed);
        focusInput();
        // A command without arguments has nothing left to type, so choosing it runs it; a skill waits for the request.
        if (!canSend || isSending || completed !== action.invocation) return;
        // eslint-disable-next-line no-void -- runCommand reports its own failures through tryCommand
        void runCommand(completed, { name: action.invocation.slice(1) });
    };
    const goalMode = {
        isOn: isGoalMode,
        enter: isGoalOffered ? enterGoalMode : undefined,
        exit: exitGoalMode,
        /**
         * Backspace in an empty input leaves Goal mode, as deleting a chip does in the Codex app.
         */
        didHandleKey: (event: AgentChatComposerKeyEvent): boolean => {
            if (!isGoalMode || draft !== '' || event.key !== 'Backspace') return false;
            event.preventDefault();
            exitGoalMode();
            return true;
        },
    };
    return {
        choose,
        compact,
        complete,
        edit,
        goalMode,
        hasContent,
        isSendable,
        isSending,
        submit,
    };
}
