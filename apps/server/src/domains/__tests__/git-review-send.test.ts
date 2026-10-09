import { describe, expect, it, vi } from 'vitest';

import type { LongPasteService } from '../agents';
import type { DomainHandlers } from '../domain-services';
import { GitReviewCommentStore } from '../git-review-comments';
import { createGitReviewSendHandler } from '../git-review-send';
import type { TerminalManager } from '../terminal/manager';

function makeOptions(overrides: Partial<Parameters<typeof createGitReviewSendHandler>[0]> = {}) {
    const reviewComments = overrides.reviewComments ?? new GitReviewCommentStore(vi.fn());
    return {
        database: {
            getSession: vi.fn(() => ({ projectId: 'project-1' })),
            getTerminal: vi.fn(() => ({ surface: 'pty' })),
            getProject: vi.fn(() => ({ rootPath: '/project' })),
        } as never,
        git: {
            repositoryIdentity: vi.fn().mockResolvedValue({ name: 'my-repo', rootPath: '/repo' }),
        },
        longPastes: { prepare: vi.fn() } as never,
        terminalInput: vi.fn<DomainHandlers['terminal.input']>().mockResolvedValue(null),
        terminals: {
            agentLaunchId: vi.fn(() => 'launch-1'),
            writeAgentExact: vi.fn(() => true),
        } as never,
        reviewComments,
        ...overrides,
    };
}

