import type {
    AgentChatActivity,
    AgentChatItem,
    AgentChatQueuedMessage,
    AgentChatSnapshot,
} from '@caxri/protocol';
import { agentChatActivity, unsettledAgentChatPendingMessages } from '@caxri/protocol';

import type { Translate } from '../../../i18n';
import type { AgentChatPendingMessage } from '../transcript/agent-chat-pending';
import { agentChatSendBlock, isAgentChatBusy } from '../transcript/agent-chat-presentation';

/**
 * The part of a Chat snapshot the composer reads. `items` keeps only the user's own messages: prompt recall and "Edit
 * from here" (`agentChatRewindTarget`) look at nothing else, and every streamed reply token replaces the snapshot's
 * other items.
 */
type AgentChatComposerSnapshot = Pick<
    AgentChatSnapshot,
    | 'activeTurnId'
    | 'effort'
    | 'goal'
    | 'model'
    | 'models'
    | 'permissionMode'
    | 'planMode'
    | 'queuePauseReason'
    | 'tasks'
    | 'turns'
    | 'usage'
> & { items: AgentChatItem[] };

/**
 * Everything the composer derives from the Chat snapshot, as one value. It is built inside the query's `select`, whose
 * result TanStack Query structurally shares: a streamed patch that changes only the reply returns the previous object,
 * so the composer subtree does not render for it.
 */
export interface AgentChatComposerView {
    activeTurnId: string | undefined;
    activity: AgentChatActivity | undefined;
    commands: AgentChatSnapshot['commands'] | undefined;
    isBusy: boolean;
    isQueuePaused: boolean;
    /**
     * Messages sent to wait in the queue that the projection does not list yet.
     */
    pendingQueue: readonly AgentChatPendingMessage[];
    queue: readonly AgentChatQueuedMessage[] | undefined;
    sendBlock: ReturnType<typeof agentChatSendBlock>;
    snapshot: AgentChatComposerSnapshot | undefined;
}

const NO_PENDING: readonly AgentChatPendingMessage[] = [];

/**
 * What the composer takes from `snapshot`. Pure so it can run in a query `select` and be tested against a stream.
 */
export function selectAgentChatComposerView(
    snapshot: AgentChatSnapshot | undefined,
    context: {
        hasConversation: boolean;
        pendingMessages: readonly AgentChatPendingMessage[];
        processState: Parameters<typeof agentChatSendBlock>[1];
        providerName: string;
        t: Translate;
    },
): AgentChatComposerView {
    // Settling is only worked out when a message waits in the queue, which is the exception.
    const pendingQueue = context.pendingMessages.some((message) => message.placement === 'queue')
        ? unsettledAgentChatPendingMessages(context.pendingMessages, snapshot).filter(
              (message) => message.placement === 'queue',
          )
        : NO_PENDING;
    return {
        activeTurnId: snapshot?.activeTurnId,
        activity: agentChatActivity(
            snapshot,
            context.providerName,
            { hasConversation: context.hasConversation },
            context.t,
        ),
        commands: snapshot?.commands,
        isBusy: isAgentChatBusy(snapshot),
        isQueuePaused: snapshot?.queuePaused ?? false,
        pendingQueue,
        queue: snapshot?.queue,
        sendBlock: agentChatSendBlock(snapshot, context.processState),
        snapshot: snapshot && {
            activeTurnId: snapshot.activeTurnId,
            effort: snapshot.effort,
            goal: snapshot.goal,
            items: snapshot.items.filter((item) => item.type === 'userMessage'),
            model: snapshot.model,
            models: snapshot.models,
            permissionMode: snapshot.permissionMode,
            planMode: snapshot.planMode,
            queuePauseReason: snapshot.queuePauseReason,
            tasks: snapshot.tasks,
            turns: snapshot.turns,
            usage: snapshot.usage,
        },
    };
}
