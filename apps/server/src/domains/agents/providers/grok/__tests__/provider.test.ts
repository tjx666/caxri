import { mkdir, mkdtemp, realpath, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { afterEach, describe, expect, it } from 'vitest';

import { grokProvider } from '../provider';

const directories: string[] = [];
afterEach(async () => {
    await Promise.all(
        directories.map((directory) => rm(directory, { recursive: true, force: true })),
    );
    directories.length = 0;
});

async function context() {
    const prefix = join(tmpdir(), 'caxri-grok-provider-');
    const directory = await realpath(await mkdtemp(prefix));
    directories.push(directory);
    return {
        args: ['--sandbox', 'workspace'],
        cwd: directory,
        environment: {
            homeDirectory: directory,
            variables: { GROK_HOME: join(directory, 'grok') },
        },
        version: 'grok 1.0.24 (68e414c661e3) [stable]',
    };
}

describe('Grok Build launch contract', () => {
    it('allocates different exact identities for simultaneous same-directory launches', async () => {
        const input = await context();
        const [first, second] = await Promise.all([
            grokProvider.prepareLaunch!(input),
            grokProvider.prepareLaunch!(input),
        ]);
        expect(first.agentSessionId).not.toBe(second.agentSessionId);
        expect(first.args).toEqual([...input.args, '--session-id', first.agentSessionId]);
        expect(
            await grokProvider.readState({ rootPath: input.cwd }, input.environment),
        ).toBeUndefined();
    });

    it('refuses an unavailable original session and resumes only its exact local identity', async () => {
        const input = await context();
        const resumeAgentSessionId = '49cc1001-2b93-4bb3-9ee8-104e8dcdd683';
        await expect(
            grokProvider.prepareLaunch!({ ...input, resumeAgentSessionId }),
        ).rejects.toThrow('unavailable locally');
        const session = join(
            input.environment.variables.GROK_HOME,
            'sessions',
            encodeURIComponent(input.cwd),
            resumeAgentSessionId,
        );
        await mkdir(session, { recursive: true });
        await writeFile(join(session, 'summary.json'), '{}');
        expect(
            (await grokProvider.prepareLaunch!({ ...input, resumeAgentSessionId })).args,
        ).toEqual([...input.args, '--resume', resumeAgentSessionId]);
    });

    it.each([
        ['--sandbox', 'off'],
        ['--sandbox=workspace', '--continue'],
        ['--sandbox', 'workspace', '--session-id=other'],
        [],
    ])('rejects unsafe launch overrides %j', async (...arguments_) => {
        await expect(
            grokProvider.prepareLaunch!({ ...(await context()), args: arguments_ }),
        ).rejects.toThrow();
    });

    it.each([undefined, 'grok 1.0.23', 'grok 2.0.0'])(
        'rejects unsupported versions %s',
        async (version) => {
            await expect(
                grokProvider.prepareLaunch!({ ...(await context()), version }),
            ).rejects.toThrow('1.0.24');
        },
    );

    it('does not advertise unverified native capabilities', () => {
        expect(grokProvider).not.toHaveProperty('renameSession');
        expect(grokProvider.actions).toBeUndefined();
        expect(grokProvider.pasteSummary).toBeUndefined();
    });
});
