import { createHash } from 'node:crypto';

import type {
    AgentChatContinuation,
    AgentChatContinuationTarget,
    AgentChatHandoff,
    AgentChatUsageGuard,
    AgentDelegationCreateRequest,
    AgentDelegationReceipt,
    AgentProvider,
    Principal,
    UsageLimit,
} from '@caxri/protocol';
import { agentProviderCatalog, agentProviderIds, CaxriError, toWireError } from '@caxri/protocol';
import type { StructuredLogger } from '@caxri/system';
import { logEventCatalog } from '@caxri/system';

import type { DelegationAuthority } from '../../agent-delegation';
import type { CaxriDatabase } from '../../db';
import { resolveTerminalExecutable } from '../../terminal';
import type { AgentUsageGuards, UsageGuardPath } from '../../usage';
import { requireChatTerminal } from '../chat-launch';
import type { ChatStates } from '../chat-states';
import type { AgentChatServiceOptions } from '../service-options';
import { trackSideQuestion } from '../side-question/chat-side-question';
import { buildContinuationBrief } from './continuation-brief';

/**
 * The owner acting through Server Core: a continuation is a Client's request, recorded as a delegation whose caller is
 * the source Chat's Terminal, so the new Session reads "Continued from" it. Stable, because the delegation's
 * idempotency fingerprint includes the authority.
 */
const CONTINUATION_PRINCIPAL: Principal = {
    kind: 'desktop',
    id: 'usage-continuation',
    generation: 1,
};

/**
 * What the source model is asked for on the guard's reserved budget. A side question runs without tools, so this is one
 * bounded answer, not a turn.
 */
const HANDOFF_QUESTION = [
    'Your weekly usage is nearly exhausted, so this is the last thing you will write in this conversation.',
    'Write a hand-off document for another coding agent who will continue this work in the same repository without access to this conversation.',
    'Cover: the goal, what is done (with file paths), what is in progress or uncommitted, what remains as concrete next steps, decisions already made and why, and pitfalls to avoid.',
    'Be specific and concise (under 1,200 words). Markdown is fine. Do not ask questions.',
].join(' ');

const MAX_HANDOFF_CHARACTERS = 16_000;

/**
 * The Chat service parts a continuation drives; set once the service exists.
 */
export interface ContinuationChatHost {
    states: ChatStates;
    interrupt(terminalId: string, by: 'usageGuard'): Promise<void>;
    start(terminalId: string): Promise<void>;
}

/**
 * The delegation id of a continuation: one per failed turn, or per Chat and weekly guard window, so a double click, a
 * retry, or a restart resolves to the same new Session instead of a second one.
 */
/**
 * Where a continuation starts: the turn that failed on a used-up plan limit, the weekly guard, or the user choosing
 * Continue in Another Agent from a menu while nothing stopped the Chat.
 */
export type ContinuationOrigin = 'usageGuard' | 'manual' | { turnId: string };

function continuationDelegationId(terminalId: string, key: string): string {
    const digest = createHash('sha256').update(`continuation\n${terminalId}\n${key}`).digest('hex');
    // Delegation storage accepts only generated identifiers (`prepareDelegationLaunch`), so the digest is shaped as a
    // UUID (version 8, RFC 9562's custom layout) instead of carrying its own prefix.
    const variant = ((Number.parseInt(digest[16], 16) & 0x3) | 0x8).toString(16);
    return `${digest.slice(0, 8)}-${digest.slice(8, 12)}-8${digest.slice(13, 16)}-${variant}${digest.slice(17, 20)}-${digest.slice(20, 32)}`;
}

/**
 * Continuing a Chat's work in another Agent when its provider's usage is gone (issue #2581), and the weekly usage guard
 * as a Chat sees it (issue #2580): the admission gate every ordinary model request of a Chat passes, the guard state on
 * its projection, the one hand-off its own model may write, and "Open in another Agent". Continuing never calls the
 * source provider: the new Session starts from a deterministic package of the Chat's projection.
 */
export class ChatUsageContinuation {
    private chat: ContinuationChatHost | undefined;

    constructor(
        private readonly options: Pick<
            AgentChatServiceOptions,
            'database' | 'logger' | 'launchSettings' | 'resolveExecutable'
        > & {
            guards: AgentUsageGuards;
            /**
             * Late-bound: the delegation service is composed after the Chat service.
             */
            createDelegation(
                id: string,
                authority: DelegationAuthority,
                request: AgentDelegationCreateRequest,
            ): Promise<AgentDelegationReceipt>;
            /**
             * Removes a Session that has no Terminal; its delegation record goes with it.
             */
            discardSession(sessionId: string): void;
        },
    ) {
        options.guards.subscribe((provider) => {
            this.sync(provider);
        });
    }

