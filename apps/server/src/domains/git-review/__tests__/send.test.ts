import type { TerminalRecord } from '@caxri/protocol';
import { describe, expect, it, vi } from 'vitest';

import type { LongPasteService } from '../../agents';
import type { DomainHandlers } from '../../domain-services';
import type { TerminalManager } from '../../terminal/manager';
import { GitReviewCommentStore } from '../comments';
import { createGitReviewSendHandler } from '../send';

function makeOptions(overrides: Partial<Parameters<typeof createGitReviewSendHandler>[0]> = {}) {
    const reviewComments = overrides.reviewComments ?? new GitReviewCommentStore(vi.fn());
    return {
        agentChat: { send: vi.fn().mockResolvedValue(undefined) },
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

    describe('to an Agent Chat', () => {
        const chatTerminal: Pick<TerminalRecord, 'provider' | 'sessionId' | 'surface'> = {
            surface: 'chat',
            sessionId: 'session-1',
            provider: 'codex',
        };

        function addComment(store: GitReviewCommentStore, text: string): void {
            store.add({
                id: 'a',
                sessionId: 'session-1',
                repositoryId: 'repo-1',
                sourceKey: 'working',
                path: 'src/example.ts',
                side: 'modified',
                startLine: 1,
                endLine: 1,
                snippet: 'line',
                text,
                status: 'pending',
            });
        }

        function chatOptions(
            reviewComments: GitReviewCommentStore,
            send = vi.fn().mockResolvedValue(undefined),
            terminal = chatTerminal,
        ) {
            const base = makeOptions({ reviewComments });
            return makeOptions({
                reviewComments,
                agentChat: { send },
                database: {
                    ...(base.database as object),
                    getTerminal: vi.fn(() => terminal),
                } as never,
            });
        }

        it('sends the plain prompt as a Chat message and marks the comments after it is accepted', async () => {
            const reviewComments = new GitReviewCommentStore(vi.fn());
            addComment(reviewComments, 'Fix this');
            const send = vi.fn().mockResolvedValue(undefined);
            const options = chatOptions(reviewComments, send);

            const result = await createGitReviewSendHandler(options)(
                { sessionId: 'session-1', repositoryId: 'repo-1', terminalId: 'chat-1' },
                undefined,
            );

            expect(result).toEqual({ sentCommentIds: ['a'] });
            expect(send).toHaveBeenCalledTimes(1);
            const [terminalId, message] = send.mock.calls[0] as [string, { text: string }];
            expect(terminalId).toBe('chat-1');
            expect(message.text).toContain('Fix this');
            expect(message.text).toContain('@/repo/src/example.ts#L1');
            // A Chat message is not Terminal input: no bracketed-paste envelope.
            expect(message.text).not.toContain('\u{1B}[200~');
            expect(options.terminalInput).not.toHaveBeenCalled();
            expect(reviewComments.list('session-1', 'repo-1')[0]).toMatchObject({
                status: 'sent',
            });
        });

        it('keeps the comments pending when the Chat refuses the message', async () => {
            const reviewComments = new GitReviewCommentStore(vi.fn());
            addComment(reviewComments, 'Fix this');
            const options = chatOptions(
                reviewComments,
                vi.fn().mockRejectedValue(new Error('Chat closed')),
            );

            await expect(
                createGitReviewSendHandler(options)(
                    { sessionId: 'session-1', repositoryId: 'repo-1', terminalId: 'chat-1' },
                    undefined,
                ),
            ).rejects.toThrow('Chat closed');
            expect(reviewComments.list('session-1', 'repo-1')[0]).toMatchObject({
                status: 'pending',
            });
        });

        it('saves a prompt past the Chat long-paste threshold and sends its reference', async () => {
            const reviewComments = new GitReviewCommentStore(vi.fn());
            addComment(reviewComments, 'x'.repeat(40_000));
            const send = vi.fn().mockResolvedValue(undefined);
            const options = chatOptions(reviewComments, send);
            const saveForChat = vi.fn<LongPasteService['saveForChat']>().mockResolvedValue({
                filePath: '/tmp/review.md',
                lineCount: 10,
                characterCount: 40_000,
            });
            options.longPastes = { prepare: vi.fn(), saveForChat };

            await createGitReviewSendHandler(options)(
                { sessionId: 'session-1', repositoryId: 'repo-1', terminalId: 'chat-1' },
                undefined,
            );

            expect(saveForChat).toHaveBeenCalledTimes(1);
            const [, message] = send.mock.calls[0] as [string, { text: string }];
            expect(message.text).toContain('Original file: "/tmp/review.md"');
            expect(message.text).toContain('Address every review comment in that file.');
        });

        it('refuses a Chat that belongs to another Session', async () => {
            const reviewComments = new GitReviewCommentStore(vi.fn());
            addComment(reviewComments, 'Fix this');
            const send = vi.fn();
            const options = chatOptions(reviewComments, send, {
                ...chatTerminal,
                sessionId: 'session-2',
            });

            await expect(
                createGitReviewSendHandler(options)(
                    { sessionId: 'session-1', repositoryId: 'repo-1', terminalId: 'chat-1' },
                    undefined,
                ),
            ).rejects.toThrow('Agent Chat not found in this Session');
            expect(send).not.toHaveBeenCalled();
        });
    });
});
