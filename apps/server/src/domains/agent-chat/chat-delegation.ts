import { randomUUID } from 'node:crypto';

import type {
    AgentChatItem,
    AgentChatPermissionMode,
    AgentChatSnapshot,
    AgentLaunchSettings,
    DelegationRedirectRefusal,
} from '@caxri/protocol';
import { CaxriError } from '@caxri/protocol';
import { assertE2EAgentChatInput, readE2EAgentPolicy } from '@caxri/system';

import { isTurnEnded, isTurnNotSteerable } from './chat-provider';
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
     * Runs `deliver` on the Chat's send chain against one exact launch, so it keeps its order with other input. It is
     * not human input and never starts a provider: when it reaches the head of the chain it rejects unless `launchId`
     * is still live with an open session, so a launch that was suspended, retired, or replaced meanwhile reports the
     * message as not delivered.
     */
    private async onLaunchChain(
        terminalId: string,
        launchId: string,
        deliver: (host: {
            session: NonNullable<ChatState['session']>;
            state: ChatState;
        }) => Promise<void>,
    ): Promise<void> {
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
                    { steerRefusal: 'launch_replaced' satisfies DelegationRedirectRefusal },
                );
            this.options.admit(terminalId, state);
            return { session, state };
        };
        admitLaunch();
        const previous = state!.sendQueue;
        const run = (async () => {
            await previous;
            await deliver(admitLaunch());
        })();
        state!.sendQueue = Promise.allSettled([run]);
        await run;
    }

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
     * Delivers a delegation message (a follow-up's task pointer) to one exact launch; see {@link onLaunchChain}. It
     * waits behind a running turn in the follow-up queue.
     */
    async sendToLaunch(terminalId: string, launchId: string, text: string): Promise<void> {
        assertE2EAgentChatInput(readE2EAgentPolicy(), text);
        await this.onLaunchChain(terminalId, launchId, async ({ session, state }) => {
            const message = { text };
            if (state.followUps.mustWait())
                state.followUps.add({ id: randomUUID(), kind: 'message', message });
            else await session.send(message);
        });
    }

    /**
     * Steers one exact running turn of one exact launch with a delegation message (a redirect), or refuses. At the head
     * of the send chain it checks again that the launch is live, no person has typed since `inputEpoch`, and `turnId`
     * is still the active turn; it never queues the message, never starts a turn with it, and never counts as human
     * input, so the task is not taken over. A refusal is a {@link CaxriError} whose `details.steerRefusal` is a
     * `DelegationRedirectRefusal` and means nothing reached the provider. Any other rejection (an unconfirmed delivery
     * above all) leaves it unknown whether the message arrived.
     */
    async steerToLaunch(
        terminalId: string,
        launchId: string,
        steer: { turnId: string; inputEpoch: number | undefined; text: string },
    ): Promise<void> {
        assertE2EAgentChatInput(readE2EAgentPolicy(), steer.text);
        const refuse = (reason: DelegationRedirectRefusal) =>
            new CaxriError('CONFLICT', 'The delegated Chat cannot take this direction now', {
                steerRefusal: reason,
            });
        await this.onLaunchChain(terminalId, launchId, async ({ session, state }) => {
            if (steer.inputEpoch !== undefined && this.inputEpoch(terminalId) !== steer.inputEpoch)
                throw refuse('human_intervened');
            if (state.projection.snapshot.activeTurnId !== steer.turnId)
                throw refuse('turn_changed');
            try {
                await session.send(
                    { text: steer.text },
                    { delivery: 'steered', exactTurnId: steer.turnId },
                );
            } catch (error) {
                if (isTurnEnded(error)) throw refuse('turn_changed');
                if (isTurnNotSteerable(error)) throw refuse('not_steerable');
                throw error;
            }
        });
    }

    /**
     * See {@link chatTurnAnswer}.
     */
    turnAnswer(terminalId: string, turnId: string): ChatTurnAnswer {
        return chatTurnAnswer(this.snapshot(terminalId), turnId);
    }

    /**
     * The Chat's current projection snapshot, or `undefined` when this Server Core holds none for it. Agent delegation
     * reads what the active turn is doing (a Delegated Session's progress) and why a turn failed (a usage limit's reset
     * time).
     */
    snapshot(terminalId: string): AgentChatSnapshot | undefined {
        return this.options.state(terminalId)?.projection.snapshot;
    }

    /**
     * The permission the live provider of a Chat runs under, tied to the launch that holds it, or `undefined` when no
     * launch is live or the provider reports none. Agent delegation reads it to decide what a delegating Agent may
     * approve.
     */
    appliedPermission(terminalId: string):
        | {
              launchId: string;
              permissionMode?: AgentChatPermissionMode;
              planMode: boolean;
              applied: boolean;
          }
        | undefined {
        const launchId = this.liveLaunchId(terminalId);
        const permission = launchId
            ? this.options.state(terminalId)?.session?.appliedPermission?.()
            : undefined;
        return launchId && permission ? { launchId, ...permission } : undefined;
    }

    /**
     * The plain decisions the live provider offers for a pending request; see `AgentChatProviderSession`.
     */
    requestOffers(
        terminalId: string,
        requestId: string,
    ): { accept: boolean; decline: boolean } | undefined {
        return this.options.state(terminalId)?.session?.requestOffers?.(requestId);
    }

    /**
     * Adds one item to the Chat's transcript, such as a note that a delegating Agent decided a request.
     */
    applyItem(terminalId: string, item: AgentChatItem): void {
        this.options.state(terminalId)?.projection.apply([{ op: 'upsertItem', item }]);
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
