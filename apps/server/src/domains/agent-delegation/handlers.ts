import type { AgentDelegationPullRequest, SessionPullRequest } from '@caxri/protocol';
import { isDelegationActive } from '@caxri/protocol';
import type { StructuredLogger } from '@caxri/system';

import { coreRouted } from '../core-routed';
import type { CaxriDatabase } from '../db';
import type { DomainHandlers } from '../domain-services';
import type { ApprovalMethod } from './approvals/handlers';
import { createApprovalHandlers } from './approvals/handlers';
import { delegationStatuses } from './feed';
import { readHistory } from './history';
import type { QuestionMethod } from './questions/handlers';
import { createQuestionHandlers } from './questions/handlers';
import type { AgentDelegationService } from './service';
import type { DelegationTranscriptSource } from './transcript';
import { readDelegationChatPage } from './transcript';

type DelegationMethod =
    | 'agent.delegation.presets'
    | 'agent.delegation.presetsInternal'
    | 'agent.delegation.stop'
    | 'agent.delegation.stopInternal'
    | 'agent.delegation.sessions'
    | 'agent.delegation.statuses'
    | 'agent.delegation.retryOptions'
    | 'agent.delegation.retry'
    | 'agent.delegation.cancelScheduledRetry'
    | 'agent.delegation.create'
    | 'agent.delegation.status'
    | 'agent.delegation.result'
    | 'agent.delegation.list'
    | 'agent.delegation.listInternal'
    | 'agent.delegation.wait'
    | 'agent.delegation.waitInternal'
    | 'agent.delegation.createInternal'
    | 'agent.delegation.statusInternal'
    | 'agent.delegation.resultInternal'
    | 'agent.delegation.transcript'
    | 'agent.delegation.transcriptInternal'
    | 'agent.delegation.history'
    | 'agent.delegation.historyInternal'
    | ApprovalMethod
    | QuestionMethod;

/**
 * Stands in when no Chat service is wired (a unit test): every task reads as not loaded.
 */
const NO_TRANSCRIPTS: DelegationTranscriptSource = {
    readChildChat: () => true,
    isChatTerminal: () => true,
    snapshot: () => {},
};

/**
 * An answer returned to a caller counts as read, which makes its record evictable under capacity pressure. Background
 * collection goes through the service directly and never claims.
 */
function claimed<T extends { receipt: Parameters<typeof isDelegationActive>[0]; answer?: unknown }>(
    database: CaxriDatabase,
    read: T,
): T {
    if (read.answer && !isDelegationActive(read.receipt))
        database.agentDelegations.markCollected(read.receipt.delegationId, Date.now());
    return read;
}

/**
 * Reads a Session's pull request from the cache Server Core keeps of the last lookup (`PullRequestSettlementWiring`),
 * never from GitHub.
 */
export interface DelegationPullRequestSource {
    pullRequest(sessionId: string): SessionPullRequest | undefined;
}

/**
 * Adds the settled task's Session pull request to an answer the delegating Agent reads. An active task has none yet:
 * its Agent may still open or push one.
 */
function withPullRequest<
    T extends { receipt: Parameters<typeof isDelegationActive>[0] & { sessionId: string } },
>(
    source: DelegationPullRequestSource | undefined,
    read: T,
): T & { pullRequest?: AgentDelegationPullRequest } {
    if (isDelegationActive(read.receipt)) return read;
    const found = source?.pullRequest(read.receipt.sessionId);
    if (!found) return read;
    return {
        ...read,
        pullRequest: {
            url: found.url,
            number: found.number,
            state: found.state,
            ...(found.changedFiles !== undefined && { changedFileCount: found.changedFiles }),
        },
    };
}

