import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { afterEach, describe, expect, it } from 'vitest';

import type { AgentEnvironment } from '../../../contract';
import { readCodexAuthMode } from '../cache-auth';

const directories: string[] = [];

afterEach(async () => {
    await Promise.all(directories.map((d) => rm(d, { recursive: true, force: true })));
    directories.length = 0;
});

async function codexHome(): Promise<{ home: string; environment: AgentEnvironment }> {
    const home = await mkdtemp(join(tmpdir(), 'caxri-cache-auth-'));
    directories.push(home);
    return {
        home,
        environment: {
            homeDirectory: home,
            variables: { CODEX_HOME: home },
        } as unknown as AgentEnvironment,
    };
}

describe('readCodexAuthMode', () => {
    it('reads auth_mode from a regular auth.json', async () => {
        const { home, environment } = await codexHome();
        await writeFile(join(home, 'auth.json'), JSON.stringify({ auth_mode: 'chatgpt' }));
        await expect(readCodexAuthMode(environment)).resolves.toBe('chatgpt');
    });

    it('reports no mode for an oversized auth.json instead of parsing it', async () => {
        const { home, environment } = await codexHome();
        await writeFile(
            join(home, 'auth.json'),
            JSON.stringify({ auth_mode: 'chatgpt', padding: 'x'.repeat(256 * 1024) }),
        );
        await expect(readCodexAuthMode(environment)).resolves.toBeUndefined();
    });

    it('reports no mode when auth.json is not a regular file', async () => {
        const { home, environment } = await codexHome();
        await mkdir(join(home, 'auth.json'));
        await expect(readCodexAuthMode(environment)).resolves.toBeUndefined();
    });
});
