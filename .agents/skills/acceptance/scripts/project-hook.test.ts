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
} from './pre-tool-use';

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

interface ClaudeSettings extends HookConfig {
    permissions: { allow: string[] };
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
    test('loads the same provider-neutral hook through Codex and Claude', () => {
        const codexConfig = JSON.parse(
            readFileSync(new URL('../../../../.codex/hooks.json', import.meta.url), 'utf8'),
        ) as HookConfig;
        const claudeConfig = JSON.parse(
            readFileSync(new URL('../../../../.claude/settings.json', import.meta.url), 'utf8'),
        ) as ClaudeSettings;
        const codexHook = codexConfig.hooks.PreToolUse[0];
        const claudeHook = claudeConfig.hooks.PreToolUse[0];

        expect(codexHook.matcher).toBe('^Bash$');
        expect(claudeHook.matcher).toBe('^Bash$');
        expect(claudeHook.hooks[0].command).toContain('${CLAUDE_PROJECT_DIR}');
        expect(codexHook.hooks[0].command).toContain('git rev-parse --show-toplevel');
        for (const hook of [codexHook, claudeHook]) {
            expect(hook.hooks[0].command).toContain(
                '/.agents/skills/acceptance/scripts/pre-tool-use.ts',
            );
        }
    });

    test('allows the canonical read-only quality commands in Claude', () => {
        const config = JSON.parse(
            readFileSync(new URL('../../../../.claude/settings.json', import.meta.url), 'utf8'),
        ) as ClaudeSettings;

        expect(config.permissions.allow).toEqual(
            expect.arrayContaining([
                'Bash(bun run --silent check *)',
                'Bash(bun run doctor:changed)',
                'Bash(bun run lint:type-aware)',
                'Bash(bun run lint:markdown)',
            ]),
        );
    });

