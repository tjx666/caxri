import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { logEventCatalog } from '@caxri/protocol';
import type { StructuredLogger } from '@caxri/system';
import { describe, expect, it, onTestFinished, vi } from 'vitest';

import { claudeTrustPreparer } from '../claude-trust';

async function fixture(config?: string) {
    const home = await mkdtemp(join(tmpdir(), 'caxri-dispatch-trust-'));
    onTestFinished(() => rm(home, { recursive: true, force: true }));
    if (config !== undefined) await writeFile(join(home, '.claude.json'), config);
    const write = vi.fn();
    const prepare = claudeTrustPreparer({ homeDirectory: home, variables: {} }, {
        write,
    } as unknown as StructuredLogger);
    return { home, prepare, write };
}

describe('claudeTrustPreparer', () => {
    it('trusts the working directory of a Claude Code launch and keeps the rest of the config', async () => {
        const { home, prepare, write } = await fixture('{"numStartups":3}');

        await prepare('claude', '/projects/new-app');

        const config: unknown = JSON.parse(await readFile(join(home, '.claude.json'), 'utf8'));
        expect(config).toEqual({
            numStartups: 3,
            projects: { '/projects/new-app': { hasTrustDialogAccepted: true } },
        });
        expect(write).toHaveBeenCalledWith(
            'debug',
            logEventCatalog.agentDispatch.claudeTrustPrepared,
            { fields: { outcome: 'granted' } },
        );
    });

    it('leaves other providers alone', async () => {
        const { home, prepare, write } = await fixture('{}');

        await prepare('codex', '/projects/new-app');

        expect(await readFile(join(home, '.claude.json'), 'utf8')).toBe('{}');
        expect(write).not.toHaveBeenCalled();
    });

    it('warns when Claude Code will still ask for trust', async () => {
        const { prepare, write } = await fixture();

        await prepare('claude', '/projects/new-app');

        expect(write).toHaveBeenCalledWith(
            'warn',
            logEventCatalog.agentDispatch.claudeTrustPrepared,
            { fields: { outcome: 'missing_config' } },
        );
    });
});
