import { chmod, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import process from 'node:process';

import { describe, expect, it, onTestFinished } from 'vitest';

import { fakeClaudeChatExecutableSource } from '../../agent-chat/__tests__/fixtures/fake-chat-executables';
import { openSdkSession } from '../probe';

/**
 * The keeper's Claude process through the real Agent SDK against the fake Claude Code CLI, whose `claude-window.json`
 * account starts a 5-hour window when a request arrives while it is idle.
 */
async function fixture(
    account: Record<string, unknown>,
    extraEnvironment: Record<string, string> = {},
) {
    const directory = await mkdtemp(join(tmpdir(), 'caxri-claude-window-sdk-'));
    onTestFinished(() => rm(directory, { recursive: true, force: true }));
    const executable = join(directory, 'claude');
    await writeFile(executable, fakeClaudeChatExecutableSource({ controlDirectory: directory }));
    await chmod(executable, 0o755);
    const accountFile = join(directory, 'claude-window.json');
    await writeFile(accountFile, JSON.stringify(account));
    const environment = {
        PATH: process.env.PATH,
        HOME: directory,
        CLAUDE_CONFIG_DIR: join(directory, 'config'),
        ...extraEnvironment,
    };
    const session = await openSdkSession({ executable, environment, clientVersion: 'test' });
    onTestFinished(() => session.close());
    return {
        session,
        account: async () =>
            JSON.parse(await readFile(accountFile, 'utf8')) as {
                requests?: number;
                resetsAt?: number;
            },
    };
}

const PRO = { plan: 'pro', email: 'person@example.com', organization: 'Example' };

describe('openSdkSession', () => {
    it('reads an idle Pro window, starts it with one request, and reads the new reset', async () => {
        const test = await fixture(PRO);
        const before = await test.session.read();
        expect(before).toEqual({
            ok: true,
            reading: {
                identity: expect.stringMatching(/^[0-9a-f]{64}$/) as string,
                planType: 'pro',
                isWeeklyLimitReached: false,
            },
        });
        expect(await test.session.trigger()).toBe(true);
        const after = await test.session.read();
        expect(after.ok && after.reading.windowResetsAt).toBeGreaterThan(
            Date.now() + 4 * 3_600_000,
        );
        expect((await test.account()).requests).toBe(1);
    }, 30_000);

    it('fails closed for an environment that would bill an API key, and sends nothing', async () => {
        const test = await fixture(PRO, { ANTHROPIC_API_KEY: 'x' });
        expect(await test.session.read()).toEqual({ ok: false, reason: 'authUnsupported' });
        expect((await test.account()).requests).toBeUndefined();
    }, 30_000);

    it('fails closed for a plan it cannot confirm', async () => {
        const test = await fixture({ ...PRO, plan: 'team' });
        expect(await test.session.read()).toEqual({ ok: false, reason: 'planUnsupported' });
    }, 30_000);
});
