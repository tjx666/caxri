import { spawnSync } from 'node:child_process';
import { readFileSync } from 'node:fs';
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';

import { describe, expect, test, vi } from 'vitest';

import {
    evaluateCaxriAcceptanceCommand,
    isOwnedAcceptanceRuntime,
    resolveCommandCwd,
    runPreToolUse,
} from './codex-pre-tool-use';

interface EvaluationOverrides {
    acceptanceRuntimeExists?: boolean;
    cwd?: string;
    projectRoot?: string;
}

interface HookConfig {
    hooks: {
        PreToolUse: Array<{
            hooks: Array<{ command: string }>;
            matcher: string;
        }>;
    };
}

const projectRoot = '/tmp/caxri';

const evaluate = (command: string, overrides: EvaluationOverrides = {}) =>
    evaluateCaxriAcceptanceCommand({
        acceptanceRuntimeExists: true,
        command,
        cwd: projectRoot,
        projectRoot,
        ...overrides,
    });

describe('Caxri Acceptance project hook', () => {
    test('loads through a git-root-relative project hook command', () => {
        const config = JSON.parse(
            readFileSync(new URL('../../../../.codex/hooks.json', import.meta.url), 'utf8'),
        ) as HookConfig;
        const command = config.hooks.PreToolUse[0].hooks[0].command;

        expect(config.hooks.PreToolUse[0].matcher).toBe('^Bash$');
        expect(command).toContain('git rev-parse --show-toplevel');
        expect(command).toContain('/.agents/skills/acceptance/scripts/codex-pre-tool-use.ts');
    });

    test('blocks pin-tab against the owned Electron Acceptance runtime', () => {
        expect(
            evaluate('agent-browser --session acceptance-case --pin-tab --cdp 9326 get url'),
        ).toMatchObject({ ruleId: 'caxri-acceptance-pin-tab' });
        expect(
            evaluate('agent-browser --session acceptance-case --pin-tab --cdp 9326 get url', {
                acceptanceRuntimeExists: false,
            }),
        ).toBeNull();
    });

    test('blocks every raw screenshot while an owned Acceptance runtime is active', () => {
        expect(
            evaluate(
                'agent-browser --cdp 9326 screenshot .records/go/run/acceptance/round-1/assets/result.png',
            ),
        ).toMatchObject({ ruleId: 'caxri-acceptance-raw-screenshot' });
        expect(evaluate('agent-browser --cdp 9326 screenshot "$ARTIFACT_PATH"')).toMatchObject({
            ruleId: 'caxri-acceptance-raw-screenshot',
        });
        expect(
            evaluate('agent-browser --cdp 9223 screenshot /tmp/debug.png', {
                acceptanceRuntimeExists: false,
            }),
        ).toBeNull();
        expect(
            evaluate(
                'bun run .agents/skills/acceptance/scripts/capture-renderer.ts screenshot --output .records/go/run/acceptance/round-1/assets/result.png',
            ),
        ).toBeNull();
    });

    test('does not treat malformed or stale runtime receipts as active ownership', async () => {
        const directory = await mkdtemp(path.join(tmpdir(), 'caxri-project-hook-'));
        try {
            const runtimePath = path.join(directory, 'runtime.json');
            await writeFile(runtimePath, '{invalid json');
            await expect(isOwnedAcceptanceRuntime(runtimePath)).resolves.toBe(false);

            await writeFile(
                runtimePath,
                JSON.stringify({
                    cdpUrl: 'http://127.0.0.1:9326',
                    electronIdentity: null,
                    electronPid: null,
                    launcherIdentity: 'stale launcher',
                    launcherPid: 2_147_483_647,
                    ownedProcesses: [],
                    ownedUserData: true,
                    port: 9326,
                    projectRoot,
                    startedAt: '2026-08-28T00:00:00.000Z',
                    testRootPath: path.join(directory, 'project'),
                    userDataDir: path.join(directory, 'profile'),
                }),
            );
            await expect(isOwnedAcceptanceRuntime(runtimePath)).resolves.toBe(false);
        } finally {
            await rm(directory, { recursive: true });
        }
    });

    test('blocks manual Go Acceptance round advancement', async () => {
        const command =
            'bun run .agents/skills/go/scripts/state.ts acceptance --state run/state.json --status running --round 1';
        expect(evaluate(command)).toMatchObject({ ruleId: 'caxri-acceptance-manual-round' });

        const output = await runPreToolUse({
            cwd: path.resolve(import.meta.dirname, '../../../..'),
            hook_event_name: 'PreToolUse',
            tool_input: { command },
        });
        expect(JSON.parse(output)).toMatchObject({
            hookSpecificOutput: {
                hookEventName: 'PreToolUse',
                permissionDecision: 'deny',
            },
        });
    });

    test('does not probe unrelated commands and denies guarded commands when ownership is unknown', async () => {
        const unavailableProbe = vi.fn(() =>
            Promise.reject(new Error('process probe unavailable')),
        );
        await expect(
            runPreToolUse(
                {
                    cwd: path.resolve(import.meta.dirname, '../../../..'),
                    hook_event_name: 'PreToolUse',
                    tool_input: { command: 'git status --short' },
                },
                unavailableProbe,
            ),
        ).resolves.toBe('');
        expect(unavailableProbe).not.toHaveBeenCalled();

        const denied = await runPreToolUse(
            {
                cwd: path.resolve(import.meta.dirname, '../../../..'),
                hook_event_name: 'PreToolUse',
                tool_input: { command: 'agent-browser --cdp 9326 --pin-tab get url' },
            },
            unavailableProbe,
        );
        expect(unavailableProbe).toHaveBeenCalledOnce();
        expect(JSON.parse(denied)).toMatchObject({
            hookSpecificOutput: {
                permissionDecision: 'deny',
            },
        });
        expect(denied).toContain('caxri-acceptance-pin-tab');
    });

    test('fails the hook process when its input cannot be evaluated', () => {
        const hookPath = path.resolve(import.meta.dirname, 'codex-pre-tool-use.ts');
        const result = spawnSync('bun', ['run', hookPath], {
            encoding: 'utf8',
            input: '{invalid json',
        });

        expect(result.status).toBe(1);
        expect(result.stderr).toContain('Caxri PreToolUse hook failed');
    });

    test('does not apply the Caxri project policy outside the repository', () => {
        expect(
            evaluate('agent-browser --pin-tab --cdp 9326 get url', {
                cwd: '/tmp/lobehub-cloud',
            }),
        ).toBeNull();
    });

    test('resolves a relative tool workdir from the session cwd', () => {
        expect(
            resolveCommandCwd({
                cwd: path.join(projectRoot, 'apps'),
                tool_input: { workdir: '../packages' },
            }),
        ).toBe(path.join(projectRoot, 'packages'));
    });
});