    private get database(): CaxriDatabase {
        return this.options.database;
    }

    private get logger(): StructuredLogger {
        return this.options.logger;
    }

    private provider(terminalId: string): AgentProvider {
        return requireChatTerminal(this.database, terminalId).provider;
    }

    private continuation(id: string): AgentChatContinuation | undefined {
        const record = this.database.agentDelegations.get(id);
        if (!record) return undefined;
        return { sessionId: record.input.sessionId, provider: record.receipt.provider };
    }

    /**
     * A continuation whose Agent never launched leaves an empty Session behind. It is removed, taking the record with
     * it (`agent_delegations` cascades on its Session), so the user is not sent to a Session nothing runs in and a
     * retry of the same turn or guard window starts over under the same deterministic id.
     */
    private didDiscardFailedLaunch(
        record: { input: { sessionId: string }; receipt: AgentDelegationReceipt } | undefined,
    ): boolean {
        if (record?.receipt.status !== 'failed' || record.receipt.terminalId) return false;
        this.options.discardSession(record.input.sessionId);
        return this.database.agentDelegations.get(record.receipt.delegationId) === undefined;
    }

    /**
     * Brings every open Chat of the provider in line with its guard. On arming, a running turn is interrupted (the
     * provider stops at its next safe boundary) and queued input is held, so nothing more reaches the account. On
     * lifting, the hold is released.
     */
    private sync(provider: AgentProvider): void {
        const chat = this.chat;
        if (!chat) return;
        for (const terminalId of chat.states.terminalIds()) {
            if (this.database.getTerminal(terminalId)?.provider !== provider) continue;
            const state = chat.states.get(terminalId);
            if (!state) continue;
            const view = this.view(terminalId);
            chat.states.apply(terminalId, [{ op: 'state', state: { usageGuard: view ?? null } }]);
            if (view) {
                state.followUps.pause('usageGuard');
                if (state.projection.snapshot.activeTurnId)
                    void chat.interrupt(terminalId, 'usageGuard').catch(() => {});
            } else {
                // The wait of a turn the guard stopped ends here when the queue it releases continues the Chat itself.
                const isReleasing = state.followUps.pausedFor === 'usageGuard';
                chat.states.usageLimitWaits?.guardLifted(terminalId, isReleasing);
                if (isReleasing) state.followUps.resume();
            }
        }
    }

    private publish(terminalId: string): void {
        this.chat?.states.apply(terminalId, [
            { op: 'state', state: { usageGuard: this.view(terminalId) ?? null } },
        ]);
    }

    private async writeHandoff(
        chat: ContinuationChatHost,
        provider: AgentProvider,
        terminalId: string,
    ): Promise<void> {
        let settled: AgentChatHandoff;
        try {
            await chat.start(terminalId);
            const state = chat.states.get(terminalId);
            const session = state?.session;
            if (!session?.isOpen || !session.askSideQuestion)
                throw new CaxriError('UNAVAILABLE', 'Agent Chat is not running');
            const ask = session.askSideQuestion.bind(session, HANDOFF_QUESTION, []);
            const text = (await trackSideQuestion(state, ask)).trim();
            settled = text
                ? {
                      status: 'generated',
                      text: text.slice(0, MAX_HANDOFF_CHARACTERS),
                      createdAt: Date.now(),
                  }
                : { status: 'failed', reason: 'empty', createdAt: Date.now() };
        } catch (error) {
            const { code } = toWireError(error);
            settled = {
                status: 'failed',
                reason:
                    code === 'TIMEOUT'
                        ? 'timeout'
                        : code === 'UNAVAILABLE'
                          ? 'unavailable'
                          : 'rejected',
                createdAt: Date.now(),
            };
        }
        this.options.guards.settleHandoff(provider, terminalId, settled);
        this.publish(terminalId);
    }

    attach(chat: ContinuationChatHost): void {
        this.chat = chat;
    }

    /**
     * Publishes the guard view again after something it shows changed outside the guard (a wait began or ended).
     */
    republish(terminalId: string): void {
        if (this.view(terminalId)) this.publish(terminalId);
    }

