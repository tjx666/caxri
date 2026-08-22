import { access, mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { describe, expect, it } from 'vitest';

import {
    createE2EAgentIsolationEnvironment,
    e2eAgentStateEnvironmentKeys,
    selectE2ERealAgentStateEnvironment,
} from './agent-environment';

describe('E2E Agent isolation environment', () => {
    it('isolates every provider-owned state environment under the fixture root', async () => {
        const fixtureRoot = await mkdtemp(join(tmpdir(), 'caxri-e2e-agent-environment-'));
        try {
            const environment = await createE2EAgentIsolationEnvironment(fixtureRoot);

            expect(new Set(e2eAgentStateEnvironmentKeys)).toEqual(
                new Set(['CLAUDE_CONFIG_DIR', 'CODEX_HOME', 'CODEX_SQLITE_HOME']),
            );
            expect(environment).toMatchObject({
                CLAUDE_CONFIG_DIR: join(fixtureRoot, 'claude'),
                CODEX_HOME: join(fixtureRoot, 'codex'),
                CODEX_SQLITE_HOME: join(fixtureRoot, 'codex'),
                HOME: join(fixtureRoot, 'home'),
            });
            await Promise.all(
                ['CLAUDE_CONFIG_DIR', 'CODEX_HOME', 'HOME'].map((key) => access(environment[key]!)),
            );
        } finally {
            await rm(fixtureRoot, { recursive: true, force: true });
        }
    });

    it('keeps only explicit absolute state overrides for the selected real provider', () => {
        expect(
            selectE2ERealAgentStateEnvironment('codex', {
                CLAUDE_CONFIG_DIR: '/tmp/claude',
                CODEX_HOME: '/tmp/codex',
                CODEX_SQLITE_HOME: '/tmp/codex-sqlite',
            }),
        ).toEqual({
            CODEX_HOME: '/tmp/codex',
            CODEX_SQLITE_HOME: '/tmp/codex-sqlite',
        });
        expect(() =>
            selectE2ERealAgentStateEnvironment('claude', {
                CLAUDE_CONFIG_DIR: 'relative/claude',
            }),
        ).toThrow('Real E2E Agent state override CLAUDE_CONFIG_DIR must use an absolute path');
    });
});
