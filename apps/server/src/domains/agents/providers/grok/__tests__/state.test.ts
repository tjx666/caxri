import { mkdir, mkdtemp, realpath, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import process from 'node:process';

import { execFileAsync } from '@caxri/system';
import { afterEach, describe, expect, it } from 'vitest';

import type { AgentEnvironment } from '../../../contract';
import { encodeGrokCwdDirname } from '../paths';
import { grokProvider } from '../provider';

const AGENT_SESSION_ID = '49cc1001-2b93-4bb3-9ee8-104e8dcdd683';
const OTHER_AGENT_SESSION_ID = 'f1a3a5f7-9f19-4f0c-bd0c-64be6cf9a3d4';

const directories: string[] = [];

afterEach(async () => {
    await Promise.all(
        directories.map((directory) => rm(directory, { recursive: true, force: true })),
    );
    directories.length = 0;
});

interface Workspace {
    cwd: string;
    environment: AgentEnvironment;
}

async function workspace(): Promise<Workspace> {
    const prefix = join(tmpdir(), 'caxri-grok-state-');
    const directory = await realpath(await mkdtemp(prefix));
    directories.push(directory);
    return {
        cwd: directory,
        environment: {
            homeDirectory: directory,
            variables: { GROK_HOME: join(directory, 'grok') },
        },
    };
}

async function writeSummary(
    { cwd, environment }: Workspace,
    agentSessionId: string,
    summary: string,
    layout: 'encoded' | 'hashed' = 'encoded',
): Promise<void> {
    const project = join(
        environment.variables.GROK_HOME!,
        'sessions',
        layout === 'hashed' ? 'hashed-project' : encodeGrokCwdDirname(cwd),
    );
    const session = join(project, agentSessionId);
    await mkdir(session, { recursive: true });
    if (layout === 'hashed') await writeFile(join(project, '.cwd'), cwd);
    await writeFile(join(session, 'summary.json'), summary);
}

function readState(
    { cwd, environment }: Workspace,
    agentSessionId?: string,
): ReturnType<typeof grokProvider.readState> {
    return grokProvider.readState({ agentSessionId, rootPath: cwd }, environment);
}

describe('Grok Build conversation title', () => {
    it('publishes the generated title of the exact bound session', async () => {
        const target = await workspace();
        await writeSummary(
            target,
            AGENT_SESSION_ID,
            JSON.stringify({
                generated_title: 'Production builds failing on missing shims',
                session_summary: 'Production builds failing on missing shims',
            }),
        );
        await writeSummary(
            target,
            OTHER_AGENT_SESSION_ID,
            JSON.stringify({ generated_title: 'Unrelated same-directory conversation' }),
        );
        expect(await readState(target, AGENT_SESSION_ID)).toEqual({
            title: 'Production builds failing on missing shims',
            titleSource: 'automatic',
        });
    });

    it('reports the refreshed title on the next probe', async () => {
        const target = await workspace();
        await writeSummary(
            target,
            AGENT_SESSION_ID,
            JSON.stringify({ generated_title: 'First turn title' }),
        );
        expect(await readState(target, AGENT_SESSION_ID)).toMatchObject({
            title: 'First turn title',
        });
        await writeSummary(
            target,
            AGENT_SESSION_ID,
            JSON.stringify({ generated_title: 'Refreshed title' }),
        );
        expect(await readState(target, AGENT_SESSION_ID)).toMatchObject({
            title: 'Refreshed title',
        });
    });

    it('never claims identity or activity the hooks own', async () => {
        const target = await workspace();
        await writeSummary(
            target,
            AGENT_SESSION_ID,
            JSON.stringify({
                generated_title: 'Hook-owned identity stays untouched',
                status: 'busy',
            }),
        );
        const state = await readState(target, AGENT_SESSION_ID);
        expect(state).not.toHaveProperty('sessionId');
        expect(state).not.toHaveProperty('status');
    });

    it('reads nothing for an unbound Terminal even when a conversation exists', async () => {
        const target = await workspace();
        await writeSummary(
            target,
            AGENT_SESSION_ID,
            JSON.stringify({ generated_title: 'Only a hook may bind this conversation' }),
        );
        expect(await readState(target)).toBeUndefined();
    });

    it.each([
        ['a missing conversation', undefined],
        ['an absent title', JSON.stringify({ session_summary: 'Summary without a title' })],
        ['an empty title', JSON.stringify({ generated_title: ' '.repeat(3) })],
        ['a non-string title', JSON.stringify({ generated_title: { text: 'Title' } })],
        ['a multi-line title', JSON.stringify({ generated_title: 'First line\nSecond line' })],
        ['an oversized title', JSON.stringify({ generated_title: 'T'.repeat(201) })],
        ['malformed JSON', '{"generated_title": "Half-written'],
        ['a non-object record', '"Production builds failing"'],
        ['an oversized record', `{"generated_title": "Title", "pad": "${'p'.repeat(64 * 1024)}"}`],
    ])('keeps the current title for %s', async (_case, summary) => {
        const target = await workspace();
        if (summary !== undefined) await writeSummary(target, AGENT_SESSION_ID, summary);
        expect(await readState(target, AGENT_SESSION_ID)).toBeUndefined();
    });

    it.each(['special', 'long'] as const)(
        'publishes the generated title for the exact %s cwd layout',
        async (kind) => {
            const target = await workspace();
            const cwd = join(
                target.cwd,
                kind === 'special' ? "project!'()*" : 'segment'.repeat(30),
            );
            await mkdir(cwd);
            await writeSummary(
                { cwd, environment: target.environment },
                AGENT_SESSION_ID,
                JSON.stringify({ generated_title: `${kind} cwd title` }),
                kind === 'long' ? 'hashed' : 'encoded',
            );
            expect(
                await grokProvider.readState(
                    { agentSessionId: AGENT_SESSION_ID, rootPath: cwd },
                    target.environment,
                ),
            ).toEqual({ title: `${kind} cwd title`, titleSource: 'automatic' });
        },
    );

    /**
     * A plain read-only open of a FIFO waits for a writer, so a FIFO at `summary.json` used to park every probe of the
     * bound Terminal indefinitely. The shared bounded reader refuses it at once.
     */
    it.skipIf(process.platform === 'win32')(
        'keeps the current title without waiting when summary.json is a FIFO',
        async () => {
            const target = await workspace();
            await writeSummary(target, AGENT_SESSION_ID, '{}');
            const summaryPath = join(
                target.environment.variables.GROK_HOME!,
                'sessions',
                encodeGrokCwdDirname(target.cwd),
                AGENT_SESSION_ID,
                'summary.json',
            );
            await rm(summaryPath);
            await execFileAsync('mkfifo', [summaryPath]);

            expect(await readState(target, AGENT_SESSION_ID)).toBeUndefined();
        },
        2_000,
    );

    it('rejects an agent session id that is not an opaque basename', async () => {
        const target = await workspace();
        await writeSummary(target, AGENT_SESSION_ID, JSON.stringify({ generated_title: 'Title' }));
        const traversal = join('..', encodeURIComponent(target.cwd), AGENT_SESSION_ID);
        expect(await readState(target, traversal)).toBeUndefined();
    });
});