export function createDelegationHandlers(
    service: AgentDelegationService,
    database: CaxriDatabase,
    sources: {
        pullRequests?: DelegationPullRequestSource;
        transcripts?: DelegationTranscriptSource;
        logger?: StructuredLogger;
    } = {},
): Pick<DomainHandlers, DelegationMethod> {
    const { pullRequests, transcripts = NO_TRANSCRIPTS, logger } = sources;
    return {
        ...createQuestionHandlers(service.questions),
        ...createApprovalHandlers(service.approvals),
        /**
         * Owner-only (enforced from the method spec before this runs) and never `claimed`: the feed reads summaries,
         * and an answer still unread by the Agent that delegated the task must stay unread.
         */
        'agent.delegation.sessions': ({ createdBySessionIds }) => ({
            sessions: service.sessions(createdBySessionIds),
        }),
        /**
         * Owner-only and never `claimed`, like the feed: it reads states, not answers.
         */
        'agent.delegation.statuses': ({ delegationIds }) => ({
            statuses: delegationStatuses({ database, approvals: service.approvals }, delegationIds),
        }),
        /**
         * Owner-only (enforced from the method spec before this runs). The retry runs as the failed task's own Agent
         * identity, never the caller's; see `DelegationRetries`.
         */
        'agent.delegation.retryOptions': ({ delegationId }) =>
            service.retries.options(delegationId),
        'agent.delegation.retry': ({ delegationId, mode, scheduleAt, provider }) =>
            service.retries.retry(delegationId, mode, scheduleAt, provider),
        'agent.delegation.cancelScheduledRetry': ({ delegationId }) =>
            service.retries.cancelScheduled(delegationId),
        'agent.delegation.presets': () => coreRouted('agent.delegation.presets'),
        'agent.delegation.presetsInternal': ({
            projectId,
            sessionId,
            callerProvider,
            ...authority
        }) => service.presets(authority, { projectId, sessionId, callerProvider }),
        'agent.delegation.stop': () => coreRouted('agent.delegation.stop'),
        'agent.delegation.stopInternal': ({ delegationId, ...authority }) =>
            service.stop(delegationId, authority),
        'agent.delegation.create': () => coreRouted('agent.delegation.create'),
        'agent.delegation.status': () => coreRouted('agent.delegation.status'),
        'agent.delegation.result': () => coreRouted('agent.delegation.result'),
        'agent.delegation.list': () => coreRouted('agent.delegation.list'),
        'agent.delegation.listInternal': ({ active, limit, ...authority }) =>
            service.list(authority, { active, limit }),
        'agent.delegation.wait': () => coreRouted('agent.delegation.wait'),
        'agent.delegation.waitInternal': async (
            { delegationId, otherDelegationIds = [], timeoutMs, ignoreQuestions, ...authority },
            signal,
        ) =>
            withPullRequest(
                pullRequests,
                claimed(
                    database,
                    await service.wait(
                        [delegationId, ...otherDelegationIds],
                        authority,
                        timeoutMs,
                        signal,
                        ignoreQuestions,
                    ),
                ),
            ),
        'agent.delegation.createInternal': ({ delegationId, input, ...authority }) =>
            service.create(delegationId, authority, input),
        'agent.delegation.statusInternal': ({ delegationId, ...authority }) =>
            service.status(delegationId, authority),
        'agent.delegation.resultInternal': async ({ delegationId, ...authority }) =>
            withPullRequest(
                pullRequests,
                claimed(database, await service.result(delegationId, authority)),
            ),
        'agent.delegation.history': () => coreRouted('agent.delegation.history'),
        /**
         * Reads settled-task rows only, never an answer, so it is never `claimed`.
         */
        'agent.delegation.historyInternal': ({ query, outcome, limit, after, ...authority }) =>
            readHistory(database, authority, { query, outcome, limit, after }, logger),
        'agent.delegation.transcript': () => coreRouted('agent.delegation.transcript'),
        /**
         * Under the same ownership rule as `result`, but never `claimed`: reading the conversation is not reading the
         * answer, which must stay unread until the delegating Agent asks for it.
         */
        'agent.delegation.transcriptInternal': ({ delegationId, after, ...authority }) =>
            readDelegationChatPage(
                transcripts,
                service.owned(delegationId, authority, 'existing'),
                after,
            ),
    };
}
