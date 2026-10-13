import { mkdir, mkdtemp, realpath, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { describe, expect, it, onTestFinished } from 'vitest';

import type { AgentEnvironment } from '../contract';
import { discoverTranscripts, readTranscriptCwd } from '../transcript-discovery';

const CLAUDE_ID = '0b6a1f8e-2c3d-4e5f-8a9b-1c2d3e4f5a6b';
const CODEX_THREAD = '01a1169a-d6bd-7b81-9ad9-6a6b432c3892';
const CODEX_ROLLOUT = '01a116e5-7f6d-74a0-bbd8-058d7b37babc';
const GROK_ID = '01a07714-ad3d-78f0-938c-ba32d7214c97';

async function write(path: string, content: string) {
    await mkdir(join(path, '..'), { recursive: true });
    await writeFile(path, content);
}

async function home(): Promise<AgentEnvironment> {
    const temporary = await mkdtemp(join(tmpdir(), 'caxri-transcript-discovery-'));
    const directory = await realpath(temporary);
    onTestFinished(() => rm(directory, { recursive: true, force: true }));
    return { homeDirectory: directory, variables: {} };
}

describe('discoverTranscripts', () => {
    it('finds every provider layout and marks a reverted Codex rollout as a continuation', async () => {
        const environment = await home();
        const root = environment.homeDirectory;
        await write(join(root, '.claude/projects/-work-widgets', `${CLAUDE_ID}.jsonl`), '');
        // Subagent side files belong to their main transcript, not to a conversation of their own.
        await write(
            join(root, '.claude/projects/-work-widgets', CLAUDE_ID, 'subagents/agent-1.jsonl'),
            '',
        );
        await write(join(root, '.claude/projects/-work-widgets/notes.txt'), '');
        const day = join(root, '.codex/sessions/2026/10/07');
        await write(join(day, `rollout-2026-10-07T21-43-28-${CODEX_THREAD}.jsonl`), '');
        await write(
            join(day, `rollout-2026-10-07T23-05-01-${CODEX_THREAD}_${CODEX_ROLLOUT}.jsonl`),
            '',
        );
        await write(join(root, '.grok/sessions/%2Fwork%2Fwidgets', GROK_ID, 'updates.jsonl'), '');

        const found = await discoverTranscripts(environment);

        expect(
            found
                .map(({ provider, transcriptId, agentSessionId, cwd, isContinuation }) => ({
                    provider,
                    transcriptId,
                    agentSessionId,
                    cwd,
                    isContinuation,
                }))
                .toSorted((a, b) => a.transcriptId.localeCompare(b.transcriptId)),
        ).toEqual([
            {
                provider: 'grok',
                transcriptId: GROK_ID,
                agentSessionId: GROK_ID,
                cwd: '/work/widgets',
                isContinuation: false,
            },
            {
                provider: 'codex',
                transcriptId: CODEX_THREAD,
                agentSessionId: CODEX_THREAD,
                cwd: undefined,
                isContinuation: false,
            },
            {
                provider: 'codex',
                transcriptId: CODEX_ROLLOUT,
                agentSessionId: CODEX_THREAD,
                cwd: undefined,
                isContinuation: true,
            },
            {
                provider: 'claude',
                transcriptId: CLAUDE_ID,
                agentSessionId: CLAUDE_ID,
                cwd: undefined,
                isContinuation: false,
            },
        ]);
    });

    it('reads the recorded working directory but not an escaped one inside content', async () => {
        const environment = await home();
        const root = join(environment.homeDirectory, '.claude/projects');
        const directory = join(root, '-work');
        const path = join(directory, `${CLAUDE_ID}.jsonl`);
        await write(
            path,
            `${JSON.stringify({ type: 'summary', text: '"cwd":"/elsewhere"' })}\n${JSON.stringify({ type: 'user', cwd: '/work/café' })}\n`,
        );

        expect(await readTranscriptCwd({ baseRoot: root, root: directory, path })).toBe(
            '/work/café',
        );
    });
});
