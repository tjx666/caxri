import { errorMessage, isChatTerminal } from '@caxri/protocol';
import type { StructuredLogger } from '@caxri/system';
import { logEventCatalog } from '@caxri/system';
import { rememberBounded } from '@caxri/utils';

import type { AgentChatService } from '../agent-chat';
import type { CaxriDatabase } from '../db';
import type { TerminalManager } from '../terminal';

/**
 * Closed outcome of one merge notice, logged so a "my Agent never heard about the merge" report names the cause.
 */
export type MergeNoticeOutcome =
    | 'sent'
    | 'disabled'
    | 'no-session'
    | 'no-agent'
    | 'agent-not-running'
    | 'self-merged'
    | 'duplicate'
    | 'rejected'
    | 'unknown'
    | 'failed';

/**
 * How one merge reached Caxri: `caxri` is the Project Status merge button, `detected` is a Session's pull request
 * observed turning merged by any route (GitHub, a teammate, the Agent itself).
 */
export interface MergeNoticeRequest {
    /**
     * When GitHub merged the pull request, in epoch milliseconds, when known.
     */
    mergedAt?: number;
    origin: 'caxri' | 'detected';
}

/**
 * Remembered pull requests per Server Core lifetime; far more than one user merges in a session of work.
 */
const MAX_NOTIFIED_PULL_REQUESTS = 512;

export interface PullRequestMergeNoticeOptions {
    agentChat: Pick<AgentChatService, 'send'>;
    database: Pick<CaxriDatabase, 'getSession' | 'getTerminal'>;
    isEnabled(): boolean;
    /**
     * Whether `at` falls inside one of the Session's Agent turns, which is how a merge the Agent made itself is told
     * apart from one made elsewhere.
     */
    isWithinAgentTurn?(sessionId: string, at: number): boolean;
    logger: Pick<StructuredLogger, 'write'>;
    terminals: Pick<TerminalManager, 'agentLaunchId' | 'submitAgentExact'>;
}

export function formatMergeNotice(url: string): string {
    return `Pull request ${url} has been merged.`;
}

/**
 * Tells the Session's primary Agent that one of its pull requests was merged, so an Agent waiting on CI or a review can
 * move on without the user typing the news (`projectStatus.notifyAgentOnMerge`). Each pull request is announced once
 * per Server Core lifetime, so the merge button and the later detection of the same merge never double-send, and a
 * merge whose `mergedAt` falls inside one of the Session's Agent turns is skipped because the Agent did it itself.
 *
 * Delivery is best effort and never fails the merge that already happened: a PTY Agent receives a fenced submit pinned
 * to its current launch, a Chat Agent receives an ordinary turn, and every other case is only logged.
 */
export function createPullRequestMergeNotice(options: PullRequestMergeNoticeOptions) {
    const notified = new Map<string, true>();
    const deliver = async (
        sessionId: string,
        url: string,
        request: MergeNoticeRequest,
    ): Promise<MergeNoticeOutcome> => {
        if (!options.isEnabled()) return 'disabled';
        const session = options.database.getSession(sessionId);
        if (!session) return 'no-session';
        // Recorded before any await so a button merge and the sweep that notices it race to one winner.
        const key = `${sessionId}\n${url}`;
        if (notified.has(key)) return 'duplicate';
        rememberBounded(notified, key, true, MAX_NOTIFIED_PULL_REQUESTS);
        if (
            request.origin === 'detected' &&
            request.mergedAt !== undefined &&
            options.isWithinAgentTurn?.(sessionId, request.mergedAt)
        )
            return 'self-merged';
        const terminalId = session.primaryAgentTerminalId;
        const terminal = terminalId ? options.database.getTerminal(terminalId) : undefined;
        if (!terminalId || terminal?.sessionId !== sessionId || !terminal.provider)
            return 'no-agent';
        const text = formatMergeNotice(url);
        if (isChatTerminal(terminal)) {
            await options.agentChat.send(terminalId, { text });
            return 'sent';
        }
        const launchId = options.terminals.agentLaunchId(terminalId);
        if (!launchId) return 'agent-not-running';
        const result = await options.terminals.submitAgentExact(
            terminalId,
            sessionId,
            launchId,
            text,
        );
        return result === 'accepted' ? 'sent' : result;
    };

    return async (
        sessionId: string,
        url: string,
        request: MergeNoticeRequest,
    ): Promise<MergeNoticeOutcome> => {
        const startedAt = performance.now();
        let outcome: MergeNoticeOutcome;
        let error: string | undefined;
        try {
            outcome = await deliver(sessionId, url, request);
        } catch (error_) {
            outcome = 'failed';
            error = errorMessage(error_, 'unknown');
        }
        if (outcome !== 'disabled')
            options.logger.write(
                ['sent', 'self-merged', 'duplicate'].includes(outcome) ? 'info' : 'warn',
                logEventCatalog.git.mergeAgentNotice,
                {
                    durationMs: performance.now() - startedAt,
                    fields: { outcome, origin: request.origin, ...(error && { error }) },
                },
            );
        return outcome;
    };
}