    test('documents canonical authentication and hook trust verification', () => {
        const projectGuide = readFileSync(
            new URL('../../../../.agents/acceptance/PROJECT.md', import.meta.url),
            'utf8',
        );

        expect(projectGuide).toContain('lh acceptance preflight --json');
        expect(projectGuide).toContain('lh whoami --json');
        expect(projectGuide).not.toContain('lh acceptance run list --json');
        expect(projectGuide).toContain('/hooks');
        expect(projectGuide).toContain('caxri-acceptance-hook-self-test');
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
                'agent-browser --cdp 9326 screenshot .records/acceptance/run/round-1/assets/result.png',
            ),
        ).toMatchObject({ ruleId: 'caxri-acceptance-raw-screenshot' });
        expect(evaluate('agent-browser --cdp 9326 screenshot "$ARTIFACT_PATH"')).toMatchObject({
            ruleId: 'caxri-acceptance-raw-screenshot',
        });
        expect(
            evaluate('agent-browser --cdp 9326 screenshot /tmp/debug.png | grep saved'),
        ).toMatchObject({ ruleId: 'caxri-acceptance-raw-screenshot' });
        expect(
            evaluate('echo ready && agent-browser --cdp 9326 screenshot /tmp/debug.png'),
        ).toMatchObject({ ruleId: 'caxri-acceptance-raw-screenshot' });
        for (const command of [
            'echo "$(agent-browser --cdp 9326 screenshot /tmp/debug.png)"',
            'echo `agent-browser --cdp 9326 screenshot /tmp/debug.png`',
            'command agent-browser --cdp 9326 screenshot /tmp/debug.png',
            'exec agent-browser --cdp 9326 screenshot /tmp/debug.png',
            "bash -c 'agent-browser --cdp 9326 screenshot /tmp/debug.png'",
            'agent-browser --cdp 9326 >/tmp/agent-browser.log screenshot /tmp/debug.png',
            'agent-browser --cdp 9326 screenshot>/tmp/debug.png',
            'agent-browser --cdp 9326 \\\n screenshot /tmp/debug.png',
            'agent-browser --restore acceptance --cdp 9326 screenshot /tmp/debug.png',
            'agent-browser --restore --cdp 9326 screenshot /tmp/debug.png',
            'agent-browser --session acceptance --restore --cdp 9326 screenshot /tmp/debug.png',
            'agent-browser --restore --restore-check-text ready --cdp 9326 screenshot /tmp/debug.png',
            '/usr/bin/env agent-browser --cdp 9326 screenshot /tmp/debug.png',
            'env -S agent-browser --cdp 9326 screenshot /tmp/debug.png',
            "env -S 'agent-browser --cdp 9326 screenshot /tmp/debug.png'",
            'if true; then agent-browser --cdp 9326 screenshot /tmp/debug.png; fi',
            'if agent-browser --cdp 9326 screenshot /tmp/debug.png; then true; fi',
            '{ agent-browser --cdp 9326 screenshot /tmp/debug.png; }',
            'time agent-browser --cdp 9326 screenshot /tmp/debug.png',
            "eval 'agent-browser --cdp 9326 screenshot /tmp/debug.png'",
            'printf ready | xargs agent-browser --cdp 9326 screenshot /tmp/debug.png',
            'coproc agent-browser --cdp 9326 screenshot /tmp/debug.png',
            'coproc capture { agent-browser --cdp 9326 screenshot /tmp/debug.png; }',
            'command -p agent-browser --cdp 9326 screenshot /tmp/debug.png',
            'nohup agent-browser --cdp 9326 screenshot /tmp/debug.png',
            'nice agent-browser --cdp 9326 screenshot /tmp/debug.png',
            'nice -n 5 agent-browser --cdp 9326 screenshot /tmp/debug.png',
            'timeout 1 agent-browser --cdp 9326 screenshot /tmp/debug.png',
            'timeout -s TERM 1 agent-browser --cdp 9326 screenshot /tmp/debug.png',
            'setsid agent-browser --cdp 9326 screenshot /tmp/debug.png',
            'setsid -f agent-browser --cdp 9326 screenshot /tmp/debug.png',
            'sudo agent-browser --cdp 9326 screenshot /tmp/debug.png',
            'sudo -u root agent-browser --cdp 9326 screenshot /tmp/debug.png',
            'parallel agent-browser --cdp 9326 screenshot /tmp/debug.png',
            String.raw`find . -exec agent-browser --cdp 9326 screenshot /tmp/debug.png \;`,
            String.raw`find . -execdir agent-browser --cdp 9326 screenshot /tmp/debug.png \;`,
        ]) {
            expect(evaluate(command), command).toMatchObject({
                ruleId: 'caxri-acceptance-raw-screenshot',
            });
        }
        expect(
            evaluate('agent-browser --cdp 9223 screenshot /tmp/debug.png', {
                acceptanceRuntimeExists: false,
            }),
        ).toBeNull();
        expect(
            evaluate(
                'bun run .agents/skills/acceptance/scripts/capture-renderer.ts screenshot --output .records/acceptance/run/round-1/assets/result.png',
            ),
        ).toBeNull();
    });

    test('allows screenshot text outside the agent-browser subcommand', () => {
        expect(evaluate('agent-browser --cdp 9326 get text screenshot')).toBeNull();
        expect(evaluate('agent-browser --cdp 9326 click "screenshot"')).toBeNull();
        expect(evaluate('agent-browser --cdp 9326 open https://example.com/screenshot')).toBeNull();
        expect(evaluate('agent-browser get text body | grep screenshot')).toBeNull();
        expect(evaluate('echo "agent-browser screenshot"')).toBeNull();
        expect(evaluate('agent-browser --session screenshot --cdp 9326 get url')).toBeNull();
        expect(evaluate('env -S echo agent-browser screenshot')).toBeNull();
        expect(evaluate("eval 'echo agent-browser screenshot'")).toBeNull();
        expect(evaluate('printf agent-browser | xargs echo screenshot')).toBeNull();
        expect(evaluate('time echo agent-browser screenshot')).toBeNull();
        expect(evaluate('command -v agent-browser screenshot')).toBeNull();
        expect(evaluate('nohup --help agent-browser screenshot')).toBeNull();
        expect(evaluate('setsid --help agent-browser screenshot')).toBeNull();
        expect(evaluate('sudo --version agent-browser screenshot')).toBeNull();
        expect(evaluate(String.raw`find . -exec echo agent-browser screenshot \;`)).toBeNull();
        expect(
            evaluate("agent-browser --cdp 9326 eval --stdin <<'EOF'\nscreenshot\nEOF"),
        ).toBeNull();
        expect(
            evaluate(
                "agent-browser --cdp 9326 eval --stdin <<'EOF'\nagent-browser screenshot\nEOF",
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

    test('exposes a harmless command that proves the project hook is active', () => {
        expect(evaluate('caxri-acceptance-hook-self-test')).toMatchObject({
            ruleId: 'caxri-acceptance-hook-self-test',
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

        await expect(
            runPreToolUse(
                {
                    cwd: path.resolve(import.meta.dirname, '../../../..'),
                    hook_event_name: 'PreToolUse',
                    tool_input: { command: 'agent-browser get text body | grep screenshot' },
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
        const hookPath = path.resolve(import.meta.dirname, 'pre-tool-use.ts');
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
