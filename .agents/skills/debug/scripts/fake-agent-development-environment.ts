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
 *
 * Fake Claude reads its control files from `<task>/control`, so a file created there switches on the same scenario an
 * E2E spec does: `touch /tmp/<task>/control/plan-behind-pace` makes `/usage` report a week ahead of pace.
 *
 * Fake Claude's AI Session naming (Option+click a Session row, or "Rename Session with AI") is switched on here by
 * `<task>/control/ai-naming`, and answers "Fake generated title". `echo 2 > <task>/control/naming-skip` makes the next
 * two generations answer `SKIP`; `naming-invalid` does the same for a title that fails validation.
 *
 * `--script <absolute path>` hands fake Claude or Codex a JSON file of scripted turns (`fake-claude-script.ts`,
 * `fake-codex-script.ts`), for a reply with exact content such as a long code block. Exporting `FAKE_CLAUDE_SCRIPT` in
 * the shell does nothing: the Agent process environment is an allowlist, so the path is baked into the fake's
 * launcher.
 *
 * The exports also move `HOME` (with `ZDOTDIR` and the XDG directories) into the fixture: Session search and Usage read
 * every provider's history, and Antigravity's state under `~/.gemini` has no variable that relocates it, so the dev
 * window would otherwise show the host's real conversations. An isolated HOME hides the mise shims, so the pinned Node
 * the Server build needs is resolved first and exported as `CAXRI_SERVER_RUNTIME_EXECUTABLE`.
 */
import { execFile } from 'node:child_process';
import { mkdir, readFile, writeFile } from 'node:fs/promises';
import { isAbsolute, join, resolve } from 'node:path';
import process from 'node:process';
import { parseArgs, promisify } from 'node:util';

import { createE2EAgentEnvironment, e2eAgentEnvironmentKeys } from '@caxri/system';

import {
    fakeAntigravityChatAgentMode,
    fakeClaudeChatAgentMode,
    fakeCodexChatAgentMode,
    fakeGrokChatAgentMode,
} from '../../../../e2e/support/agent-chat-fixture';

const PROVIDERS = ['claude', 'codex', 'grok', 'antigravity'] as const;
/**
 * Keys beyond {@link e2eAgentEnvironmentKeys} that keep the dev instance's own home directory inside the fixture.
 */
const HOME_ISOLATION_KEYS = [
    'HOME',
    'ZDOTDIR',
    'XDG_CACHE_HOME',
    'XDG_CONFIG_HOME',
    'XDG_DATA_HOME',
] as const;
const REPOSITORY_ROOT = resolve(import.meta.dirname, '../../../..');
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
    scriptPath?: string;
} {
    const { positionals, values } = parseArgs({
        args: [...arguments_],
        allowPositionals: true,
        options: { provider: { type: 'string' }, script: { type: 'string' } },
    });
    const [directory] = positionals;
    if (!directory || positionals.length !== 1 || !isAbsolute(directory))
        throw new Error(
            'Usage: fake-agent-development-environment.ts <absolute task dir> [--provider claude|codex|grok|antigravity] [--script <absolute path>]',
        );
    const provider = values.provider ?? 'claude';
    if (!PROVIDERS.includes(provider as FakeChatProvider))
        throw new Error(`--provider must be one of ${PROVIDERS.join(', ')}`);
    const scriptPath = values.script;
    if (scriptPath !== undefined && !isAbsolute(scriptPath))
        throw new Error('--script must be an absolute path');
    if (scriptPath !== undefined && (provider === 'grok' || provider === 'antigravity'))
        throw new Error('--script supports only fake claude and codex');
    return { directory, provider: provider as FakeChatProvider, ...(scriptPath && { scriptPath }) };
}

const execFileAsync = promisify(execFile);

async function commandOutput(command: string, arguments_: string[]): Promise<string | undefined> {
    try {
        return (
            (await execFileAsync(command, arguments_, { encoding: 'utf8' })).stdout.trim() ||
            undefined
        );
    } catch {
        return undefined;
    }
}

/**
 * The Node executable `mise.toml` pins, found while the real HOME still reaches the mise toolchain. Fails closed: a
 * Server build without it would fall back to a lookup the isolated HOME breaks.
 */
async function pinnedNodeExecutable(): Promise<string> {
    const version = /^node\s*=\s*"([^"]+)"$/mu.exec(
        await readFile(join(REPOSITORY_ROOT, 'mise.toml'), 'utf8'),
    )?.[1];
    if (!version) throw new Error('mise.toml must pin the Node version');
    const candidates = [
        process.env.CAXRI_SERVER_RUNTIME_EXECUTABLE,
        await commandOutput('mise', ['which', 'node']),
    ];
    const versions = await Promise.all(
        candidates.map(async (candidate) => candidate && commandOutput(candidate, ['--version'])),
    );
    const pinned = candidates.find((_, index) => versions[index] === `v${version}`);
    if (pinned) return pinned;
    throw new Error(
        `Node ${version} is unavailable; install the mise toolchain or set CAXRI_SERVER_RUNTIME_EXECUTABLE`,
    );
}

async function main(): Promise<void> {
    const { directory, provider, scriptPath } = parseFakeAgentDevelopmentArguments(
        process.argv.slice(2),
    );
    const userData = join(directory, 'user-data');
    const projectRoot = join(directory, 'project');
    await mkdir(projectRoot, { recursive: true });
    const controlDirectory = join(directory, 'control');
    await mkdir(controlDirectory, { recursive: true });
    await writeFile(join(controlDirectory, 'ai-naming'), '');
    const mode =
        provider === 'claude'
            ? await fakeClaudeChatAgentMode(userData, controlDirectory, scriptPath)
            : provider === 'codex'
              ? await fakeCodexChatAgentMode(directory, userData, { scriptPath })
              : provider === 'grok'
                ? await fakeGrokChatAgentMode(directory, userData)
                : await fakeAntigravityChatAgentMode(directory, userData);
    const environment = await createE2EAgentEnvironment({
        fixtureRoot: join(userData, 'e2e-agents'),
        mode,
        sourceEnvironment: { PATH: process.env.PATH },
    });
    environment.CAXRI_SERVER_RUNTIME_EXECUTABLE = await pinnedNodeExecutable();
    const keys = [
        ...e2eAgentEnvironmentKeys(),
        ...HOME_ISOLATION_KEYS,
        'CAXRI_SERVER_RUNTIME_EXECUTABLE',
    ];
    process.stdout.write(`${fakeAgentDevelopmentExports(environment, keys, projectRoot)}\n`);
}

if (import.meta.main) await main();
