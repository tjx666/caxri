import { mkdir, mkdtemp, realpath, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { setTimeout as delay } from 'node:timers/promises';

import type { StructuredLogger } from '@caxri/system';
import { describe, expect, it, onTestFinished, vi } from 'vitest';

import { agentProviders } from '../../agents';
import { CaxriDatabase } from '../../db';
import { UsageService } from '../service';

const T0 = Date.parse('2026-03-01T10:00:00.000Z');

function claudeLine(id: string, output: number) {
    return `${JSON.stringify({
        type: 'assistant',
        timestamp: new Date(T0).toISOString(),
        requestId: `request-${id}`,
        message: { id, model: 'claude-x', usage: { output_tokens: output } },
    })}\n`;
}

async function setup() {
    const temporary = await mkdtemp(join(tmpdir(), 'caxri-usage-service-'));
    const directory = await realpath(temporary);
    onTestFinished(() => rm(directory, { recursive: true, force: true }));
    const projectRoot = join(directory, 'project');
    await mkdir(projectRoot);
    const environment = { homeDirectory: join(directory, 'home'), variables: {} };
    const database = new CaxriDatabase(join(directory, 'state.db'));
    onTestFinished(() => database.close());
    const project = database.createProject(projectRoot);
    const service = new UsageService({
        database,
        environment,
        logger: { write: vi.fn() } as unknown as StructuredLogger,
        runner: vi.fn(),
        userDataPath: directory,
        fetch: () => Promise.resolve(new Response('offline', { status: 503 })),
        now: () => T0 + 60_000,
    });
    const writeTranscript = async (agentSessionId: string, content: string) => {
        const path = agentProviders.claude.transcriptPath!(
            { agentSessionId, cwd: projectRoot },
            environment,
        );
        await mkdir(dirname(path), { recursive: true });
        await writeFile(path, content);
    };
    const bind = (agentSessionId: string) => {
        const { terminal } = database.createSession(project.id, 'claude');
        database.rebindAgentSession(terminal!.id, 'claude', agentSessionId);
    };
    const writeOutsideTranscript = async (agentSessionId: string, content: string) => {
        const path = join(
            environment.homeDirectory,
            '.claude/projects/outside',
            `${agentSessionId}.jsonl`,
        );
        await mkdir(dirname(path), { recursive: true });
        await writeFile(path, content);
    };
    return { service, writeTranscript, writeOutsideTranscript, bind };
}

describe('UsageService', () => {
    /**
     * `claude --resume <id> --fork-session` copies every earlier record, IDs unchanged, into the new conversation's
     * file. Counting both files billed the shared history twice.
     */
    it('counts a message copied into a forked conversation once', async () => {
        const { service, writeTranscript, bind } = await setup();
        const source = '0b6a1f8e-2c3d-4e5f-8a9b-1c2d3e4f5a6b';
        const fork = '1b6a1f8e-2c3d-4e5f-8a9b-1c2d3e4f5a6b';
        await writeTranscript(source, claudeLine('m1', 100));
        // The fork's file is created after its source, which is how the source keeps the copied message.
        await delay(20);
        await writeTranscript(fork, claudeLine('m1', 100) + claudeLine('m2', 50));
        // Binding the fork first makes the first pass scan the copy before its source.
        bind(fork);
        bind(source);

        const report = await service.report({ timeZone: 'UTC', range: 'all', scope: 'caxri' });

        expect(report.totals.tokens.output).toBe(150);
        expect(report.coverage.pendingScans).toBe(0);
    });

    /**
     * A resync finds nearly every transcript unchanged; counting those as pending flashed "Reading 8,000 more
     * transcripts" on the Usage page for the seconds the fingerprint checks took.
     */
    it('counts only changed transcripts as pending when the outside scan resyncs', async () => {
        const { service, writeOutsideTranscript } = await setup();
        const ids = ['2b6a1f8e', '3b6a1f8e', '4b6a1f8e'].map(
            (prefix) => `${prefix}-2c3d-4e5f-8a9b-1c2d3e4f5a6b`,
        );
        await Promise.all(
            ids.map((id, index) => writeOutsideTranscript(id, claudeLine(`m${index}`, 10))),
        );
        const pending: number[] = [];
        let value = 0;
        Object.defineProperty(service, 'outsidePendingScans', {
            get: () => value,
            set: (next: number) => {
                value = next;
                pending.push(next);
            },
        });
        const sync = () => (service as unknown as { syncOutside(): Promise<void> }).syncOutside();

        await sync();
        expect(Math.max(...pending)).toBe(3);

        pending.length = 0;
        await delay(20);
        await writeOutsideTranscript(ids[1], claudeLine('m1', 10) + claudeLine('m9', 5));
        await sync();
        expect(Math.max(...pending)).toBe(1);
        expect(pending.at(-1)).toBe(0);
    });
});
