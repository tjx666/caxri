import type { ChildProcess } from 'node:child_process';
import { spawn } from 'node:child_process';
import { once } from 'node:events';
import { mkdir, mkdtemp, realpath, rm, utimes, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { basename, dirname, join } from 'node:path';
import process from 'node:process';

import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import type { AgentEnvironment } from '../../../contract';
import { listExternalConversations } from '../../../external-conversations';
import { probeOpenCodexSessionIds } from '../open-sessions';

const PROJECT = '/workspace/demo-app';
const OPEN_THREAD = '01990000-0000-7000-8000-00000000000a';
const CLOSED_THREAD = '01990000-0000-7000-8000-00000000000b';
const TEN_MINUTES = 10 * 60_000;

/**
 * Npm-installed Codex runs as `node <dir>/codex.js`, which the process detector unwraps; a script with that basename is
 * therefore a faithful stand-in for a Codex CLI that keeps its rollout open while idle at the prompt.
 */
const FAKE_CODEX = String.raw`
const { openSync } = require('node:fs');
openSync(process.argv[2], 'a');
process.stdout.write('ready\n');
setInterval(() => {}, 1 << 30);
`;

const canRunFakeCodex =
    (process.platform === 'darwin' || process.platform === 'linux') &&
    ['node', 'nodejs', 'bun'].includes(basename(process.execPath));

describe('probeOpenCodexSessionIds', () => {
    let home: string;
    let environment: AgentEnvironment;
    let fakeCodex: ChildProcess | undefined;

    beforeEach(async () => {
        const created = await mkdtemp(join(tmpdir(), 'caxri-codex-open-'));
        home = await realpath(created);
        environment = { homeDirectory: home, variables: {} };
    });

    afterEach(async () => {
        if (fakeCodex?.exitCode === null) {
            fakeCodex.kill('SIGKILL');
            await once(fakeCodex, 'exit');
        }
        fakeCodex = undefined;
        await rm(home, { force: true, recursive: true });
    });

    function rolloutPath(threadId: string): string {
        return join(
            home,
            '.codex/sessions/2026/04/20',
            `rollout-2026-04-20T09-00-00-${threadId}.jsonl`,
        );
    }

    async function writeRollout(threadId: string, updatedAt: number): Promise<string> {
        const path = rolloutPath(threadId);
        await mkdir(dirname(path), { recursive: true });
        const records = [
            {
                type: 'session_meta',
                payload: { id: threadId, cwd: PROJECT, source: 'cli', originator: 'codex_cli_rs' },
            },
            {
                type: 'response_item',
                payload: {
                    type: 'message',
                    role: 'user',
                    content: [{ type: 'input_text', text: `Prompt ${threadId.slice(-1)}` }],
                },
            },
        ];
        await writeFile(path, `${records.map((record) => JSON.stringify(record)).join('\n')}\n`);
        await utimes(path, updatedAt / 1000, updatedAt / 1000);
        return path;
    }

    async function startFakeCodex(rollout: string): Promise<void> {
        const script = join(home, 'bin/codex.js');
        await mkdir(dirname(script), { recursive: true });
        await writeFile(script, FAKE_CODEX);
        const child = spawn(process.execPath, [script, rollout], {
            stdio: ['ignore', 'pipe', 'ignore'],
        });
        fakeCodex = child;
        await once(child.stdout, 'data');
    }

    it.skipIf(!canRunFakeCodex)(
        'marks an idle Codex conversation another process holds open as possibly open',
        async () => {
            const now = Date.now();
            const open = await writeRollout(OPEN_THREAD, now - TEN_MINUTES);
            await writeRollout(CLOSED_THREAD, now - TEN_MINUTES);
            await startFakeCodex(open);

            const probe = await probeOpenCodexSessionIds(environment);
            expect(probe).toEqual({ ok: true, sessionIds: new Set([OPEN_THREAD]) });

            const conversations = await listExternalConversations({
                environment,
                excludeProviderSessionIds: new Set(),
                now,
                openCodexSessionIds: async () => {
                    const result = await probeOpenCodexSessionIds(environment);
                    return result.ok ? result.sessionIds : undefined;
                },
            });
            expect(
                conversations.map(({ providerSessionId, mayBeOpen }) => ({
                    providerSessionId,
                    mayBeOpen,
                })),
            ).toEqual(
                expect.arrayContaining([
                    { providerSessionId: OPEN_THREAD, mayBeOpen: true },
                    { providerSessionId: CLOSED_THREAD, mayBeOpen: false },
                ]),
            );
        },
    );

    it('keeps only writable rollouts under the canonical sessions root', async () => {
        const now = Date.now();
        const open = await writeRollout(OPEN_THREAD, now);
        const readOnly = await writeRollout(CLOSED_THREAD, now);
        const foreign = join(home, 'elsewhere', basename(open));
        await mkdir(dirname(foreign), { recursive: true });
        await writeFile(foreign, '');

        await expect(
            probeOpenCodexSessionIds(environment, () =>
                Promise.resolve({
                    ok: true,
                    files: [
                        { access: 'w', path: open, pid: 10 },
                        { access: 'r', path: readOnly, pid: 10 },
                        { access: 'u', path: foreign, pid: 11 },
                        { access: 'w', path: join(home, '.codex/sessions/missing.jsonl'), pid: 11 },
                    ],
                }),
            ),
        ).resolves.toEqual({ ok: true, sessionIds: new Set([OPEN_THREAD]) });
    });

    it('reports a closed reason when the open-file query fails', async () => {
        await writeRollout(OPEN_THREAD, Date.now());
        await expect(
            probeOpenCodexSessionIds(environment, () =>
                Promise.resolve({ ok: false, reason: 'open_file_query_failed' }),
            ),
        ).resolves.toEqual({ ok: false, reason: 'open_file_query_failed' });
    });

    it('reports a missing sessions root without querying processes', async () => {
        let isQueried = false;
        await expect(
            probeOpenCodexSessionIds(environment, () => {
                isQueried = true;
                return Promise.resolve({ ok: true, files: [] });
            }),
        ).resolves.toEqual({ ok: false, reason: 'sessions_root_missing' });
        expect(isQueried).toBe(false);
    });

    it('falls back to the transcript recency heuristic when the probe cannot answer', async () => {
        const now = Date.now();
        await writeRollout(OPEN_THREAD, now - 30_000);
        await writeRollout(CLOSED_THREAD, now - TEN_MINUTES);

        const conversations = await listExternalConversations({
            environment,
            excludeProviderSessionIds: new Set(),
            now,
            openCodexSessionIds: () => Promise.resolve(undefined),
        });
        expect(
            conversations.map(({ providerSessionId, mayBeOpen }) => ({
                providerSessionId,
                mayBeOpen,
            })),
        ).toEqual([
            { providerSessionId: OPEN_THREAD, mayBeOpen: true },
            { providerSessionId: CLOSED_THREAD, mayBeOpen: false },
        ]);
    });
});
