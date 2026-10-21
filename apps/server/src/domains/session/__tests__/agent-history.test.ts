import { mkdir, mkdtemp, realpath, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { describe, expect, it, onTestFinished, vi } from 'vitest';

import { SessionSearchIndexUnavailableError } from '../../agents';
import type { ConversationIdentity } from '../../agents/session-search/worker-protocol';
import { CaxriDatabase } from '../../db';
import { SessionAgentHistoryService } from '../agent-history';

const FIRST = '019a0000-0000-7000-8000-00000000b001';
const SECOND = '019a0000-0000-7000-8000-00000000b002';
const ELSEWHERE = '019a0000-0000-7000-8000-00000000b003';

async function fixture() {
    const temporary = await mkdtemp(join(tmpdir(), 'caxri-agent-history-'));
    const directory = await realpath(temporary);
    const database = new CaxriDatabase(join(directory, 'state.db'));
    onTestFinished(async () => {
        database.close();
        await rm(directory, { recursive: true, force: true });
    });
    const repo = join(directory, 'billing');
    await mkdir(repo, { recursive: true });
    const project = database.createProject(repo);
    const { session, terminal } = database.createSession(project.id, 'codex');
    // The first conversation, then `/clear` moves the same Terminal on to a second one.
    const now = vi.spyOn(Date, 'now');
    onTestFinished(() => now.mockRestore());
    now.mockReturnValue(1_000);
    database.rebindAgentSession(terminal!.id, 'codex', FIRST);
    now.mockReturnValue(2_000);
    database.rebindAgentSession(terminal!.id, 'codex', SECOND);
    now.mockReturnValue(3_000);
    const describe = vi.fn((conversations: ConversationIdentity[]) =>
        Promise.resolve(
            conversations.map(({ agentSessionId }) =>
                agentSessionId === FIRST ? 'Fix invoice rounding' : undefined,
            ),
        ),
    );
    const onTerminalCreated = vi.fn();
    const service = new SessionAgentHistoryService({
        database,
        index: { describe },
        onTerminalCreated,
    });
    return {
        database,
        describe,
        onTerminalCreated,
        project,
        repo,
        service,
        session,
        terminal: terminal!,
    };
}

describe('SessionAgentHistoryService', () => {
    it('lists every conversation the Session hosted, newest first, with the open one marked', async () => {
        const f = await fixture();

        await expect(f.service.list(f.session.id)).resolves.toEqual({
            entries: [
                {
                    provider: 'codex',
                    agentSessionId: SECOND,
                    boundAt: 2_000,
                    terminalId: f.terminal.id,
                },
                {
                    provider: 'codex',
                    agentSessionId: FIRST,
                    boundAt: 1_000,
                    title: 'Fix invoice rounding',
                },
            ],
        });
    });

    it('still lists conversations when the search index is unavailable', async () => {
        const f = await fixture();
        f.describe.mockRejectedValue(new SessionSearchIndexUnavailableError());

        const { entries } = await f.service.list(f.session.id);

        expect(entries.map(({ agentSessionId }) => agentSessionId)).toEqual([SECOND, FIRST]);
        expect(entries.every(({ title }) => title === undefined)).toBe(true);
    });

    it('omits a conversation another Session has since resumed', async () => {
        const f = await fixture();
        f.database.rebindAgentSession(f.terminal.id, 'codex', ELSEWHERE);
        const other = f.database.createSession(f.project.id, 'codex');
        f.database.closeTerminal(f.terminal.id);
        f.database.rebindAgentSession(other.terminal!.id, 'codex', ELSEWHERE);

        const { entries } = await f.service.list(f.session.id);

        expect(entries.map(({ agentSessionId }) => agentSessionId)).toEqual([SECOND, FIRST]);
        await expect(f.service.reopen(f.session.id, 'codex', ELSEWHERE)).rejects.toMatchObject({
            code: 'CONFLICT',
        });
    });

    it('reopens a closed conversation as a parked Agent Terminal in the same Session', async () => {
        const f = await fixture();
        f.database.closeTerminal(f.terminal.id);

        const { terminalId } = await f.service.reopen(f.session.id, 'codex', FIRST);

        const reopened = f.database.getTerminal(terminalId)!;
        expect(reopened).toMatchObject({
            sessionId: f.session.id,
            provider: 'codex',
            agentSessionId: FIRST,
            cwd: f.repo,
        });
        expect(reopened.lastProcessState).toBe('detached');
        expect(f.onTerminalCreated).toHaveBeenCalledOnce();
        // Reopening again focuses that Terminal instead of creating a second one for the same conversation.
        await expect(f.service.reopen(f.session.id, 'codex', FIRST)).resolves.toEqual({
            terminalId,
        });
        expect(f.onTerminalCreated).toHaveBeenCalledOnce();
    });

    it('creates one Terminal when the same conversation is reopened twice at once', async () => {
        const f = await fixture();
        f.database.closeTerminal(f.terminal.id);

        const [first, second] = await Promise.all([
            f.service.reopen(f.session.id, 'codex', FIRST),
            f.service.reopen(f.session.id, 'codex', FIRST),
        ]);

        expect(second).toEqual(first);
        expect(f.onTerminalCreated).toHaveBeenCalledOnce();
    });

    it('returns the open Terminal for a conversation the Session still holds', async () => {
        const f = await fixture();

        await expect(f.service.reopen(f.session.id, 'codex', SECOND)).resolves.toEqual({
            terminalId: f.terminal.id,
        });
        expect(f.onTerminalCreated).not.toHaveBeenCalled();
    });

    it('refuses a conversation the Session never hosted', async () => {
        const f = await fixture();
        const other = f.database.createSession(f.project.id, 'codex');
        f.database.rebindAgentSession(other.terminal!.id, 'codex', ELSEWHERE);
        f.database.closeTerminal(other.terminal!.id);

        await expect(f.service.reopen(f.session.id, 'codex', ELSEWHERE)).rejects.toMatchObject({
            code: 'NOT_FOUND',
        });
    });
});
