#!/usr/bin/env bun

import { readFile } from 'node:fs/promises';
import path from 'node:path';
import process from 'node:process';
import { text } from 'node:stream/consumers';
import { fileURLToPath } from 'node:url';

import type { ShellToken } from './shell-command';
import {
    commandExecutableIndex,
    executableBasename,
    executableSegments,
    withoutRedirections,
} from './shell-command';

interface CommandEvaluationInput {
    acceptanceRuntimeExists: boolean;
    command: string;
    cwd: string;
    projectRoot?: string;
}

interface GuardAction {
    reason: string;
    ruleId: string;
}

type UnknownRecord = Record<string, unknown>;

const PROJECT_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../../../..');
const ACCEPTANCE_RUNTIME_PATH = '.records/acceptance/runtime.json';
const HOOK_SELF_TEST_COMMAND = 'caxri-acceptance-hook-self-test';

const asRecord = (value: unknown): UnknownRecord =>
    typeof value === 'object' && value !== null ? (value as UnknownRecord) : {};

const commandText = (value: unknown): string => (typeof value === 'string' ? value.trim() : '');

interface AgentBrowserInvocation {
    hasCdp: boolean;
    hasPinTab: boolean;
    subcommand: string | null;
}

const AGENT_BROWSER_OPTIONS_WITH_VALUE = new Set([
    '--action-policy',
    '--allowed-domains',
    '--args',
    '--ca-cert',
    '--cdp',
    '--color-scheme',
    '--config',
    '--confirm-actions',
    '--device',
    '--download-path',
    '--enable',
    '--engine',
    '--executable-path',
    '--extension',
    '--headers',
    '--idle-timeout',
    '--init-script',
    '--max-output',
    '--model',
    '--namespace',
    '--profile',
    '--provider',
    '--proxy',
    '--proxy-bypass',
    '--restore-check-fn',
    '--restore-check-text',
    '--restore-check-url',
    '--restore-save',
    '--screenshot-dir',
    '--screenshot-format',
    '--screenshot-quality',
    '--session',
    '--session-name',
    '--state',
    '--user-agent',
    '-p',
]);

const parseAgentBrowserInvocation = (tokens: ShellToken[]): AgentBrowserInvocation | null => {
    const words = withoutRedirections(tokens);
    const executableIndex = commandExecutableIndex(words);
    if (executableIndex === null) return null;
    const executable = words[executableIndex];
    if (!executable || (executable !== 'agent-browser' && !executable.endsWith('/agent-browser'))) {
        return null;
    }

    const arguments_ = words.slice(executableIndex + 1);
    const hasCdp = arguments_.some(
        (argument) => argument === '--cdp' || argument.startsWith('--cdp='),
    );
    const hasPinTab = arguments_.some(
        (argument) => argument === '--pin-tab' || argument.startsWith('--pin-tab='),
    );
    let subcommand: string | null = null;
    for (let index = 0; index < arguments_.length; index += 1) {
        const argument = arguments_[index];
        if (argument === '--') {
            subcommand = arguments_[index + 1] ?? null;
            break;
        }
        if (!argument.startsWith('-')) {
            subcommand = argument;
            break;
        }
        const optionName = argument.split('=', 1)[0];
        const isOptionConsumesNext =
            !argument.includes('=') &&
            (AGENT_BROWSER_OPTIONS_WITH_VALUE.has(optionName) ||
                (optionName === '--restore' &&
                    !arguments_[index + 1]?.startsWith('-') &&
                    arguments_[index + 1] !== 'screenshot') ||
                /^(?:true|false)$/u.test(arguments_[index + 1] ?? ''));
        if (isOptionConsumesNext) index += 1;
    }
    return { hasCdp, hasPinTab, subcommand };
};

const agentBrowserInvocations = (command: string): AgentBrowserInvocation[] =>
    executableSegments(command)
        .map(parseAgentBrowserInvocation)
        .filter((invocation): invocation is AgentBrowserInvocation => invocation !== null);

const GIT_GLOBAL_OPTIONS_WITH_VALUE = new Set([
    '--config-env',
    '--exec-path',
    '--git-dir',
    '--namespace',
    '--work-tree',
    '-C',
    '-c',
]);

const isGitWorktreeAdd = (tokens: ShellToken[]): boolean => {
    const words = withoutRedirections(tokens);
    const executableIndex = commandExecutableIndex(words);
    if (executableIndex === null || executableBasename(words[executableIndex]) !== 'git')
        return false;
    let index = executableIndex + 1;
    while (words[index]?.startsWith('-')) {
        const option = words[index];
        index += !option.includes('=') && GIT_GLOBAL_OPTIONS_WITH_VALUE.has(option) ? 2 : 1;
    }
    return words[index] === 'worktree' && words[index + 1] === 'add';
};

const requiresAcceptanceRuntimeOwnership = (command: string): boolean =>
    agentBrowserInvocations(command).some(
        ({ hasPinTab, subcommand }) => hasPinTab || subcommand === 'screenshot',
    );

const isWithinProject = (cwd: string, projectRoot: string): boolean => {
    const relative = path.relative(projectRoot, path.resolve(cwd));
    return relative === '' || (!relative.startsWith(`..${path.sep}`) && relative !== '..');
};

const toolInputFor = (payload: UnknownRecord): UnknownRecord =>
    asRecord(payload.tool_input ?? payload.toolInput);

// eslint-disable-next-line unicorn/no-exports-in-scripts -- Exported for focused hook-policy regression tests.
export const resolveCommandCwd = (value: unknown): string => {
    const payload = asRecord(value);
    const toolInput = toolInputFor(payload);
    const sessionCwd = typeof payload.cwd === 'string' ? payload.cwd : process.cwd();
    const requested = toolInput.workdir ?? toolInput.cwd ?? toolInput.working_directory;
    return typeof requested === 'string'
        ? path.resolve(sessionCwd, requested)
        : path.resolve(sessionCwd);
};

