import { join } from 'node:path';

import type { AgentHookAdapter } from '../../hooks/contract';
import { inspectJsonHooks, removeJsonHooks, renderJsonHooks } from '../../hooks/json-config';
import { grokHome } from './paths';

const bindings = [
    { event: 'SessionStart', phase: 'sessionIdentified' },
    { event: 'UserPromptSubmit', phase: 'turnStarted' },
    { event: 'Stop', phase: 'turnFinished' },
    { event: 'StopFailure', phase: 'turnFailed' },
    { event: 'StopCancelled', phase: 'turnFailed' },
] as const;
const target = 'hooks';

/**
 * The public hook contract was verified against Grok Build 1.0.24.
 */
export function isGrokVersionSupported(version: string | undefined): boolean {
    const match = version?.match(/\b1\.(\d+)\.(\d+)\b/);
    return Boolean(match && (Number(match[1]) > 0 || Number(match[2]) >= 24));
}

export const grokHookAdapter: AgentHookAdapter = {
    bindings,
    schemaVersion: 2,
    configTargets: (environment) => [
        {
            id: target,
            path: join(grokHome(environment), 'hooks', 'caxri.json'),
            writable: true,
        },
    ],
    inspect: (documents, desired) => ({
        status: inspectJsonHooks(documents.get(target), desired, bindings),
    }),
    remove: (documents, desired) => removeJsonHooks(target, documents.get(target), desired),
    render: (documents, desired) => [
        renderJsonHooks(target, documents.get(target), desired, bindings),
    ],
    supports: (version) => ({
        /**
         * Installation inspects config without a CLI version; managed launches enforce the version before spawn.
         */
        supported: version === undefined || isGrokVersionSupported(version),
        phases: bindings.map((binding) => binding.phase),
        reason:
            version === undefined || isGrokVersionSupported(version)
                ? undefined
                : 'Grok Build 1.0.24 or later in major version 1 is required',
    }),
};
