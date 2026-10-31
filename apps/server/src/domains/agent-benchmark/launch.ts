import type { AgentLaunchSettings, AgentProvider, BenchmarkEntry } from '@caxri/protocol';
import { agentProviderCatalog } from '@caxri/protocol';

/**
 * The launch settings one Benchmark Attempt starts its provider with: the user's configured executable, the provider's
 * autonomy flag so the Agent never waits for an approval nobody will give, and the Entry's model and effort. The user's
 * other TUI arguments are deliberately dropped, because a model or profile they pin would silently replace the
 * Entry's.
 *
 * Effort travels where each provider accepts it at launch: Codex as a `model_reasoning_effort` config override, Grok
 * Build as `--reasoning-effort`. Claude Code takes effort only after start, and Antigravity both model and effort, so
 * the Attempt applies them through the Chat driver's model switch instead.
 */
export function benchmarkLaunchSettings(
    entry: BenchmarkEntry,
    configured: AgentLaunchSettings,
): AgentLaunchSettings {
    const autonomy = agentProviderCatalog[entry.provider].autonomyArgs[0];
    return {
        executable: configured.executable,
        args: [autonomy, ...modelArguments(entry.provider, entry.model), ...effortArguments(entry)],
    };
}

function modelArguments(provider: AgentProvider, model: string): string[] {
    // `agy acp` takes the model only through `session/set_config_option`, which the Attempt applies after start.
    if (provider === 'antigravity') return [];
    return provider === 'codex' ? ['-m', model] : ['--model', model];
}

function effortArguments({ provider, effort }: BenchmarkEntry): string[] {
    if (!effort) return [];
    if (provider === 'codex') return ['-c', `model_reasoning_effort="${effort}"`];
    if (provider === 'grok') return ['--reasoning-effort', effort];
    return [];
}

/**
 * Launch settings for a short-lived catalog probe: autonomy only, so the provider reports its own default model.
 */
export function probeLaunchSettings(
    provider: AgentProvider,
    configured: AgentLaunchSettings,
): AgentLaunchSettings {
    return {
        executable: configured.executable,
        args: [agentProviderCatalog[provider].autonomyArgs[0]],
    };
}
