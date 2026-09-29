import { appendFile, mkdir, mkdtemp, rm, symlink, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import type { SessionRecord } from '@caxri/protocol';
import type { StructuredLogger } from '@caxri/system';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import type { CaxriDatabase } from '../db';
import { SessionContextService } from '../session-context';

const AGENT_SESSION_ID = 'abc-1234-5678-9012';

function claudeRecord(command: string, cwd: string): string {
    return `${JSON.stringify({
        type: 'assistant',
        cwd,
        gitBranch: 'main',
        message: { content: [{ type: 'tool_use', id: 't1', name: 'Bash', input: { command } }] },
    })}\n`;
}

describe('SessionContextService', () => {
    let home: string;
    let cwd: string;
    let transcript: string;
    let getTerminal: ReturnType<typeof vi.fn>;

    beforeEach(async () => {
        home = await mkdtemp(join(tmpdir(), 'caxri-session-context-'));
        cwd = join(home, 'project');
        const directory = join(home, '.claude', 'projects', cwd.replaceAll(/[^a-z\d]/gi, '-'));
        await mkdir(directory, { recursive: true });
        transcript = join(directory, `${AGENT_SESSION_ID}.jsonl`);
        await writeFile(transcript, '');
        getTerminal = vi.fn(() => ({
            id: 't1',
            provider: 'claude',
            agentSessionId: AGENT_SESSION_ID,
            cwd,
        }));
    });

    afterEach(async () => {
        await rm(home, { force: true, recursive: true });
    });

    function fakeLogger(): { logger: StructuredLogger; write: ReturnType<typeof vi.fn> } {
        const write = vi.fn();
        return { logger: { write } as unknown as StructuredLogger, write };
    }

    function service(logger: StructuredLogger = fakeLogger().logger): SessionContextService {
        return new SessionContextService({ getTerminal } as unknown as CaxriDatabase, logger, {
            homeDirectory: home,
            variables: {},
        });
    }

    const session = { primaryAgentTerminalId: 't1' } as SessionRecord;

    it('answers most-recently-named first, which is the order the picker ranks by', async () => {
        await appendFile(transcript, claudeRecord('cd /worktrees/alpha', cwd));
        await appendFile(transcript, claudeRecord('cd /worktrees/beta', cwd));
        const context = await service().read(session);
        expect(context.directories.slice(0, 2)).toEqual(['/worktrees/beta', cwd]);
    });

    it('reads only what was appended since the previous visit', async () => {
        const instance = service();
        await appendFile(transcript, claudeRecord('cd /worktrees/alpha', cwd));
        expect((await instance.read(session)).directories).toContain('/worktrees/alpha');
        await appendFile(transcript, claudeRecord('cd /worktrees/beta', cwd));
        const second = await instance.read(session);
        expect(second.directories).toContain('/worktrees/beta');
        expect(second.directories).toContain('/worktrees/alpha');
    });

    it('finds the latest acceptance round on the first read of a long transcript', async () => {
        const id = 'a1b2c3d4-5e6f-4a7b-8c9d-0e1f2a3b4c5d';
        const link = `https://app.lobehub.com/acceptance/${id}`;
        const filler = `${JSON.stringify({
            type: 'event_msg',
            payload: { type: 'token_count', data: 'x'.repeat(1024 * 1024) },
        })}\n`;
        const finalMessage = `${JSON.stringify({
            type: 'response_item',
            payload: {
                type: 'message',
                role: 'assistant',
                content: [{ type: 'output_text', text: `Acceptance: ${link}?r=7` }],
            },
        })}\n`;
        await writeFile(
            transcript,
            `${claudeRecord(`echo ${link}?r=1`, cwd)}${filler.repeat(5)}${finalMessage}`,
        );

        const context = await service().read(session);

        expect(context.acceptanceReferences).toEqual([{ id, round: 7 }]);
    });

    it('skips an oversized record to reach a later acceptance link', async () => {
        const id = 'a1b2c3d4-5e6f-4a7b-8c9d-0e1f2a3b4c5d';
        const oversized = JSON.stringify({ type: 'event_msg', data: 'x'.repeat(5 * 1024 * 1024) });
        await writeFile(
            transcript,
            `${oversized}\n${claudeRecord(`Acceptance: https://app.lobehub.com/acceptance/${id}?r=7`, cwd)}`,
        );

        const context = await service().read(session);

        expect(context.acceptanceReferences).toEqual([{ id, round: 7 }]);
    });

    it('rescans from the start when the transcript shrinks below the cursor', async () => {
        const instance = service();
        await appendFile(transcript, claudeRecord('cd /worktrees/alpha', cwd));
        await instance.read(session);
        // Strictly shorter than what it replaces: a truncation is detected by size, not by content.
        await writeFile(transcript, claudeRecord('cd /gamma', cwd));
        const rescanned = await instance.read(session);
        expect(rescanned.directories).toContain('/gamma');
        expect(rescanned.directories).not.toContain('/worktrees/alpha');
    });

    it('catches up to the tail of a long rewritten transcript in the same read', async () => {
        const filler = `${JSON.stringify({ type: 'event_msg', data: 'x'.repeat(1024 * 1024) })}\n`;
        const instance = service();
        await writeFile(transcript, `${claudeRecord('cd /old', cwd)}${filler.repeat(6)}`);
        await instance.read(session);

        await writeFile(transcript, `${filler.repeat(5)}${claudeRecord('cd /new', cwd)}`);
        const context = await instance.read(session);

        expect(context.directories).toContain('/new');
        expect(context.directories).not.toContain('/old');
    });

    it('joins concurrent reads of one transcript into a single pass', async () => {
        const instance = service();
        await appendFile(transcript, claudeRecord('cd /worktrees/alpha', cwd));
        const [first, second] = await Promise.all([instance.read(session), instance.read(session)]);
        expect(second).toEqual(first);
    });

    it('answers an empty context for a Session with no Agent Terminal', async () => {
        expect(await service().read({} as SessionRecord)).toEqual({
            acceptanceReferences: [],
            branches: [],
            directories: [],
            linearReferences: [],
            pullRequests: {},
        });
        expect(getTerminal).not.toHaveBeenCalled();
    });

    it('harvests the delivered pull request in the same pass as every other clue', async () => {
        const url = 'https://github.com/example/example/pull/42';
        await appendFile(transcript, claudeRecord('gh pr create --fill', cwd));
        await appendFile(
            transcript,
            `${JSON.stringify({
                type: 'user',
                message: { content: [{ type: 'tool_result', tool_use_id: 't1', content: url }] },
            })}\n`,
        );
        await appendFile(transcript, claudeRecord('cd /worktrees/alpha', cwd));

        const context = await service().read(session);

        expect(context.pullRequests.created).toEqual({
            number: 42,
            owner: 'example',
            repo: 'example',
            url,
        });
        expect(context.directories).toContain('/worktrees/alpha');
    });

    it('forgets a pull request whose record the rewritten transcript no longer holds', async () => {
        const instance = service();
        await appendFile(transcript, claudeRecord('gh pr create --fill', cwd));
        await appendFile(
            transcript,
            `${JSON.stringify({
                type: 'user',
                message: {
                    content: [
                        {
                            type: 'tool_result',
                            tool_use_id: 't1',
                            content: 'https://github.com/example/example/pull/42',
                        },
                    ],
                },
            })}\n`,
        );
        expect((await instance.read(session)).pullRequests.created?.number).toBe(42);

        await writeFile(transcript, claudeRecord('cd /gamma', cwd));

        expect((await instance.read(session)).pullRequests).toEqual({});
    });

    it('counts a routine missing transcript without an immediate failure record', async () => {
        const { logger, write } = fakeLogger();
        getTerminal.mockReturnValueOnce({
            id: 't1',
            provider: 'claude',
            agentSessionId: 'no-transcript-yet-0000',
            cwd,
        });

        const context = await service(logger).read(session);

        expect(context).toEqual({
            acceptanceReferences: [],
            branches: [],
            directories: [],
            linearReferences: [],
            pullRequests: {},
        });
        const failures = write.mock.calls.filter(
            ([, event]) => event === 'session_context.scan_failed',
        );
        expect(failures).toEqual([]);
    });

    it('logs a symlinked transcript as a security rejection at warn, not as a missing file', async () => {
        const { logger, write } = fakeLogger();
        await rm(transcript, { force: true });
        await symlink(join(home, 'outside.jsonl'), transcript);

        await service(logger).read(session);

        const failures = write.mock.calls.filter(
            ([, event]) => event === 'session_context.scan_failed',
        );
        expect(failures).toHaveLength(1);
        expect(failures[0][0]).toBe('warn');
        expect(failures[0][2]).toMatchObject({ fields: { reason: 'symlinkRejected' } });
    });

    it('logs a cursor reset as its own state transition when a transcript shrinks', async () => {
        const { logger, write } = fakeLogger();
        const instance = service(logger);
        await appendFile(transcript, claudeRecord('cd /worktrees/alpha', cwd));
        await instance.read(session);
        await writeFile(transcript, claudeRecord('cd /gamma', cwd));

        await instance.read(session);

        const resets = write.mock.calls.filter(
            ([, event]) => event === 'session_context.cursor_reset',
        );
        expect(resets).toHaveLength(1);
        expect(resets[0][0]).toBe('info');
    });
});
