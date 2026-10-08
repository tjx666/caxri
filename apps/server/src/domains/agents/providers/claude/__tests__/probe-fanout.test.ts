import type * as FsPromises from 'node:fs/promises';
import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { afterEach, describe, expect, it, vi } from 'vitest';

/**
 * The regression these tests exist for is a syscall count, not a duration: a probe that resolves every recorded working
 * directory instead of the one it asked about still finishes in single-digit milliseconds on an idle machine (issue
 * #630). `node:fs/promises` is a non-configurable ESM namespace, so a hoisted counter around the real call is the only
 * way to observe the fan-out.
 */
const counters = vi.hoisted(() => ({ realpath: 0 }));
vi.mock('node:fs/promises', async (importOriginal) => {
    const actual = await importOriginal<typeof FsPromises>();
    return {
        ...actual,
        realpath: (...arguments_: Parameters<typeof actual.realpath>) => {
            counters.realpath += 1;
            return actual.realpath(...arguments_);
        },
    };
});

import { claudeProvider } from '..';
import { clearClaudeMetadataCache } from '../metadata-cache';

const temporaryDirectories: string[] = [];

afterEach(async () => {
    clearClaudeMetadataCache();
    counters.realpath = 0;
    const pending = [...temporaryDirectories];
    temporaryDirectories.length = 0;
    await Promise.all(pending.map((path) => rm(path, { recursive: true, force: true })));
});

/**
 * Every session gets its own working directory, because `readClaudeState` memoizes `realpath` per distinct `cwd`. A
 * fixture where they all share one directory would report a flat call count even from the unbounded fan-out this is
 * meant to catch.
 */
async function createProbeFixture(sessions: number): Promise<{ config: string; root: string }> {
    const directory = await mkdtemp(join(tmpdir(), 'caxri-claude-probe-fanout-'));
    temporaryDirectories.push(directory);
    const config = join(directory, 'claude');
    const sessionsDirectory = join(config, 'sessions');
    const root = join(directory, 'root');
    await mkdir(sessionsDirectory, { recursive: true });
    await mkdir(root);
    await Promise.all(
        Array.from({ length: sessions }, async (_, index) => {
            const isMatch = index === 0;
            const cwd = isMatch ? root : join(directory, `other-${index}`);
            if (!isMatch) await mkdir(cwd);
            await writeFile(
                join(sessionsDirectory, `session-${index}.json`),
                JSON.stringify({
                    cwd,
                    sessionId: `session-${index}`,
                    startedAt: new Date(1_700_000_000_000).toISOString(),
                    status: 'idle',
                    updatedAt: new Date(1_700_000_000_000 + index).toISOString(),
                }),
                'utf8',
            );
        }),
    );
    return { config, root };
}

const environment = (config: string) => ({
    homeDirectory: config,
    variables: { CLAUDE_CONFIG_DIR: config },
});

describe('Claude probe realpath fan-out', () => {
    /**
     * Two calls: the requested Project root, and the one candidate that survived the in-memory filter. The count is the
     * assertion: that it is identical for 4 and for 40 sessions is what proves the filter runs first.
     */
    it.each([4, 40])(
        'resolves only the requested Agent session when probing %i sessions',
        async (sessions) => {
            const { config, root } = await createProbeFixture(sessions);

            const state = await claudeProvider.readState(
                { agentSessionId: 'session-0', processState: 'running', rootPath: root },
                environment(config),
            );

            expect(state?.sessionId).toBe('session-0');
            expect(counters.realpath).toBe(2);
        },
    );

    /**
     * The same guarantee for an unbound Terminal, whose filter is `excludedAgentSessionIds` rather than a named
     * session. Before the filter moved ahead of `realpath`, an excluded session still cost a path resolution.
     */
    it('skips resolving the working directory of an excluded Agent session', async () => {
        const { config, root } = await createProbeFixture(40);
        const excluded = Array.from({ length: 39 }, (_, index) => `session-${index + 1}`);

        const state = await claudeProvider.readState(
            { excludedAgentSessionIds: excluded, processState: 'running', rootPath: root },
            environment(config),
        );

        expect(state?.sessionId).toBe('session-0');
        expect(counters.realpath).toBe(2);
    });
});
