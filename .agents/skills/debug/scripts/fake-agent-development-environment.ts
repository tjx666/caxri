/**
 * Prepares a task-owned fixture folder for a dev instance that runs a fake Agent Chat provider, and either launches
 * `switch-worktree dev` with that environment (`--dev`) or prints the shell exports it needs. Built on the same
 * fixtures as the Electron E2E specs, so a scenario that works there (such as fake Claude's `ask multi`) works in the
 * dev window too.
 *
 * Usage:
 *
 * ```sh
 * bun run .agents/skills/debug/scripts/fake-agent-development-environment.ts /tmp/<task> --provider claude --dev
 * ```
 *
 * `--dev` runs `switch-worktree dev --user-data-dir <task>/profile` as a child with the environment applied, so an
 * agent needs one plain command. A worktree-isolated agent harness refuses `eval "$(...)"`, `source`, and an inline
 * `HOME=` assignment, because it cannot prove the resulting command keeps Git inside the worktree. Without `--dev` the
 * script prints `export` lines for an interactive shell:
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
 * `--real-executable <absolute path>` is the debug skill's controlled real-Agent exception: the selected provider runs
 * that real CLI, and every other Agent stays blocked. It exports no fake fixture state and keeps the host `HOME`,
 * because a real CLI's sign-in lives there (Antigravity's under `~/.gemini`, which no variable relocates) and an
 * isolated HOME shows it signed out. The dev profile stays in `<task>/profile`.
 *
 * The exports also move `HOME` (with `ZDOTDIR` and the XDG directories) into the fixture: Session search and Usage read
 * every provider's history, and Antigravity's state under `~/.gemini` has no variable that relocates it, so the dev
 * window would otherwise show the host's real conversations. An isolated HOME hides the mise shims, so the pinned Node
 * the Server build needs is resolved first and exported as `CAXRI_SERVER_RUNTIME_EXECUTABLE`.
 */
import { execFile, spawn } from 'node:child_process';
import { mkdir, readFile, writeFile } from 'node:fs/promises';
import { isAbsolute, join, resolve } from 'node:path';
import process from 'node:process';
import { parseArgs, promisify } from 'node:util';

import type { AgentProvider } from '@caxri/protocol';
import { agentProviderIds } from '@caxri/protocol';
import {
    createE2EAgentEnvironment,
    e2eAgentEnvironmentKeys,
    e2eFakeExecutableEnvironmentKey,
} from '@caxri/system';

import {
    fakeAntigravityChatAgentMode,
    fakeClaudeChatAgentMode,
    fakeCodexChatAgentMode,
    fakeGrokChatAgentMode,
} from '../../../../e2e/support/agent-chat-fixture';

const PROVIDERS = agentProviderIds;
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
type FakeChatProvider = AgentProvider;

function shellQuote(value: string): string {
    return `'${value.replaceAll("'", String.raw`'\''`)}'`;
}

/**
 * Every isolation key the fake environment sets, plus the switches that make Caxri honor the fake executables
 * (`CAXRI_E2E`), show the window, and grant the fixture Project root without a folder picker.
 */
export function fakeAgentDevelopmentEnvironment(
    environment: NodeJS.ProcessEnv,
    keys: readonly string[],
    projectRoot: string,
): Array<[string, string]> {
    const entries: Array<[string, string]> = [
        ['CAXRI_E2E', '1'],
        ['CAXRI_E2E_WINDOW_MODE', 'visible'],
        ['CAXRI_TEST_ROOT_PATH', projectRoot],
    ];
    for (const key of keys) {
        const value = environment[key];
        if (value !== undefined) entries.push([key, value]);
    }
    return entries;
}

/**
 * The `export` lines of {@link fakeAgentDevelopmentEnvironment} for an interactive shell's `eval`.
 */
export function fakeAgentDevelopmentExports(entries: ReadonlyArray<[string, string]>): string {
    return entries.map(([key, value]) => `export ${key}=${shellQuote(value)}`).join('\n');
}

