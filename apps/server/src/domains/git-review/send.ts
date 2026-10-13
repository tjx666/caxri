import {
    AGENT_CHAT_LONG_PASTE_THRESHOLD,
    CaxriError,
    formatGitReviewComments,
    formatLongPasteReference,
    formatReviewTerminalInput,
    isChatTerminal,
    isGitReviewPromptInline,
    isLongPasteWithinLimit,
} from '@caxri/protocol';

import type { AgentChatService } from '../agent-chat';
import type { LongPasteService } from '../agents';
import type { CaxriDatabase } from '../db';
import type { DomainHandlers } from '../domain-services';
import type { GitService } from '../git';
import { assertPtyTerminal } from '../pty-guard';
import type { TerminalManager } from '../terminal';
import type { GitReviewCommentStore } from './comments';

/**
 * Duplicated from the Desktop Renderer's `lib/repository-file-path.ts` rather than imported: the Server may not import
 * Renderer code. Lexical validation only; the Server's own repository-root resolution remains the authorization
 * boundary for the resulting path.
 */
function resolveRepoFilePath(repoRootPath: string, relativePath: string): string | undefined {
    if (!repoRootPath.startsWith('/') || repoRootPath.includes('\0')) return undefined;
    if (!relativePath || relativePath.includes('\0') || relativePath.startsWith('/'))
        return undefined;
    if (relativePath.split('/').some((segment) => ['', '.', '..'].includes(segment)))
        return undefined;
    const root = repoRootPath === '/' ? '/' : repoRootPath.replace(/\/+$/u, '');
    if (!root) return undefined;
    return root === '/' ? `/${relativePath}` : `${root}/${relativePath}`;
}

interface GitReviewSendOptions {
    agentChat: Pick<AgentChatService, 'send'>;
    database: CaxriDatabase;
    git: Pick<GitService, 'repositoryIdentity'>;
    longPastes: Pick<LongPasteService, 'prepare' | 'saveForChat'>;
    reviewComments: GitReviewCommentStore;
    terminalInput: DomainHandlers['terminal.input'];
    terminals: Pick<TerminalManager, 'agentLaunchId' | 'writeAgentExact'>;
}

const LONG_REVIEW_INSTRUCTION = 'Address every review comment in that file.';

/**
 * Builds the send prompt from the Server's own comment store and writes it to the already-attached Terminal the
 * Renderer selected and identifies here, mirroring `terminal/input.ts`'s managed-Agent guard directly in-process
 * instead of recursing through another public method. The Renderer still owns Terminal selection, activation, and the
 * attachment wait: those depend on `PaneLayout`, a Renderer-only concept the Server has no view of.
 */
export function createGitReviewSendHandler(
    options: GitReviewSendOptions,
): DomainHandlers['gitReview.send'] {
    return async ({ sessionId, repositoryId, terminalId }, signal) => {
        const comments = options.reviewComments
            .list(sessionId, repositoryId)
            .filter((comment) => comment.status === 'pending' && comment.text);
        if (comments.length === 0)
            throw new CaxriError('VALIDATION', 'No pending review comments to send');

        const terminal = options.database.getTerminal(terminalId);
        const isChat = terminal !== undefined && isChatTerminal(terminal);
        if (isChat) {
            if (terminal.sessionId !== sessionId || !terminal.provider)
                throw new CaxriError('NOT_FOUND', 'Agent Chat not found in this Session');
        } else {
            assertPtyTerminal(terminal);
            if (!options.terminals.agentLaunchId(terminalId))
                throw new CaxriError('CONFLICT', 'Managed Agent is no longer running');
        }

        const { rootPath } = await options.git.repositoryIdentity(sessionId, repositoryId);
        const session = options.database.getSession(sessionId);
        const project = session ? options.database.getProject(session.projectId) : undefined;
        const prompt = formatGitReviewComments(
            comments,
            project?.rootPath,
            (comment) => resolveRepoFilePath(rootPath, comment.path) ?? comment.path,
        );
        if (!isLongPasteWithinLimit(prompt))
            throw new CaxriError(
                'VALIDATION',
                'These review comments are too long to send at once. Send fewer comments.',
            );

        if (isChat) {
            /**
             * A Chat takes the prompt as an ordinary message: no bracketed paste, and `send` starts or resumes the
             * provider itself. It resolves once the provider took the message or it joined the Chat's follow-up queue,
             * which is the point the comments count as sent. A prompt past the Chat's own long-paste threshold goes
             * through the same saved file a composer paste would.
             */
            const text =
                prompt.length <= AGENT_CHAT_LONG_PASTE_THRESHOLD
                    ? prompt
                    : `${formatLongPasteReference(
                          await options.longPastes.saveForChat(
                              { terminalId, content: prompt },
                              signal,
                          ),
                      )}\n${LONG_REVIEW_INSTRUCTION}`;
            await options.agentChat.send(terminalId, { text });
        } else if (!isGitReviewPromptInline(prompt)) {
            const result = await options.longPastes.prepare(
                { terminalId, content: prompt },
                signal,
            );
            if (result.status !== 'saved')
                throw new CaxriError(
                    'CONFLICT',
                    'Review comments require a managed Agent Terminal',
                );
            const accepted = options.terminals.writeAgentExact(
                terminalId,
                formatReviewTerminalInput(
                    `${formatLongPasteReference(result)}\n${LONG_REVIEW_INSTRUCTION}`,
                ),
                result.agentLaunchId,
            );
            if (!accepted)
                throw new CaxriError('CONFLICT', 'Managed Agent changed before review input');
        } else {
            await options.terminalInput(
                {
                    terminalId,
                    data: formatReviewTerminalInput(prompt),
                    requireRunningAgent: true,
                },
                signal,
            );
        }

        const sentCommentIds = comments.map((comment) => comment.id);
        options.reviewComments.markSent(sentCommentIds);
        return { sentCommentIds };
    };
}