// eslint-disable-next-line unicorn/no-exports-in-scripts -- Exported for focused hook-policy regression tests.
export const evaluateCaxriAcceptanceCommand = ({
    acceptanceRuntimeExists,
    command,
    cwd,
    projectRoot = PROJECT_ROOT,
}: CommandEvaluationInput): GuardAction | null => {
    if (!isWithinProject(cwd, projectRoot)) return null;
    const browserInvocations = agentBrowserInvocations(command);

    if (command === HOOK_SELF_TEST_COMMAND) {
        return {
            ruleId: HOOK_SELF_TEST_COMMAND,
            reason: 'The Caxri project PreToolUse hook is active.',
        };
    }

    if (executableSegments(command).some(isGitWorktreeAdd)) {
        return {
            ruleId: 'caxri-raw-worktree-add',
            reason: 'A raw git worktree add skips dependency installation and the isolated profile, so project hooks, lint, and tests fail in that checkout. Use bun run .agents/skills/switch-worktree/scripts/switch-worktree.ts create <branch> (or reuse) instead.',
        };
    }

    if (
        acceptanceRuntimeExists &&
        browserInvocations.some(({ hasCdp, hasPinTab }) => hasCdp && hasPinTab)
    ) {
        return {
            ruleId: 'caxri-acceptance-pin-tab',
            reason: 'Electron raw CDP does not support the Target.createTarget call used by --pin-tab. Use a unique --session with --no-pin-tab and the owned --cdp port.',
        };
    }

    if (
        acceptanceRuntimeExists &&
        browserInvocations.some(({ subcommand }) => subcommand === 'screenshot')
    ) {
        return {
            ruleId: 'caxri-acceptance-raw-screenshot',
            reason: 'Raw agent-browser screenshot arguments are ambiguous between selector and path. Use bun run .agents/skills/acceptance/scripts/capture-renderer.ts screenshot --output <path>.',
        };
    }

    return null;
};

const serializeDeny = ({ reason, ruleId }: GuardAction): string =>
    JSON.stringify({
        hookSpecificOutput: {
            hookEventName: 'PreToolUse',
            permissionDecision: 'deny',
            permissionDecisionReason: `${reason} Rule: ${ruleId}.`,
        },
    });

const readStdin = (): Promise<string> => text(process.stdin);

// eslint-disable-next-line unicorn/no-exports-in-scripts -- Exported for runtime-ownership regression tests.
export const isOwnedAcceptanceRuntime = async (
    runtimePath = path.join(PROJECT_ROOT, ACCEPTANCE_RUNTIME_PATH),
): Promise<boolean> => {
    let receipt: string;
    try {
        receipt = await readFile(runtimePath, 'utf8');
    } catch (error: unknown) {
        // Only a missing receipt proves no runtime; any other read failure leaves ownership unknown.
        return !(error instanceof Error && 'code' in error && error.code === 'ENOENT');
    }
    /**
     * `runtime-state` needs installed workspace dependencies, so it loads only once a receipt exists. A checkout
     * without `node_modules` cannot run Acceptance and has no receipt; loading it eagerly there failed every Bash call.
     * A failed load with a receipt present rejects, which `runPreToolUse` treats as unknown ownership.
     */
    const { isOwnedRuntime, runtimeStateSchema } = await import('./runtime-state');
    try {
        const parsed = runtimeStateSchema.safeParse(JSON.parse(receipt) as unknown);
        return parsed.success ? await isOwnedRuntime(parsed.data) : false;
    } catch (error: unknown) {
        /**
         * A validated runtime receipt whose process identity cannot be probed is not evidence that the runtime ended.
         * Treat unknown ownership as active so the narrow unsafe-command guards fail closed.
         */
        return !(error instanceof SyntaxError);
    }
};

// eslint-disable-next-line unicorn/no-exports-in-scripts -- Exported for hook input/output regression tests.
export const runPreToolUse = async (
    value: unknown,
    hasOwnedAcceptanceRuntime: () => Promise<boolean> = isOwnedAcceptanceRuntime,
): Promise<string> => {
    const payload = asRecord(value);
    const eventName = payload.hook_event_name ?? payload.hookEventName;
    if (eventName !== 'PreToolUse') return '';
    const toolInput = toolInputFor(payload);
    const command = commandText(toolInput.command ?? toolInput.cmd);
    if (!command) return '';
    const cwd = resolveCommandCwd(payload);
    const unconditionalAction = evaluateCaxriAcceptanceCommand({
        acceptanceRuntimeExists: false,
        command,
        cwd,
    });
    if (unconditionalAction) return serializeDeny(unconditionalAction);
    if (!isWithinProject(cwd, PROJECT_ROOT) || !requiresAcceptanceRuntimeOwnership(command)) {
        return '';
    }
    let hasAcceptanceRuntime = true;
    try {
        hasAcceptanceRuntime = await hasOwnedAcceptanceRuntime();
    } catch {
        // The guarded command must not become allowed merely because the ownership probe failed.
    }
    const action = evaluateCaxriAcceptanceCommand({
        acceptanceRuntimeExists: hasAcceptanceRuntime,
        command,
        cwd,
    });
    return action ? serializeDeny(action) : '';
};

if (import.meta.main) {
    try {
        const input = await readStdin();
        if (input.trim()) process.stdout.write(await runPreToolUse(JSON.parse(input) as unknown));
    } catch (error: unknown) {
        process.exitCode = 1;
        process.stderr.write(
            `Caxri PreToolUse hook failed: ${error instanceof Error ? error.message : String(error)}\n`,
        );
    }
}