    /**
     * A plan-limit reading a running Chat reported itself (Claude Code's `rate_limit_event`).
     */
    observe(provider: AgentProvider, reading: Pick<UsageLimit, 'windows'>): void {
        this.options.guards.observe(provider, reading);
    }

    /**
     * Refuses an ordinary model request of this Chat with `USAGE_LIMITED` while its account is at the weekly guard.
     */
    assert(terminalId: string, path: UsageGuardPath): void {
        this.options.guards.assertAdmitted(this.provider(terminalId), path);
    }

    /**
     * Whether the follow-up queue must hold its entries back.
     */
    isBlocked(terminalId: string): boolean {
        const terminal = this.database.getTerminal(terminalId);
        return Boolean(terminal?.provider && this.options.guards.current(terminal.provider));
    }

    /**
     * The Session another Agent continued a failed turn in.
     */
    continuedIn(terminalId: string, turnId: string): AgentChatContinuation | undefined {
        return this.continuation(continuationDelegationId(terminalId, `turn:${turnId}`));
    }

    /**
     * The guard as this Chat sees it: its account's guard, plus this Chat's hand-off and continuation in that window.
     */
    view(terminalId: string): AgentChatUsageGuard | undefined {
        const terminal = this.database.getTerminal(terminalId);
        if (!terminal?.provider) return undefined;
        const guard = this.options.guards.current(terminal.provider);
        if (!guard) return undefined;
        const document = this.options.guards.document(terminal.provider, terminalId);
        const continuedIn = this.continuation(
            continuationDelegationId(terminalId, `guard:${guard.resetsAt}`),
        );
        const wait = this.chat?.states.usageLimitWaits?.guardWait(terminalId);
        return {
            ...guard,
            ...(document && { document }),
            ...(continuedIn && { continuedIn }),
            ...(wait && { autoContinue: wait.autoContinue, autoContinueTurnId: wait.turnId }),
        };
    }

    /**
     * Every other provider, with why it cannot take the work over now. Whether its sign-in still works is not known
     * without asking it, so an installed provider is offered.
     */
    async targets(terminalId: string): Promise<AgentChatContinuationTarget[]> {
        const terminal = requireChatTerminal(this.database, terminalId);
        return Promise.all(
            agentProviderIds.map(async (provider): Promise<AgentChatContinuationTarget> => {
                if (provider === terminal.provider) return { provider, unavailable: 'current' };
                const guard = this.options.guards.current(provider);
                if (guard)
                    return { provider, unavailable: 'usageLimited', resetsAt: guard.resetsAt };
                try {
                    await resolveTerminalExecutable(
                        provider,
                        this.options.launchSettings(provider, terminal),
                        this.options.resolveExecutable,
                    );
                    return { provider };
                } catch {
                    return { provider, unavailable: 'notInstalled' };
                }
            }),
        );
    }

