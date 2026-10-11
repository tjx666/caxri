import {
    CaxriError,
    formatGitReviewComments,
    formatReviewTerminalInput,
    isGitReviewPromptInline,
    isLongPasteWithinLimit,
} from '@caxri/protocol';

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

/**
 * Duplicated from the Desktop Renderer's `features/terminal/terminal-long-paste.ts` (`formatLongPasteReference`) rather
 * than imported: same Server/Renderer boundary as above. Keep both copies in sync if the reference text changes.
 */
function reviewLongPasteReference(result: {
    characterCount: number;
    filePath: string;
    lineCount: number;
}): string {
    const lines = `${result.lineCount} ${result.lineCount === 1 ? 'line' : 'lines'}`;
    const characters = `${result.characterCount} ${result.characterCount === 1 ? 'character' : 'characters'}`;
    return [
        '[Long paste saved locally]',
        `Original file: ${JSON.stringify(result.filePath)}`,
        `Original size: ${lines}, ${characters}`,
        '',
        'Read the original file for the exact content.',
        'If a summary is enough, delegate it to a subagent on a small, fast model so the full text stays out of this conversation.',
    ].join('\n');
}

interface GitReviewSendOptions {
    database: CaxriDatabase;
    git: Pick<GitService, 'repositoryIdentity'>;
    longPastes: LongPasteService;
    reviewComments: GitReviewCommentStore;
    terminalInput: DomainHandlers['terminal.input'];
    terminals: Pick<TerminalManager, 'agentLaunchId' | 'writeAgentExact'>;
}

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

        assertPtyTerminal(options.database.getTerminal(terminalId));
        const agentLaunchId = options.terminals.agentLaunchId(terminalId);
        if (!agentLaunchId) throw new CaxriError('CONFLICT', 'Managed Agent is no longer running');

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

        if (!isGitReviewPromptInline(prompt)) {
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
                    `${reviewLongPasteReference(result)}\nAddress every review comment in that file.`,
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
