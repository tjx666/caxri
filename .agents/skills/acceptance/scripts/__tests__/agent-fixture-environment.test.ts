import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { afterEach, describe, expect, it } from 'vitest';

import { agentFixtureShellExports } from '../agent-fixture-environment';

const directories: string[] = [];

afterEach(async () => {
    const owned = [...directories];
    directories.length = 0;
    await Promise.all(owned.map((directory) => rm(directory, { force: true, recursive: true })));
});

describe('agentFixtureShellExports', () => {
    it('exports the fake Chat targets with the explicit E2E opt-in for a dev launch', async () => {
        const root = await mkdtemp(join(tmpdir(), 'caxri-agent-fixture-env-'));
        directories.push(root);

        const exports = await agentFixtureShellExports({
            fixtureId: 'agent-chat-v1',
            root,
            sourceEnvironment: { PATH: '/usr/bin:/bin' },
            testRoot: '/tmp/project with space',
        });

        expect(exports).toContain("export CAXRI_E2E='1'");
        expect(exports).toContain("export CAXRI_E2E_AGENT_MODE='fake'");
        expect(exports).toContain("export CAXRI_TEST_ROOT_PATH='/tmp/project with space'");
        expect(exports).toContain(`'${join(root, 'acceptance-agents', 'bin', 'claude')}'`);
        expect(exports).toContain(`'${join(root, 'acceptance-agents', 'bin', 'codex')}'`);
        expect(exports).toContain(
            `export CLAUDE_CONFIG_DIR='${join(root, 'acceptance-agents', 'claude')}'`,
        );
        expect(exports).not.toMatch(/^export (HOME|PATH|ZDOTDIR)=/mu);
    });

    it('rejects unknown fixtures and relative paths before writing anything', async () => {
        await expect(
            agentFixtureShellExports({ fixtureId: 'agent-chat-v1', root: 'relative' }),
        ).rejects.toThrow('Agent fixture paths must be absolute: relative');
        const root = await mkdtemp(join(tmpdir(), 'caxri-agent-fixture-env-'));
        directories.push(root);
        await expect(agentFixtureShellExports({ fixtureId: 'claude', root })).rejects.toThrow(
            'Unknown Acceptance Agent fixture: claude',
        );
    });
});