    /**
     * Continues the Chat's work in a new Session of the same Project, run by `provider`, from `origin` (see
     * {@link ContinuationOrigin}). Idempotent per failed turn, guard window, or, for a manual continuation, per latest
     * turn: a repeat returns the Session the first created, whichever provider it asked for. A manual continuation
     * refuses a running turn, as Fork Session does, since the brief would miss the turn's end. The new Session is
     * created and its Agent started atomically by delegation admission, which removes the Session again when the launch
     * is refused.
     */
    async continueIn(
        terminalId: string,
        provider: AgentProvider,
        origin: ContinuationOrigin,
    ): Promise<{ sessionId: string; delegationId: string }> {
        const startedAt = Date.now();
        const terminal = requireChatTerminal(this.database, terminalId);
        const snapshot = this.chat?.states.open(terminalId).projection.snapshot;
        if (!snapshot) throw new CaxriError('UNAVAILABLE', 'Agent Chat is not ready');
        const turnId = typeof origin === 'object' ? origin.turnId : undefined;
        const notice = turnId
            ? snapshot.items.find((item) => item.id === `${turnId}:error`)
            : undefined;
        const usageLimit = notice?.type === 'notice' ? notice.usageLimit : undefined;
        const guard = this.options.guards.current(terminal.provider);
        let key: string;
        if (origin === 'manual') {
            // A compaction rewrites the provider's record too, so it counts as a running turn.
            if (snapshot.activeTurnId || snapshot.operation === 'compacting')
                throw new CaxriError('CONFLICT', 'Wait for the current turn to finish first');
            const lastTurn = snapshot.turns.at(-1);
            if (!lastTurn)
                throw new CaxriError('CONFLICT', 'This conversation has nothing to continue yet');
            key = `manual:${lastTurn.id}`;
        } else if (turnId) {
            if (!usageLimit)
                throw new CaxriError(
                    'CONFLICT',
                    'This Chat has no used-up usage limit to continue from',
                );
            key = `turn:${turnId}`;
        } else {
            if (!guard)
                throw new CaxriError(
                    'CONFLICT',
                    'This Chat has no used-up usage limit to continue from',
                );
            key = `guard:${guard.resetsAt}`;
        }
        const id = continuationDelegationId(terminalId, key);
        const trigger = origin === 'manual' ? 'manual' : turnId ? 'usageLimit' : 'usageGuard';
        const log = (outcome: 'created' | 'existing' | 'failed', code: string | null) =>
            this.logger.write(
                outcome === 'failed' ? 'warn' : 'info',
                logEventCatalog.usage.continuation,
                {
                    fields: {
                        source: terminal.provider,
                        provider,
                        trigger,
                        outcome,
                        code,
                        durationMs: Date.now() - startedAt,
                    },
                },
            );
        let existing = this.database.agentDelegations.get(id);
        if (existing && this.didDiscardFailedLaunch(existing)) existing = undefined;
        if (existing) {
            log('existing', null);
            return { sessionId: existing.input.sessionId, delegationId: id };
        }
        const target = (await this.targets(terminalId)).find(
            (candidate) => candidate.provider === provider,
        );
        if (target?.unavailable)
            throw new CaxriError(
                target.unavailable === 'usageLimited' ? 'USAGE_LIMITED' : 'UNAVAILABLE',
                `${agentProviderCatalog[provider].displayName} cannot continue this work now`,
                { reason: target.unavailable },
            );
        const session = this.database.getSession(terminal.sessionId);
        if (!session) throw new CaxriError('NOT_FOUND', 'Session not found');
        const document = this.options.guards.document(terminal.provider, terminalId);
        const prompt = buildContinuationBrief({
            snapshot,
            source: terminal.provider,
            reason:
                origin === 'manual'
                    ? { kind: 'manual' }
                    : usageLimit
                      ? { kind: 'usageLimit', window: usageLimit.window }
                      : { kind: 'usageGuard' },
            ...(document?.status === 'generated' && { document: document.text }),
        });
        const title = `Continued: ${session.title || agentProviderCatalog[terminal.provider].displayName}`;
        try {
            const receipt = await this.options.createDelegation(
                id,
                { principal: CONTINUATION_PRINCIPAL, callerTerminalId: terminalId },
                {
                    newSession: true,
                    handoff: true,
                    title: title.slice(0, 200),
                    projectId: session.projectId,
                    provider,
                    prompt,
                },
            );
            if (this.didDiscardFailedLaunch({ input: { sessionId: receipt.sessionId }, receipt }))
                throw new CaxriError(
                    'UNAVAILABLE',
                    `${agentProviderCatalog[provider].displayName} could not start`,
                );
            log('created', null);
            if (notice) this.chat?.states.apply(terminalId, [{ op: 'upsertItem', item: notice }]);
            else this.publish(terminalId);
            return { sessionId: receipt.sessionId, delegationId: id };
        } catch (error) {
            log('failed', toWireError(error).code);
            throw error;
        }
    }

    /**
     * Spends the account's one hand-off lease for this window on this Chat and returns; its own model then writes a
     * hand-off document in one tool-less answer, published on the Chat's `usageGuard`. The lease stays spent whatever
     * the outcome, and the deterministic continuation still works without the document.
     */
    generateHandoff(terminalId: string): void {
        const chat = this.chat;
        if (!chat) throw new CaxriError('UNAVAILABLE', 'Agent Chat is not ready');
        const provider = this.provider(terminalId);
        if (!agentProviderCatalog[provider].capabilities.chatSideQuestion)
            throw new CaxriError(
                'VALIDATION',
                `${agentProviderCatalog[provider].displayName} Chats cannot write a hand-off`,
            );
        this.options.guards.claimHandoff(provider, terminalId);
        this.publish(terminalId);
        void this.writeHandoff(chat, provider, terminalId);
    }

    /**
     * The guard card's "Continue anyway": admits the account's requests for the rest of the window. Every Chat of the
     * account hears it through the guard's subscription, which resumes the queues the guard paused.
     */
    bypassGuard(terminalId: string): void {
        this.options.guards.bypass(this.provider(terminalId));
    }
}
