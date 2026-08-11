import { isAbsolute, join } from 'node:path';

import type { AgentHookAdapter, AgentHookDocuments } from '../../hooks/contract';
import { inspectJsonHooks, removeJsonHooks, renderJsonHooks } from '../../hooks/json-config';

const HOOKS_TARGET = 'hooks';
const CONFIG_TARGET = 'config';
const bindings = [
    { event: 'UserPromptSubmit', phase: 'turnStarted' },
    { event: 'PermissionRequest', phase: 'attentionRequested' },
    { event: 'Stop', phase: 'turnFinished', reply: 'emptyJson' },
] as const;

function codexHome(homeDirectory: string, configured: string | undefined): string {
    if (!configured) return join(homeDirectory, '.codex');
    return isAbsolute(configured) ? configured : join(homeDirectory, configured);
}

function hasInlineHooks(source: string | undefined): boolean {
    return source !== undefined && /^\s*\[\[?hooks(?:\.|\]\]?)/m.test(source);
}

function disabledHookPolicy(source: string | undefined): string | undefined {
    if (!source) return undefined;
    if (/^\s*allow_managed_hooks_only\s*=\s*true\s*(?:#.*)?$/m.test(source))
        return 'Codex allows only managed hooks in config.toml';
    let features = false;
    for (const line of source.split(/\r?\n/)) {
        const section = line.match(/^\s*\[([^\]]+)\]\s*(?:#.*)?$/)?.[1];
        if (section) {
            features = section === 'features';
            continue;
        }
        if (features && /^\s*(?:hooks|codex_hooks)\s*=\s*false\s*(?:#.*)?$/.test(line))
            return 'Codex hooks are disabled in config.toml';
    }
    return undefined;
}

function hooksSource(documents: AgentHookDocuments): string | undefined {
    return documents.get(HOOKS_TARGET);
}

export const codexHookAdapter: AgentHookAdapter = {
    bindings,
    schemaVersion: 1,
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
