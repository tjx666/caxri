import { errorMessage, isChatTerminal } from '@caxri/protocol';
import type { StructuredLogger } from '@caxri/system';
import { logEventCatalog } from '@caxri/system';

import type { AgentChatService } from './agent-chat';
import type { CaxriDatabase } from './db';
import type { TerminalManager } from './terminal';

/**
 * Closed outcome of one merge notice, logged so a "my Agent never heard about the merge" report names the cause.
 */
export type MergeNoticeOutcome =
    | 'sent'
    | 'disabled'
    | 'no-session'
    | 'no-agent'
    | 'agent-not-running'
    | 'rejected'
    | 'unknown'
    | 'failed';

export interface PullRequestMergeNoticeOptions {
    agentChat: Pick<AgentChatService, 'send'>;
    database: Pick<CaxriDatabase, 'getSession' | 'getTerminal'>;
    isEnabled(): boolean;
    logger: Pick<StructuredLogger, 'write'>;
    terminals: Pick<TerminalManager, 'agentLaunchId' | 'submitAgentExact'>;
}

export function formatMergeNotice(url: string): string {
    return `Pull request ${url} has been merged.`;
}

/**
 * Tells the Session's primary Agent that Caxri just merged one of its pull requests, so an Agent waiting on CI or a
 * review can move on without the user typing the news (opt-in through `projectStatus.notifyAgentOnMerge`).
 *
 * Delivery is best effort and never fails the merge that already happened: a PTY Agent receives a fenced submit pinned
 * to its current launch, a Chat Agent receives an ordinary turn, and every other case is only logged.
 */
export function createPullRequestMergeNotice(options: PullRequestMergeNoticeOptions) {
    const deliver = async (sessionId: string, url: string): Promise<MergeNoticeOutcome> => {
        if (!options.isEnabled()) return 'disabled';
        const session = options.database.getSession(sessionId);
        if (!session) return 'no-session';
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

    return async (sessionId: string, url: string): Promise<MergeNoticeOutcome> => {
        const startedAt = performance.now();
        let outcome: MergeNoticeOutcome;
        let error: string | undefined;
        try {
            outcome = await deliver(sessionId, url);
        } catch (error_) {
            outcome = 'failed';
            error = errorMessage(error_, 'unknown');
        }
        if (outcome !== 'disabled')
            options.logger.write(
                outcome === 'sent' ? 'info' : 'warn',
                logEventCatalog.git.mergeAgentNotice,
                {
                    durationMs: performance.now() - startedAt,
                    fields: { outcome, ...(error && { error }) },
                },
            );
        return outcome;
    };
}
