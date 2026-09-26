import { isAbsolute, join } from 'node:path';

import type { ParseError } from 'jsonc-parser';
import { parse } from 'jsonc-parser';

import type { AgentHookAdapter, AgentHookDocuments } from '../../hooks/contract';
import { inspectJsonHooks, removeJsonHooks, renderJsonHooks } from '../../hooks/json-config';

const SETTINGS_TARGET = 'settings';
const bindings = [
    { event: 'UserPromptSubmit', phase: 'turnStarted' },
    { event: 'SubagentStart', phase: 'subagentStarted' },
    { event: 'PermissionRequest', phase: 'attentionRequested', interactive: 'permission' },
    {
        event: 'PreToolUse',
        matcher: '^AskUserQuestion$',
        phase: 'attentionRequested',
        interactive: 'question',
    },
    { event: 'Stop', phase: 'turnFinished', reply: 'emptyJson' },
    { event: 'StopFailure', phase: 'turnFinished' },
    { event: 'SubagentStop', phase: 'turnFinished', reply: 'emptyJson' },
    { event: 'PreToolUse', matcher: '^Bash$', phase: 'shellToolStarted' },
    { event: 'PostToolUse', matcher: '^Bash$', phase: 'shellToolFinished' },
    { event: 'PostToolUseFailure', matcher: '^Bash$', phase: 'shellToolFailed' },
    /**
     * Claude Code exposes no event immediately after a human grants permission. The matching tool result is the first
     * reliable public boundary that proves the turn resumed. PermissionRequest deliberately omits `tool_use_id`, while
     * PostToolBatch fires once only after every parallel call resolves; `agent_id` isolates inherited subagent hooks.
     *
     * @see https://code.claude.com/docs/en/hooks#permissionrequest-input
     * @see https://code.claude.com/docs/en/hooks#posttoolbatch
     */
    { event: 'PostToolBatch', phase: 'toolBatchFinished' },
] as const;

function claudeHome(homeDirectory: string, configured: string | undefined): string {
    if (!configured) return join(homeDirectory, '.claude');
    return isAbsolute(configured) ? configured : join(homeDirectory, configured);
}

function settingsSource(documents: AgentHookDocuments): string | undefined {
    return documents.get(SETTINGS_TARGET);
}

function disabledHookPolicy(source: string | undefined): string | undefined {
    if (!source) return undefined;
    const errors: ParseError[] = [];
    const parsed: unknown = parse(source, errors, {
        allowTrailingComma: true,
        disallowComments: false,
    });
    if (parsed === null || typeof parsed !== 'object' || errors.length > 0) return undefined;
    const settings = parsed as Record<string, unknown>;
    if (settings.allowManagedHooksOnly === true)
        return 'Claude Code allows only managed hooks in settings.json';
    return settings.disableAllHooks === true
        ? 'Claude Code hooks are disabled in settings.json'
        : undefined;
}

export const claudeHookAdapter: AgentHookAdapter = {
    bindings,
    schemaVersion: 10,
    configTargets: (environment) => [
        {
            id: SETTINGS_TARGET,
            path: join(
                claudeHome(environment.homeDirectory, environment.variables.CLAUDE_CONFIG_DIR),
                'settings.json',
            ),
            writable: true,
        },
    ],
    inspect: (documents, desired) => {
        const policyConflict = disabledHookPolicy(settingsSource(documents));
        return {
            status: policyConflict
                ? { kind: 'conflict', message: policyConflict }
                : inspectJsonHooks(settingsSource(documents), desired, bindings),
        };
    },
    remove: (documents, desired) =>
        removeJsonHooks(SETTINGS_TARGET, settingsSource(documents), desired),
    render: (documents, desired) => [
        renderJsonHooks(SETTINGS_TARGET, settingsSource(documents), desired, bindings),
    ],
    supports: () => ({ supported: true, phases: bindings.map((binding) => binding.phase) }),
};
