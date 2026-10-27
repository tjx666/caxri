import type { AgentProvider } from '@caxri/protocol';
import { readBoundedRegularFileText } from '@caxri/system';

import type {
    AgentHookAdapter,
    AgentHookConfigTarget,
    AgentHookDocuments,
} from '../apps/server/src/domains/agents/hooks/contract';
import { MAX_AGENT_HOOK_CONFIG_BYTES } from '../apps/server/src/domains/agents/hooks/manager';
import { claudeHookAdapter } from '../apps/server/src/domains/agents/providers/claude/hooks';
import { codexHookAdapter } from '../apps/server/src/domains/agents/providers/codex/hooks';
import { grokHookAdapter } from '../apps/server/src/domains/agents/providers/grok/hooks';

/**
 * Every provider whose shared config Caxri writes hook entries into. The adapters are the same modules Server Core
 * uses, so the uninstaller recognises exactly the entries a Caxri build installed and never touches foreign hooks.
 */
const HOOK_ADAPTERS: ReadonlyArray<{ adapter: AgentHookAdapter; provider: AgentProvider }> = [
    { adapter: claudeHookAdapter, provider: 'claude' },
    { adapter: codexHookAdapter, provider: 'codex' },
    { adapter: grokHookAdapter, provider: 'grok' },
];

/**
 * Provider variables that relocate a hook config (`CLAUDE_CONFIG_DIR`, `CODEX_HOME`, `GROK_HOME`). Only these are
 * copied out of the process environment so the uninstall options stay small and deterministic.
 */
export const HOOK_CONFIG_VARIABLES = ['CLAUDE_CONFIG_DIR', 'CODEX_HOME', 'GROK_HOME'] as const;

export interface HookConfigCleanup {
    path: string;
    provider: AgentProvider;
    /**
     * The config with every Caxri-owned hook entry removed and every foreign entry preserved byte for byte.
     */
    source: string;
}

interface HookCleanupEnvironment {
    homeDirectory: string;
    variables: NodeJS.ProcessEnv;
}

function fileSystemCode(error: unknown): string | undefined {
    return typeof error === 'object' && error !== null && 'code' in error
        ? String(Reflect.get(error, 'code'))
        : undefined;
}

export async function readOptionalHookConfig(path: string): Promise<string | undefined> {
    try {
        return await readBoundedRegularFileText(path, MAX_AGENT_HOOK_CONFIG_BYTES);
    } catch (error) {
        if (fileSystemCode(error) === 'ENOENT') return undefined;
        throw error;
    }
}

function cleanupsFor(
    adapter: AgentHookAdapter,
    provider: AgentProvider,
    targets: readonly AgentHookConfigTarget[],
    documents: AgentHookDocuments,
): HookConfigCleanup[] {
    /**
     * The schema ordering token that stops one running build from rewriting a newer build's entries does not apply to
     * an explicit uninstall, which must remove the entries of any build; the desired schema is therefore unbounded.
     */
    const edits = adapter.remove(documents, {
        bridgePath: '',
        provider,
        schemaVersion: Number.MAX_SAFE_INTEGER,
    });
    const cleanups: HookConfigCleanup[] = [];
    for (const edit of edits) {
        const target = targets.find((candidate) => candidate.id === edit.targetId);
        if (target?.writable && edit.source !== documents.get(edit.targetId))
            cleanups.push({ path: target.path, provider, source: edit.source });
    }
    return cleanups;
}

/**
 * Caxri registers its Agent hook bridge in shared provider configs (`~/.claude/settings.json`, Codex's `hooks.json`,
 * Grok's `hooks/caxri.json`). Archiving the profile takes the bridge binary with it, so entries left behind make every
 * later Agent session fail its hooks with "command not found". The uninstaller therefore strips every Caxri-owned entry
 * while leaving foreign hooks untouched. A development Host kept alive by `--keep-dev` may reinstall the entries on its
 * next reconcile, which is correct because it also re-stages the bridge they point at.
 */
export async function planHookConfigCleanups(
    environment: HookCleanupEnvironment,
    readTextFile: (path: string) => Promise<string | undefined>,
): Promise<HookConfigCleanup[]> {
    const perProvider = await Promise.all(
        HOOK_ADAPTERS.map(async ({ adapter, provider }) => {
            const targets = adapter.configTargets(environment);
            const entries = await Promise.all(
                targets.map(
                    async (target) => [target.id, await readTextFile(target.path)] as const,
                ),
            );
            return cleanupsFor(adapter, provider, targets, new Map(entries));
        }),
    );
    return perProvider.flat();
}
