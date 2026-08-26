import { link, mkdir, mkdtemp, rm, symlink, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import type { TerminalRecord } from '@caxri/protocol';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import type { CaxriDatabase } from '../../db';
import { agentProviders } from '../providers';
import { MAX_AGENT_TRANSCRIPT_BYTES, readAgentTranscript } from '../transcript';

function databaseWith(terminal: Partial<TerminalRecord> | undefined): CaxriDatabase {
    return { getTerminal: () => terminal } as unknown as CaxriDatabase;
}

describe('claude transcript path derivation', () => {
    it('derives the project transcript path from config directory, cwd, and session', () => {
        const path = agentProviders.claude.transcriptPath?.(
            { agentSessionId: 'abc-123', cwd: '/Users/dev/code/my_app' },
            { homeDirectory: '/Users/dev', variables: {} },
        );
        expect(path).toBe('/Users/dev/.claude/projects/-Users-dev-code-my-app/abc-123.jsonl');
    });

    it('honors CLAUDE_CONFIG_DIR over the home default', () => {
        const path = agentProviders.claude.transcriptPath?.(
            { agentSessionId: 's1', cwd: '/w' },
            { homeDirectory: '/Users/dev', variables: { CLAUDE_CONFIG_DIR: '/custom/claude' } },
        );
        expect(path).toBe('/custom/claude/projects/-w/s1.jsonl');
    });
});

describe('readAgentTranscript', () => {
    let home: string;
    let cwd: string;

    beforeEach(async () => {
        home = await mkdtemp(join(tmpdir(), 'caxri-transcript-'));
        cwd = join(home, 'project');
    });

    afterEach(async () => {
        await rm(home, { force: true, recursive: true });
    });

    function environment() {
        return { homeDirectory: home, variables: {} };
    }

    function agentTerminal(agentSessionId?: string): Partial<TerminalRecord> {
        return { id: 't1', provider: 'claude', agentSessionId, cwd };
    }

    async function writeTranscript(agentSessionId: string, content: string): Promise<string> {
        const encodedCwd = cwd.replaceAll(/[^a-z0-9]/gi, '-');
        const directory = join(home, '.claude', 'projects', encodedCwd);
        await mkdir(directory, { recursive: true });
        const path = join(directory, `${agentSessionId}.jsonl`);
        await writeFile(path, content);
        return path;
    }

    it('returns null for a terminal without a bound agent session', async () => {
        const unbound = databaseWith(agentTerminal(undefined));
        const missing = databaseWith(undefined);
        await expect(readAgentTranscript(unbound, 't1', true, environment())).resolves.toBeNull();
        await expect(
            readAgentTranscript(missing, 'missing', true, environment()),
        ).resolves.toBeNull();
    });

    it('rejects a provider session identifier that contains path segments', async () => {
        const transcript = await readAgentTranscript(
            databaseWith(agentTerminal('../../outside')),
            't1',
            true,
            environment(),
        );

        expect(transcript).toBeNull();
    });

    it('rejects a transcript symlink that leaves the canonical provider root', async () => {
        const outside = join(home, 'secret.jsonl');
        await writeFile(outside, '{"secret":true}\n');
        const encodedCwd = cwd.replaceAll(/[^a-z0-9]/gi, '-');
        const directory = join(home, '.claude', 'projects', encodedCwd);
        await mkdir(directory, { recursive: true });
        await symlink(outside, join(directory, 'linked.jsonl'), 'file');

        const transcript = await readAgentTranscript(
            databaseWith(agentTerminal('linked')),
            't1',
            true,
            environment(),
        );

        expect(transcript).toBeNull();
    });

    it('rejects a transcript hardlink to another file', async () => {
        const outside = join(home, 'secret.jsonl');
        await writeFile(outside, '{"secret":true}\n');
        const encodedCwd = cwd.replaceAll(/[^a-z0-9]/gi, '-');
        const directory = join(home, '.claude', 'projects', encodedCwd);
        await mkdir(directory, { recursive: true });
        await link(outside, join(directory, 'linked.jsonl'));

        const transcript = await readAgentTranscript(
            databaseWith(agentTerminal('linked')),
            't1',
            true,
            environment(),
        );

        expect(transcript).toBeNull();
    });

    it('rejects a symlinked per-Project transcript root', async () => {
        const encodedCwd = cwd.replaceAll(/[^a-z0-9]/gi, '-');
        const baseRoot = join(home, '.claude', 'projects');
        const outsideRoot = join(home, 'outside-root');
        await mkdir(baseRoot, { recursive: true });
        await mkdir(outsideRoot);
        await writeFile(join(outsideRoot, 'linked.jsonl'), '{"secret":true}\n');
        await symlink(outsideRoot, join(baseRoot, encodedCwd), 'dir');

        const transcript = await readAgentTranscript(
            databaseWith(agentTerminal('linked')),
            't1',
            true,
            environment(),
        );

        expect(transcript).toBeNull();
    });

    it('reports the derived path without content when content is not requested', async () => {
        const path = await writeTranscript('s1', '{"a":1}\n');
        const transcript = await readAgentTranscript(
            databaseWith(agentTerminal('s1')),
            't1',
            false,
            environment(),
        );
        expect(transcript).toEqual({ path, exists: true, truncated: false });
    });

    it('marks a missing transcript file as absent instead of failing', async () => {
        const transcript = await readAgentTranscript(
            databaseWith(agentTerminal('nope')),
            't1',
            true,
            environment(),
        );
        expect(transcript?.exists).toBe(false);
        expect(transcript?.content).toBeUndefined();
    });

    it('reads full content for a transcript under the cap', async () => {
        const content = '{"type":"user"}\n{"type":"assistant"}\n';
        await writeTranscript('s1', content);
        const transcript = await readAgentTranscript(
            databaseWith(agentTerminal('s1')),
            't1',
            true,
            environment(),
        );
        expect(transcript).toMatchObject({ content, exists: true, truncated: false });
    });

    it('keeps the newest complete lines when the transcript exceeds the cap', async () => {
        const line = `{"pad":"${'x'.repeat(1024)}"}\n`;
        const lineCount = Math.ceil(MAX_AGENT_TRANSCRIPT_BYTES / line.length) + 8;
        await writeTranscript('s1', line.repeat(lineCount));
        const transcript = await readAgentTranscript(
            databaseWith(agentTerminal('s1')),
            't1',
            true,
            environment(),
        );
        expect(transcript?.truncated).toBe(true);
        expect(transcript?.content?.length).toBeLessThanOrEqual(MAX_AGENT_TRANSCRIPT_BYTES);
        // The partial first record of the tail window is dropped so only whole lines remain.
        expect(transcript?.content?.startsWith('{"pad":"x')).toBe(true);
        expect(transcript?.content?.endsWith(line)).toBe(true);
        expect((transcript?.content?.length ?? 0) % line.length).toBe(0);
    });
});
