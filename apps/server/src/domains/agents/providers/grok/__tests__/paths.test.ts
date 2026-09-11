import { mkdir, mkdtemp, rm, symlink, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { describe, expect, it, onTestFinished } from 'vitest';

import { locateGrokTranscript } from '../paths';

describe('Grok transcript identity', () => {
    it('derives an exact session under the percent-encoded cwd', async () => {
        const environment = { homeDirectory: '/synthetic', variables: {} };
        expect(
            await locateGrokTranscript(
                { cwd: '/code/a (b)!', agentSessionId: 'owned' },
                environment,
            ),
        ).toEqual({
            anchorRoot: '/synthetic/.grok/sessions',
            baseRoot: '/synthetic/.grok/sessions/%2Fcode%2Fa%20%28b%29%21',
            root: '/synthetic/.grok/sessions/%2Fcode%2Fa%20%28b%29%21/owned',
            path: '/synthetic/.grok/sessions/%2Fcode%2Fa%20%28b%29%21/owned/updates.jsonl',
        });
        expect(
            await locateGrokTranscript({ cwd: '/code', agentSessionId: '../other' }, environment),
        ).toBeUndefined();
    });
    it('resolves a long cwd only through its own bounded regular identity marker', async () => {
        const home = await mkdtemp(join(tmpdir(), 'caxri-grok-paths-'));
        onTestFinished(() => rm(home, { recursive: true, force: true }));
        const cwd = `/synthetic/${'a'.repeat(300)}`;
        const root = join(home, 'sessions', 'synthetic-hash');
        await mkdir(root, { recursive: true });
        const marker = join(root, '.cwd');
        const environment = { homeDirectory: home, variables: { GROK_HOME: home } };
        await writeFile(join(home, 'unrelated-marker'), cwd);
        await symlink(join(home, 'unrelated-marker'), marker);
        expect(
            await locateGrokTranscript({ cwd, agentSessionId: 'owned' }, environment),
        ).toBeUndefined();
        await rm(marker);
        await writeFile(marker, cwd);
        expect(
            (await locateGrokTranscript({ cwd, agentSessionId: 'owned' }, environment))?.root,
        ).toBe(join(root, 'owned'));
    });
});