describe('createGitReviewSendHandler', () => {
    it('rejects when there are no pending comments with text', async () => {
        const options = makeOptions();
        const handler = createGitReviewSendHandler(options);

        await expect(
            handler(
                { sessionId: 'session-1', repositoryId: 'repo-1', terminalId: 'terminal-1' },
                undefined as never,
            ),
        ).rejects.toThrow('No pending review comments to send');
    });

    it('rejects when the target Terminal has no running Agent', async () => {
        const reviewComments = new GitReviewCommentStore(vi.fn());
        reviewComments.add({
            id: 'a',
            sessionId: 'session-1',
            repositoryId: 'repo-1',
            sourceKey: 'working',
            path: 'src/example.ts',
            side: 'modified',
            startLine: 1,
            endLine: 1,
            snippet: 'line',
            text: 'Fix this',
            status: 'pending',
        });
        const options = makeOptions({
            reviewComments,
            terminals: { agentLaunchId: vi.fn(() => {}), writeAgentExact: vi.fn() } as never,
        });
        const handler = createGitReviewSendHandler(options);

        await expect(
            handler(
                { sessionId: 'session-1', repositoryId: 'repo-1', terminalId: 'terminal-1' },
                undefined as never,
            ),
        ).rejects.toThrow('Managed Agent is no longer running');
    });

    it('writes an inline bracketed paste and marks the sent comments', async () => {
        const reviewComments = new GitReviewCommentStore(vi.fn());
        reviewComments.add({
            id: 'a',
            sessionId: 'session-1',
            repositoryId: 'repo-1',
            sourceKey: 'working',
            path: 'src/example.ts',
            side: 'modified',
            startLine: 1,
            endLine: 1,
            snippet: 'line',
            text: 'Fix this',
            status: 'pending',
        });
        const terminalInput = vi.fn<DomainHandlers['terminal.input']>().mockResolvedValue(null);
        const options = makeOptions({ reviewComments, terminalInput });
        const handler = createGitReviewSendHandler(options);
        const signal = {} as never;

        const result = await handler(
            { sessionId: 'session-1', repositoryId: 'repo-1', terminalId: 'terminal-1' },
            signal,
        );

        expect(result).toEqual({ sentCommentIds: ['a'] });
        expect(reviewComments.list('session-1', 'repo-1')[0]).toMatchObject({ status: 'sent' });
        expect(terminalInput).toHaveBeenCalledTimes(1);
        const [input, usedSignal] = terminalInput.mock.calls[0];
        expect(input).toMatchObject({ terminalId: 'terminal-1', requireRunningAgent: true });
        expect(input.data).toContain('Fix this');
        // The repository root (`/repo`) is unrelated to the Project root (`/project`), so the prompt uses the
        // resolved absolute path rather than a Project-relative one; see `reviewFileReference` in
        // `git-review-contract.ts`.
        expect(input.data).toContain('@/repo/src/example.ts#L1');
        // Bracketed paste envelope, matching `formatReviewTerminalInput`.
        expect(input.data.startsWith('\u{1B}[200~')).toBe(true);
        expect(input.data.endsWith('\u{1B}[201~\r')).toBe(true);
        expect(usedSignal).toBe(signal);
    });

    it('saves a long paste and writes its reference when the prompt exceeds the inline limit', async () => {
        const reviewComments = new GitReviewCommentStore(vi.fn());
        reviewComments.add({
            id: 'a',
            sessionId: 'session-1',
            repositoryId: 'repo-1',
            sourceKey: 'working',
            path: 'src/example.ts',
            side: 'modified',
            startLine: 1,
            endLine: 1,
            snippet: 'line',
            text: 'x'.repeat(5_000),
            status: 'pending',
        });
        const prepare = vi.fn<LongPasteService['prepare']>().mockResolvedValue({
            status: 'saved',
            filePath: '/tmp/review.md',
            lineCount: 10,
            characterCount: 5_000,
            agentLaunchId: 'launch-2',
        });
        const writeAgentExact = vi.fn<TerminalManager['writeAgentExact']>(() => true);
        const options = makeOptions({
            reviewComments,
            longPastes: { prepare } as never,
            terminals: { agentLaunchId: vi.fn(() => 'launch-1'), writeAgentExact },
        });
        const handler = createGitReviewSendHandler(options);

        const result = await handler(
            { sessionId: 'session-1', repositoryId: 'repo-1', terminalId: 'terminal-1' },
            undefined,
        );

        expect(result).toEqual({ sentCommentIds: ['a'] });
        expect(prepare).toHaveBeenCalledWith(
            {
                terminalId: 'terminal-1',
                content: expect.stringContaining('x'.repeat(5_000)) as string,
            },
            undefined,
        );
        expect(writeAgentExact).toHaveBeenCalledTimes(1);
        const [terminalId, data, agentLaunchId] = writeAgentExact.mock.calls[0];
        expect(terminalId).toBe('terminal-1');
        expect(agentLaunchId).toBe('launch-2');
        expect(data).toContain('[Long paste saved locally]');
        expect(data).toContain('Original file: "/tmp/review.md"');
        expect(data).toContain('Address every review comment in that file.');
    });

    it('rejects when the long paste could not be saved', async () => {
        const reviewComments = new GitReviewCommentStore(vi.fn());
        reviewComments.add({
            id: 'a',
            sessionId: 'session-1',
            repositoryId: 'repo-1',
            sourceKey: 'working',
            path: 'src/example.ts',
            side: 'modified',
            startLine: 1,
            endLine: 1,
            snippet: 'line',
            text: 'x'.repeat(5_000),
            status: 'pending',
        });
        const options = makeOptions({
            reviewComments,
            longPastes: { prepare: vi.fn().mockResolvedValue({ status: 'rejected' }) } as never,
        });
        const handler = createGitReviewSendHandler(options);

        await expect(
            handler(
                { sessionId: 'session-1', repositoryId: 'repo-1', terminalId: 'terminal-1' },
                undefined as never,
            ),
        ).rejects.toThrow('Review comments require a managed Agent Terminal');
        expect(reviewComments.list('session-1', 'repo-1')[0]).toMatchObject({ status: 'pending' });
    });

    it('rejects when the managed Agent changed before the long paste reference could be written', async () => {
        const reviewComments = new GitReviewCommentStore(vi.fn());
        reviewComments.add({
            id: 'a',
            sessionId: 'session-1',
            repositoryId: 'repo-1',
            sourceKey: 'working',
            path: 'src/example.ts',
            side: 'modified',
            startLine: 1,
            endLine: 1,
            snippet: 'line',
            text: 'x'.repeat(5_000),
            status: 'pending',
        });
        const options = makeOptions({
            reviewComments,
            longPastes: {
                prepare: vi.fn().mockResolvedValue({
                    status: 'saved',
                    filePath: '/tmp/review.md',
                    lineCount: 10,
                    characterCount: 5_000,
                    agentLaunchId: 'launch-2',
                }),
            } as never,
            terminals: {
                agentLaunchId: vi.fn(() => 'launch-1'),
                writeAgentExact: vi.fn(() => false),
            },
        });
        const handler = createGitReviewSendHandler(options);

        await expect(
            handler(
                { sessionId: 'session-1', repositoryId: 'repo-1', terminalId: 'terminal-1' },
                undefined as never,
            ),
        ).rejects.toThrow('Managed Agent changed before review input');
        expect(reviewComments.list('session-1', 'repo-1')[0]).toMatchObject({ status: 'pending' });
    });
});
