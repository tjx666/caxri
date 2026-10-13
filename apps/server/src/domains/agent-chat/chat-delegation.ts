import { randomUUID } from 'node:crypto';

import type { AgentLaunchSettings } from '@caxri/protocol';
import { CaxriError } from '@caxri/protocol';
import { assertE2EAgentChatInput, readE2EAgentPolicy } from '@caxri/system';

import type { ChatState } from './chat-states';
import type { ChatTurnAnswer } from './chat-turn-answer';
import { chatTurnAnswer } from './chat-turn-answer';

/**
 * How a Chat reports to Agent delegation, the Chat counterpart of the PTY launch environment, input, and retirement
 * hooks. Late-bound by the composition root, because the delegation service is composed after the Chat service.
 */
export interface ChatDelegationHooks {
    /**
     * A Chat launch is about to spawn its provider, like `AgentDelegationService.bindEnvironment` for a PTY launch:
     * `delegationId` binds a delegated child's first launch to its task, and any other launch fences the Terminal's
     * earlier tasks. Throws to cancel the start when that task no longer owns the launch.
     */
    bindLaunch(terminalId: string, launchId: string, delegationId?: string): void;
    /**
     * A Chat's provider process ended, like a retired PTY Agent launch.
     */
    retireLaunch(terminalId: string, launchId: string): void;
    /**
     * A person sent the Chat a message, command, rewind, or interrupt: a takeover, like typing into a PTY Agent.
     */
    humanInput(terminalId: string): void;
}

/**
 * The launch a delegated child Chat starts with: the task's frozen launch settings, the task it belongs to, and for a
 * provider that lets the client choose it, the id its new conversation must have.
 */
export interface ChatDelegatedStart {
    launch: AgentLaunchSettings;
    delegationId?: string;
    agentSessionId?: string;
}

/**
 * Per-Chat state Agent delegation relies on: the delegated launch settings, the human input epoch, and reads of the
 * live launch and of a turn's answer. Kept beside `AgentChatService` so the service only routes to it.
 */
export class ChatDelegationLinks {
    /**
     * Frozen launch settings of a delegated child, used by every start of that Chat in this Server Core, so a restart
     * or a resume after idle suspension keeps the model the task was admitted with.
     */
    private readonly launches = new Map<string, AgentLaunchSettings>();

    /**
     * The task binding and preset conversation id of the next start only.
     */
    private readonly nextStarts = new Map<string, Omit<ChatDelegatedStart, 'launch'>>();

    private readonly epochs = new Map<string, number>();

    constructor(
        private readonly options: {
            hooks?: ChatDelegationHooks;
            state(terminalId: string): ChatState | undefined;
            /**
             * `ChatStates.admit`: throws unless `state` is still the Terminal's current, admissible Chat.
             */
            admit(terminalId: string, state: ChatState): void;
        },
    ) {}

    /**
     * Called before the start that launches a delegated child (or relaunches one for its task).
     */
    prepareStart(terminalId: string, start: ChatDelegatedStart): void {
        this.launches.set(terminalId, start.launch);
        this.nextStarts.set(terminalId, {
            delegationId: start.delegationId,
            agentSessionId: start.agentSessionId,
        });
    }

    launchSettings(terminalId: string): AgentLaunchSettings | undefined {
        return this.launches.get(terminalId);
    }

    /**
     * Consumes what only the next start carries.
     */
    takeStart(terminalId: string): Omit<ChatDelegatedStart, 'launch'> {
        const start = this.nextStarts.get(terminalId) ?? {};
        this.nextStarts.delete(terminalId);
        return start;
    }

    bindLaunch(terminalId: string, launchId: string, delegationId?: string): void {
        this.options.hooks?.bindLaunch(terminalId, launchId, delegationId);
    }

    /**
     * Records human input before it is delivered, advancing the epoch a delegation follow-up checks, as typing into a
     * PTY advances its Terminal's input epoch.
     */
    observeHumanInput(terminalId: string): void {
        this.epochs.set(terminalId, this.inputEpoch(terminalId) + 1);
        this.options.hooks?.humanInput(terminalId);
    }

    inputEpoch(terminalId: string): number {
        return this.epochs.get(terminalId) ?? 0;
    }

    /**
     * The launch whose provider process exists (spawned, possibly still opening its conversation) and is not being
     * stopped, or `undefined`. A launch that idle suspension or a teardown is closing is no longer live: input admitted
     * against it would only reach the next start.
     */
    liveLaunchId(terminalId: string): string | undefined {
        const state = this.options.state(terminalId);
        if (!state?.session || state.suspending || state.retiring !== undefined) return undefined;
        return state.launchId;
    }

    /**
     * Delivers a delegation message (a follow-up's task pointer) to one exact launch, on the Chat's send chain so it
     * keeps its order with other input. Unlike `AgentChatService.send` it is not human input and never starts a
     * provider: when it reaches the head of the chain it rejects unless `launchId` is still live with an open session,
     * so a launch that was suspended, retired, or replaced meanwhile reports the message as not delivered.
     */
    async sendToLaunch(terminalId: string, launchId: string, text: string): Promise<void> {
        assertE2EAgentChatInput(readE2EAgentPolicy(), text);
        const state = this.options.state(terminalId);
        /**
         * Returns the open session of `launchId` while `state` is still the Terminal's current, admissible Chat.
         */
        const admitLaunch = () => {
            const session = state?.session;
            if (
                !state ||
                this.options.state(terminalId) !== state ||
                this.liveLaunchId(terminalId) !== launchId ||
                !session?.isOpen
            )
                throw new CaxriError(
                    'CONFLICT',
                    'The delegated Chat changed before the message reached it',
                );
            this.options.admit(terminalId, state);
            return { session, followUps: state.followUps };
        };
        admitLaunch();
        const previous = state!.sendQueue;
        const run = (async () => {
            await previous;
            const { session, followUps } = admitLaunch();
            const message = { text };
            if (followUps.mustWait()) followUps.add({ id: randomUUID(), kind: 'message', message });
            else await session.send(message);
        })();
        state!.sendQueue = Promise.allSettled([run]);
        await run;
    }

    /**
     * See {@link chatTurnAnswer}.
     */
    turnAnswer(terminalId: string, turnId: string): ChatTurnAnswer {
        return chatTurnAnswer(this.options.state(terminalId)?.projection.snapshot, turnId);
    }

    /**
     * The Chat closed or switched to a PTY.
     */
    forget(terminalId: string): void {
        this.launches.delete(terminalId);
        this.nextStarts.delete(terminalId);
        this.epochs.delete(terminalId);
    }
}
