/**
 * Prepares a task-owned fixture folder for a dev instance that runs a fake Agent Chat provider, and prints the shell
 * exports `switch-worktree dev` needs. Built on the same fixtures as the Electron E2E specs, so a scenario that works
 * there (such as fake Claude's `ask multi`) works in the dev window too.
 *
 * Usage:
 *
 * ```sh
 * eval "$(bun run .agents/skills/debug/scripts/fake-agent-development-environment.ts /tmp/<task> --provider claude)"
 * bun run .agents/skills/switch-worktree/scripts/switch-worktree.ts dev --user-data-dir /tmp/<task>/profile
 * ```
 */
import { mkdir } from 'node:fs/promises';
import { isAbsolute, join } from 'node:path';
import process from 'node:process';

import { createE2EAgentEnvironment, e2eAgentEnvironmentKeys } from '@caxri/system';

import {
    fakeClaudeChatAgentMode,
    fakeCodexChatAgentMode,
    fakeGrokChatAgentMode,
} from '../../../../e2e/support/agent-chat-fixture';

const PROVIDERS = ['claude', 'codex', 'grok'] as const;
type FakeChatProvider = (typeof PROVIDERS)[number];

function shellQuote(value: string): string {
    return `'${value.replaceAll("'", String.raw`'\''`)}'`;
}

/**
 * The `export` lines for every isolation key the fake environment sets, plus the switches that make Caxri honor the
 * fake executables (`CAXRI_E2E`), show the window, and grant the fixture Project root without a folder picker.
 */
export function fakeAgentDevelopmentExports(
    environment: NodeJS.ProcessEnv,
    keys: readonly string[],
    projectRoot: string,
): string {
    const entries: Array<[string, string]> = [
        ['CAXRI_E2E', '1'],
        ['CAXRI_E2E_WINDOW_MODE', 'visible'],
        ['CAXRI_TEST_ROOT_PATH', projectRoot],
    ];
    for (const key of keys) {
        const value = environment[key];
        if (value !== undefined) entries.push([key, value]);
    }
    return entries.map(([key, value]) => `export ${key}=${shellQuote(value)}`).join('\n');
}

export function parseFakeAgentDevelopmentArguments(arguments_: readonly string[]): {
    directory: string;
    provider: FakeChatProvider;
} {
    const [directory, flag, value] = arguments_;
    if (!directory || !isAbsolute(directory))
        throw new Error(
            'Usage: fake-agent-development-environment.ts <absolute task dir> [--provider claude|codex|grok]',
        );
    if (arguments_.length === 1) return { directory, provider: 'claude' };
    if (flag !== '--provider' || !PROVIDERS.includes(value as FakeChatProvider))
        throw new Error('--provider must be one of claude, codex, grok');
    return { directory, provider: value as FakeChatProvider };
}

async function main(): Promise<void> {
    const { directory, provider } = parseFakeAgentDevelopmentArguments(process.argv.slice(2));
    const userData = join(directory, 'user-data');
    const projectRoot = join(directory, 'project');
    await mkdir(projectRoot, { recursive: true });
    const mode =
        provider === 'claude'
            ? await fakeClaudeChatAgentMode(userData)
            : provider === 'codex'
              ? await fakeCodexChatAgentMode(directory, userData)
              : await fakeGrokChatAgentMode(directory, userData);
    const environment = await createE2EAgentEnvironment({
        fixtureRoot: join(userData, 'e2e-agents'),
        mode,
        sourceEnvironment: { PATH: process.env.PATH },
    });
    process.stdout.write(
        `${fakeAgentDevelopmentExports(environment, e2eAgentEnvironmentKeys(), projectRoot)}\n`,
    );
}

if (import.meta.main) await main();
