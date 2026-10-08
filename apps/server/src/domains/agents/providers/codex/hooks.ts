import { isAbsolute, join } from 'node:path';

import type { AgentHookAdapter, AgentHookDocuments } from '../../hooks/contract';
import { inspectJsonHooks, removeJsonHooks, renderJsonHooks } from '../../hooks/json-config';

const HOOKS_TARGET = 'hooks';
const CONFIG_TARGET = 'config';
/**
 * Codex documents `PreCompact` and `PostCompact` as the exact boundaries around automatic or manual context compaction:
 * https://learn.chatgpt.com/docs/hooks#precompact and https://learn.chatgpt.com/docs/hooks#postcompact
 */
const bindings = [
    /**
     * `SessionStart` fires for startup, resume, clear, and compact. Unlike `UserPromptSubmit`, it also covers resumes
     * followed only by a slash command, so Caxri can bind the exact thread before the first ordinary prompt.
     */
    { event: 'SessionStart', phase: 'sessionIdentified' },
    { event: 'UserPromptSubmit', phase: 'turnStarted' },
    { event: 'PermissionRequest', phase: 'attentionRequested' },
    { event: 'Stop', phase: 'turnFinished', reply: 'emptyJson' },
    { event: 'PreToolUse', matcher: '^Bash$', phase: 'shellToolStarted' },
    { event: 'PostToolUse', matcher: '^Bash$', phase: 'shellToolFinished' },
    { event: 'PreCompact', phase: 'compactionStarted' },
    { event: 'PostCompact', phase: 'compactionFinished' },
] as const;

function codexHome(homeDirectory: string, configured: string | undefined): string {
    if (!configured) return join(homeDirectory, '.codex');
    return isAbsolute(configured) ? configured : join(homeDirectory, configured);
}

function hasInlineHooks(source: string | undefined): boolean {
    if (source === undefined) return false;
    for (const line of source.split(/\r?\n/)) {
        const section = line.match(/^\s*\[\[?([^\]]+)\]\]?\s*(?:#.*)?$/)?.[1]?.trim();
        if (!section) continue;
        if (section !== 'hooks' && !section.startsWith('hooks.')) continue;
        /**
         * `[hooks.state]` (and its per-hook subtables) is Codex's own approval bookkeeping: the trusted hashes it
         * records for hooks installed in `hooks.json`, including the managed ones. Treating it as a user-defined inline
         * hook would permanently block the managed install that produced those very records.
         */
        if (section === 'hooks.state' || section.startsWith('hooks.state.')) continue;
        return true;
    }
    return false;
}

function disabledHookPolicy(source: string | undefined): string | undefined {
    if (!source) return undefined;
    if (/^\s*allow_managed_hooks_only\s*=\s*true\s*(?:#.*)?$/m.test(source))
        return 'Codex allows only managed hooks in config.toml';
    let isFeatures = false;
    for (const line of source.split(/\r?\n/)) {
        const section = line.match(/^\s*\[([^\]]+)\]\s*(?:#.*)?$/)?.[1];
        if (section) {
            isFeatures = section === 'features';
            continue;
        }
        if (isFeatures && /^\s*(?:hooks|codex_hooks)\s*=\s*false\s*(?:#.*)?$/.test(line))
            return 'Codex hooks are disabled in config.toml';
    }
    return undefined;
}

function hooksSource(documents: AgentHookDocuments): string | undefined {
    return documents.get(HOOKS_TARGET);
}

export const codexHookAdapter: AgentHookAdapter = {
    bindings,
    // Digest capture is launch-environment opt-in; unchanged hook commands must retain their existing trust identity.
    schemaVersion: 8,
    configTargets: (environment) => {
        const home = codexHome(environment.homeDirectory, environment.variables.CODEX_HOME);
        return [
            { id: HOOKS_TARGET, path: join(home, 'hooks.json'), writable: true },
            { id: CONFIG_TARGET, path: join(home, 'config.toml'), writable: false },
        ];
    },
    inspect: (documents, desired) => {
        const policyConflict = disabledHookPolicy(documents.get(CONFIG_TARGET));
        if (policyConflict)
            return { status: { kind: 'conflict' as const, message: policyConflict } };
        if (hasInlineHooks(documents.get(CONFIG_TARGET)))
            return {
                status: {
                    kind: 'conflict',
                    message: 'Codex already defines inline hooks in config.toml',
                },
            };
        return { status: inspectJsonHooks(hooksSource(documents), desired, bindings) };
    },
    remove: (documents, desired) => removeJsonHooks(HOOKS_TARGET, hooksSource(documents), desired),
    render: (documents, desired) => [
        renderJsonHooks(HOOKS_TARGET, hooksSource(documents), desired, bindings),
    ],
    supports: () => ({ supported: true, phases: bindings.map((binding) => binding.phase) }),
};
