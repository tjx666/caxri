#!/usr/bin/env bun

import { readFile } from 'node:fs/promises';
import path from 'node:path';
import process from 'node:process';
import { text } from 'node:stream/consumers';
import { fileURLToPath } from 'node:url';

import { errorCode, isOwnedRuntime, runtimeStateSchema } from './runtime-state';

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

const asRecord = (value: unknown): UnknownRecord =>
    typeof value === 'object' && value !== null ? (value as UnknownRecord) : {};

const compact = (value: unknown): string =>
    typeof value === 'string' ? value.replaceAll(/\s+/gu, ' ').trim() : '';

const isAgentBrowserCommand = (command: string): boolean =>
    /(?:^|[;&|()\s])agent-browser(?:\s|$)/u.test(command);

const requiresAcceptanceRuntimeOwnership = (command: string): boolean =>
    isAgentBrowserCommand(command) &&
    (/(?:^|\s)--pin-tab(?:=|\s|$)/u.test(command) || /\bscreenshot\b/u.test(command));

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

    if (
        acceptanceRuntimeExists &&
        isAgentBrowserCommand(command) &&
        /(?:^|\s)--cdp(?:=|\s)/u.test(command) &&
        /(?:^|\s)--pin-tab(?:=|\s|$)/u.test(command)
    ) {
        return {
            ruleId: 'caxri-acceptance-pin-tab',
            reason: 'Electron raw CDP does not support the Target.createTarget call used by --pin-tab. Use a unique --session with --no-pin-tab and the owned --cdp port.',
        };
    }

    if (
        acceptanceRuntimeExists &&
        isAgentBrowserCommand(command) &&
        /\bscreenshot\b/u.test(command)
    ) {
        return {
            ruleId: 'caxri-acceptance-raw-screenshot',
            reason: 'Raw agent-browser screenshot arguments are ambiguous between selector and path. Use bun run .agents/skills/acceptance/scripts/capture-renderer.ts screenshot --output <path>.',
        };
    }

    if (
        /\.agents\/skills\/go\/scripts\/state\.ts\s+acceptance(?:\s|$)/u.test(command) &&
        /(?:^|\s)--round(?:=|\s|$)/u.test(command)
    ) {
        return {
            ruleId: 'caxri-acceptance-manual-round',
            reason: 'The ordinary Acceptance status command cannot advance rounds. Use state.ts acceptance-publish; use acceptance-reconcile-round only to repair recorded ledger drift.',
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
    try {
        const raw: unknown = JSON.parse(await readFile(runtimePath, 'utf8'));
        const parsed = runtimeStateSchema.safeParse(raw);
        return parsed.success ? await isOwnedRuntime(parsed.data) : false;
    } catch (error: unknown) {
        const isMissingOrMalformed = error instanceof SyntaxError || errorCode(error) === 'ENOENT';
        /**
         * A validated runtime receipt whose process identity cannot be probed is not evidence that the runtime ended.
         * Treat unknown ownership as active so the narrow unsafe-command guards fail closed.
         */
        return !isMissingOrMalformed;
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
    const command = compact(toolInput.command ?? toolInput.cmd);
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
