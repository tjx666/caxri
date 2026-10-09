import { access, mkdtemp, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { afterEach, describe, expect, it, vi } from 'vitest';

import {
    createE2EAgentEnvironment,
    createE2EAgentIsolationEnvironment,
    E2E_SHELL_PROMPT,
    e2eAgentStateEnvironmentKeys,
    selectE2ERealAgentStateEnvironment,
} from '../agent-environment';

describe('E2E Agent isolation environment', () => {
    afterEach(() => {
        vi.unstubAllEnvs();
    });

    it('isolates every provider-owned state environment under the fixture root', async () => {
        const fixtureRoot = await mkdtemp(join(tmpdir(), 'caxri-e2e-agent-environment-'));
        try {
            const environment = await createE2EAgentIsolationEnvironment(fixtureRoot);

            expect(new Set(e2eAgentStateEnvironmentKeys)).toEqual(
                new Set(['CLAUDE_CONFIG_DIR', 'CODEX_HOME', 'CODEX_SQLITE_HOME', 'GROK_HOME']),
            );
            expect(environment).toMatchObject({
                CLAUDE_CONFIG_DIR: join(fixtureRoot, 'claude'),
                CODEX_HOME: join(fixtureRoot, 'codex'),
                CODEX_SQLITE_HOME: join(fixtureRoot, 'codex'),
                GROK_HOME: join(fixtureRoot, 'grok'),
                HOME: join(fixtureRoot, 'home'),
            });
            await Promise.all(
                ['CLAUDE_CONFIG_DIR', 'CODEX_HOME', 'GROK_HOME', 'HOME'].map((key) =>
                    access(environment[key]!),
                ),
            );
        } finally {
            await rm(fixtureRoot, { recursive: true, force: true });
        }
    });

    it('creates fake-only shell shims and rejects relative executables', async () => {
        const fixtureRoot = await mkdtemp(join(tmpdir(), 'caxri-e2e-agent-environment-'));
        try {
            const claude = join(fixtureRoot, 'bin', 'claude');
            const environment = await createE2EAgentEnvironment({
                fixtureRoot,
                mode: { mode: 'fake', executables: { claude } },
                sourceEnvironment: { PATH: '/usr/bin:/bin' },
            });

            expect(environment).toMatchObject({
                CAXRI_E2E_AGENT_MODE: 'fake',
                CAXRI_E2E_FAKE_CLAUDE_EXECUTABLE: claude,
            });
            expect(environment.PATH?.startsWith(`${join(fixtureRoot, 'shell-bin')}:`)).toBe(true);
            expect(await readFile(join(fixtureRoot, 'shell-bin', 'codex'), 'utf8')).toContain(
                'Caxri E2E blocked codex',
            );

            await expect(
                createE2EAgentEnvironment({
                    fixtureRoot: join(fixtureRoot, 'relative-reject'),
                    mode: { mode: 'fake', executables: { claude: 'relative/claude' } },
                    sourceEnvironment: {},
                }),
            ).rejects.toThrow('Fake Agent executables must use absolute paths');
        } finally {
            await rm(fixtureRoot, { recursive: true, force: true });
        }
    });

    it('pins a synthetic shell prompt and startup directory inside the isolated HOME', async () => {
        const fixtureRoot = await mkdtemp(join(tmpdir(), 'caxri-e2e-agent-environment-'));
        try {
            const home = join(fixtureRoot, 'home');
            const environment = await createE2EAgentEnvironment({
                fixtureRoot,
                mode: { mode: 'blocked' },
                sourceEnvironment: { PATH: '/usr/bin:/bin', ZDOTDIR: '/host/private-zdotdir' },
            });

            expect(environment).toMatchObject({ HOME: home, ZDOTDIR: home });
            expect(await readFile(join(home, '.zlogin'), 'utf8')).toBe(
                `PROMPT='${E2E_SHELL_PROMPT}'\nPS1="$PROMPT"\nunset RPROMPT RPS1\n`,
            );
            const profiles = await Promise.all(
                ['.bash_profile', '.profile'].map((profile) =>
                    readFile(join(home, profile), 'utf8'),
                ),
            );
            for (const profile of profiles)
                expect(profile).toContain(`\nPS1='${E2E_SHELL_PROMPT}'\n`);
            expect(await readFile(join(home, '.zprofile'), 'utf8')).not.toContain('PS1');
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

    it('does not infer real provider state from the ambient process environment', async () => {
        vi.stubEnv('CODEX_HOME', '/host/private-codex');
        vi.stubEnv('CODEX_SQLITE_HOME', '/host/private-codex-sqlite');

        await expect(
            createE2EAgentEnvironment({
                fixtureRoot: '/unused-in-real-mode',
                mode: { mode: 'real', provider: 'codex' },
                sourceEnvironment: { PATH: '/usr/bin:/bin' },
            }),
        ).resolves.toEqual({
            CAXRI_E2E: '1',
            CAXRI_E2E_AGENT_MODE: 'real',
            CAXRI_E2E_AGENT_PROVIDER: 'codex',
        });
    });
});
