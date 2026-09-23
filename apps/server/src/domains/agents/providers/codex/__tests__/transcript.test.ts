import * as filesystem from 'node:fs/promises';
import { mkdir, mkdtemp, realpath, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { resolveSafeAgentTranscriptPath } from '../../../transcript-security';
import { codexProvider } from '..';
import { locateCodexTranscript } from '../transcript';

vi.mock('node:fs/promises', async (importOriginal) => {
    const actual = await importOriginal<typeof filesystem>();
    return { ...actual, opendir: vi.fn(actual.opendir) };
});

/**
 * UUIDv7 whose leading 48 bits encode 2026-05-27T03:14:51.840Z.
 */
const THREAD_ID = '019e676d-8740-7bb2-8bcb-f189c8260607';
const THREAD_CREATED_AT = 0x019e676d8740;

function localDaySegments(time: number, dayOffset = 0): [string, string, string] {
    const day = new Date(time);
    day.setDate(day.getDate() + dayOffset);
    return [
        String(day.getFullYear()),
        String(day.getMonth() + 1).padStart(2, '0'),
        String(day.getDate()).padStart(2, '0'),
    ];
}

describe('locateCodexTranscript', () => {
    it('refuses a canceled lookup before directory traversal', async () => {
        const controller = new AbortController();
        controller.abort();
        await expect(
            locateCodexTranscript(
                { agentSessionId: THREAD_ID },
                { homeDirectory: '/synthetic', variables: {} },
                controller.signal,
            ),
        ).rejects.toMatchObject({ name: 'AbortError' });
    });

    let home: string;

    beforeEach(async () => {
        vi.mocked(filesystem.opendir).mockReset();
        home = await mkdtemp(join(tmpdir(), 'caxri-codex-transcript-'));
    });

    afterEach(async () => {
        vi.restoreAllMocks();
        await rm(home, { force: true, recursive: true });
    });

    it('retains canceled lookups until every directory operation settles', async () => {
        const pending = Array.from({ length: 3 }, () => Promise.withResolvers<never>());
        let calls = 0;
        vi.spyOn(filesystem, 'opendir').mockImplementation(() => pending[calls++].promise);
        const controller = new AbortController();
        let isSettled = false;
        const lookup = locateCodexTranscript(
            { agentSessionId: THREAD_ID },
            environment(),
            controller.signal,
        );
        const completion = (async () => {
            try {
                await lookup;
            } catch {
                // The cancellation rejection is asserted after all handles settle.
            } finally {
                isSettled = true;
            }
        })();
        controller.abort();
        pending[0].reject(controller.signal.reason);
        try {
            await new Promise<void>((resolve) => setImmediate(resolve));
            expect(isSettled).toBe(false);
        } finally {
            for (const operation of pending) operation.reject(controller.signal.reason);
            await completion;
        }
        await expect(lookup).rejects.toMatchObject({ name: 'AbortError' });
    });

    function environment() {
        return { homeDirectory: home, variables: {} };
    }

    async function writeRollout(
        segments: readonly string[],
        name: string,
    ): Promise<{ directory: string; path: string }> {
        const directory = join(home, '.codex', 'sessions', ...segments);
        await mkdir(directory, { recursive: true });
        const path = join(directory, name);
        await writeFile(path, '');
        return { directory, path };
    }

    it('finds the rollout in the day folder named by the thread id timestamp', async () => {
        const [year, month, day] = localDaySegments(THREAD_CREATED_AT);
        // The wall-clock part differs from the id by a second and is never used for matching.
        const { directory, path } = await writeRollout(
            [year, month, day],
            `rollout-${year}-${month}-${day}T11-14-52-${THREAD_ID}.jsonl`,
        );
        await writeRollout(
            [year, month, day],
            `rollout-${year}-${month}-${day}T11-14-52-019e676d-8740-7bb2-8bcb-f189c8260608.jsonl`,
        );

        const location = await locateCodexTranscript({ agentSessionId: THREAD_ID }, environment());

        const sessionsRoot = join(home, '.codex', 'sessions');
        expect(location).toEqual({
            anchorRoot: sessionsRoot,
            baseRoot: join(sessionsRoot, year, month),
            path,
            root: directory,
        });
        // macOS temp roots are symlinked (`/var` -> `/private/var`); the security layer reports canonical paths.
        expect(await resolveSafeAgentTranscriptPath(location!)).toEqual({
            exists: true,
            path: await realpath(path),
            root: await realpath(directory),
        });
    });

    it('checks the neighbouring day folders for a rollout written across midnight', async () => {
        const segments = localDaySegments(THREAD_CREATED_AT, 1);
        const { path } = await writeRollout(
            segments,
            `rollout-${segments.join('-')}T00-00-00-${THREAD_ID}.jsonl`,
        );

        const location = await locateCodexTranscript({ agentSessionId: THREAD_ID }, environment());
        expect(location?.path).toBe(path);
    });

    it('rejects ids that are not UUIDv7 threads and rollouts with a foreign name shape', async () => {
        const [year, month, day] = localDaySegments(THREAD_CREATED_AT);
        await writeRollout([year, month, day], `notes-${THREAD_ID}.jsonl`);

        expect(await locateCodexTranscript({ agentSessionId: THREAD_ID }, environment())).toBe(
            undefined,
        );
        expect(await locateCodexTranscript({ agentSessionId: 'thread-1' }, environment())).toBe(
            undefined,
        );
        expect(
            await locateCodexTranscript(
                { agentSessionId: '6ba7b810-9dad-41d1-80b4-00c04fd430c8' },
                environment(),
            ),
        ).toBe(undefined);
    });

    it('honors CODEX_HOME over the home default', async () => {
        const codexHome = join(home, 'custom-codex');
        const [year, month, day] = localDaySegments(THREAD_CREATED_AT);
        const directory = join(codexHome, 'sessions', year, month, day);
        await mkdir(directory, { recursive: true });
        const path = join(directory, `rollout-${year}-${month}-${day}T11-14-51-${THREAD_ID}.jsonl`);
        await writeFile(path, '');

        const location = await codexProvider.locateTranscript?.(
            { agentSessionId: THREAD_ID, cwd: '/w' },
            { homeDirectory: home, variables: { CODEX_HOME: codexHome } },
        );
        expect(location?.path).toBe(path);
        expect(location?.anchorRoot).toBe(join(codexHome, 'sessions'));
    });
});