export function parseFakeAgentDevelopmentArguments(arguments_: readonly string[]): {
    directory: string;
    launchDev: boolean;
    provider: FakeChatProvider;
    realExecutable?: string;
    scriptPath?: string;
} {
    const { positionals, values } = parseArgs({
        args: [...arguments_],
        allowPositionals: true,
        options: {
            'dev': { type: 'boolean' },
            'provider': { type: 'string' },
            'real-executable': { type: 'string' },
            'script': { type: 'string' },
        },
    });
    const [directory] = positionals;
    if (!directory || positionals.length !== 1 || !isAbsolute(directory))
        throw new Error(
            'Usage: fake-agent-development-environment.ts <absolute task dir> [--provider claude|codex|grok|antigravity] [--script <absolute path> | --real-executable <absolute path>] [--dev]',
        );
    const realExecutable = values['real-executable'];
    if (realExecutable !== undefined && !isAbsolute(realExecutable))
        throw new Error('--real-executable must be an absolute path');
    if (realExecutable !== undefined && values.script !== undefined)
        throw new Error('--script drives a fake Agent; a real executable takes no script');
    const provider = values.provider ?? 'claude';
    if (!PROVIDERS.includes(provider as FakeChatProvider))
        throw new Error(`--provider must be one of ${PROVIDERS.join(', ')}`);
    const scriptPath = values.script;
    if (scriptPath !== undefined && !isAbsolute(scriptPath))
        throw new Error('--script must be an absolute path');
    if (scriptPath !== undefined && (provider === 'grok' || provider === 'antigravity'))
        throw new Error('--script supports only fake claude and codex');
    return {
        directory,
        launchDev: values.dev ?? false,
        provider: provider as FakeChatProvider,
        ...(realExecutable && { realExecutable }),
        ...(scriptPath && { scriptPath }),
    };
}

/**
 * The environment of a controlled real-Agent run: E2E mode with exactly one executable, the selected provider's real
 * CLI, so Caxri blocks every other Agent instead of discovering them on the host.
 */
export function realAgentDevelopmentEnvironment(
    provider: AgentProvider,
    executable: string,
    projectRoot: string,
): Array<[string, string]> {
    return [
        ['CAXRI_E2E', '1'],
        ['CAXRI_E2E_AGENT_MODE', 'fake'],
        [e2eFakeExecutableEnvironmentKey(provider), executable],
        ['CAXRI_E2E_WINDOW_MODE', 'visible'],
        ['CAXRI_TEST_ROOT_PATH', projectRoot],
    ];
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
    const { directory, launchDev, provider, realExecutable, scriptPath } =
        parseFakeAgentDevelopmentArguments(process.argv.slice(2));
    const userData = join(directory, 'user-data');
    const projectRoot = join(directory, 'project');
    await mkdir(projectRoot, { recursive: true });
    if (realExecutable) {
        const entries = realAgentDevelopmentEnvironment(provider, realExecutable, projectRoot);
        if (!launchDev) process.stdout.write(`${fakeAgentDevelopmentExports(entries)}\n`);
        else
            process.exitCode = await launchDevelopmentInstance(entries, join(directory, 'profile'));
        return;
    }
    const controlDirectory = join(directory, 'control');
    await mkdir(controlDirectory, { recursive: true });
    await writeFile(join(controlDirectory, 'ai-naming'), '');
    // A Record, not a ternary chain, so a provider added to the catalog fails typecheck here instead of silently
    // launching another provider's fake.
    const fakeModes: Record<AgentProvider, () => ReturnType<typeof fakeGrokChatAgentMode>> = {
        claude: () => fakeClaudeChatAgentMode(userData, controlDirectory, scriptPath),
        codex: () => fakeCodexChatAgentMode(directory, userData, { scriptPath }),
        grok: () => fakeGrokChatAgentMode(directory, userData),
        antigravity: () => fakeAntigravityChatAgentMode(directory, userData),
    };
    const mode = await fakeModes[provider]();
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
    const entries = fakeAgentDevelopmentEnvironment(environment, keys, projectRoot);
    if (!launchDev) {
        process.stdout.write(`${fakeAgentDevelopmentExports(entries)}\n`);
        return;
    }
    process.exitCode = await launchDevelopmentInstance(entries, join(directory, 'profile'));
}

/**
 * Runs `switch-worktree dev` for this checkout with the fake environment applied, forwarding SIGINT and SIGTERM so the
 * launcher still stops its own process tree, and resolves with its exit code.
 */
async function launchDevelopmentInstance(
    entries: ReadonlyArray<[string, string]>,
    profile: string,
): Promise<number> {
    const child = spawn(
        process.execPath,
        [
            'run',
            join(REPOSITORY_ROOT, '.agents/skills/switch-worktree/scripts/switch-worktree.ts'),
            'dev',
            '--user-data-dir',
            profile,
        ],
        {
            cwd: REPOSITORY_ROOT,
            env: { ...process.env, ...Object.fromEntries(entries) },
            stdio: 'inherit',
        },
    );
    for (const signal of ['SIGINT', 'SIGTERM'] as const)
        process.on(signal, () => child.kill(signal));
    return new Promise((resolve, reject) => {
        child.once('error', reject);
        child.once('exit', (code, signal) => resolve(code ?? (signal ? 1 : 0)));
    });
}

if (import.meta.main) await main();
