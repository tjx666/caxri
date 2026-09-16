import { appendFile, mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import type { SessionRecord } from '@caxri/protocol';
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

    function service(): SessionContextService {
        return new SessionContextService({ getTerminal } as unknown as CaxriDatabase, {
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

    it('joins concurrent reads of one transcript into a single pass', async () => {
        const instance = service();
        await appendFile(transcript, claudeRecord('cd /worktrees/alpha', cwd));
        const [first, second] = await Promise.all([instance.read(session), instance.read(session)]);
        expect(second).toEqual(first);
    });

    it('answers an empty context for a Session with no Agent Terminal', async () => {
        expect(await service().read({} as SessionRecord)).toEqual({
            branches: [],
            directories: [],
            linearReferences: [],
        });
        expect(getTerminal).not.toHaveBeenCalled();
    });
});
