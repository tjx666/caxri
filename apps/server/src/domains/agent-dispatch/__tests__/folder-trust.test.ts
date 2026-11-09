import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { logEventCatalog } from '@caxri/protocol';
import type { StructuredLogger } from '@caxri/system';
import { describe, expect, it, onTestFinished, vi } from 'vitest';

import { folderTrustPreparer } from '../folder-trust';

async function fixture(files: { claude?: string; antigravity?: string } = {}) {
    const home = await mkdtemp(join(tmpdir(), 'caxri-dispatch-trust-'));
    onTestFinished(() => rm(home, { recursive: true, force: true }));
    if (files.claude !== undefined) await writeFile(join(home, '.claude.json'), files.claude);
    if (files.antigravity !== undefined) {
        await mkdir(join(home, '.gemini', 'antigravity-cli'), { recursive: true });
        await writeFile(antigravitySettings(home), files.antigravity);
    }
    const write = vi.fn();
    const prepare = folderTrustPreparer({ homeDirectory: home, variables: {} }, {
        write,
    } as unknown as StructuredLogger);
    return { home, prepare, write };
}

function antigravitySettings(home: string): string {
    return join(home, '.gemini', 'antigravity-cli', 'settings.json');
}

describe('folderTrustPreparer', () => {
    it('trusts the working directory of a Claude Code launch and keeps the rest of the config', async () => {
        const { home, prepare, write } = await fixture({ claude: '{"numStartups":3}' });

        await prepare('claude', '/projects/new-app');

        const config: unknown = JSON.parse(await readFile(join(home, '.claude.json'), 'utf8'));
        expect(config).toEqual({
            numStartups: 3,
            projects: { '/projects/new-app': { hasTrustDialogAccepted: true } },
        });
        expect(write).toHaveBeenCalledWith(
            'debug',
            logEventCatalog.agentDispatch.folderTrustPrepared,
            { fields: { provider: 'claude', outcome: 'granted' } },
        );
    });

    it('trusts the working directory of an Antigravity launch', async () => {
        const { home, prepare, write } = await fixture({
            antigravity: '{"model":"m","trustedWorkspaces":["/projects/old"]}',
        });

        await prepare('antigravity', '/projects/new-app');

        const settings = await readFile(antigravitySettings(home), 'utf8');
        expect(JSON.parse(settings)).toEqual({
            model: 'm',
            trustedWorkspaces: ['/projects/old', '/projects/new-app'],
        });
        expect(write).toHaveBeenCalledWith(
            'debug',
            logEventCatalog.agentDispatch.folderTrustPrepared,
            { fields: { provider: 'antigravity', outcome: 'granted' } },
        );
    });

    it('leaves other providers alone', async () => {
        const { home, prepare, write } = await fixture({ claude: '{}' });

        await prepare('codex', '/projects/new-app');

        expect(await readFile(join(home, '.claude.json'), 'utf8')).toBe('{}');
        expect(write).not.toHaveBeenCalled();
    });

    it('warns when the Agent will still ask for trust', async () => {
        const { prepare, write } = await fixture();

        await prepare('claude', '/projects/new-app');
        await prepare('antigravity', '/projects/new-app');

        expect(write.mock.calls).toEqual([
            [
                'warn',
                logEventCatalog.agentDispatch.folderTrustPrepared,
                { fields: { provider: 'claude', outcome: 'missing_config' } },
            ],
            [
                'warn',
                logEventCatalog.agentDispatch.folderTrustPrepared,
                { fields: { provider: 'antigravity', outcome: 'skipped' } },
            ],
        ]);
    });
});
