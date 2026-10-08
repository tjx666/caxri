import type { AgentProvider } from '@caxri/protocol';
import { agentProviderCatalog, defaultAgentProviderSettings } from '@caxri/protocol';
import { expandLaunchArguments } from '@caxri/utils';

/**
 * Whether the Agent acts without asking is not a stored preference: it is exactly whether the provider's autonomy
 * tokens sit in its launch arguments. Keeping the Settings switch derived over the same list the user can hand-edit
 * means one source of truth, so a raw edit and the switch can never disagree.
 */

/**
 * Grok Build documents `--always-approve` as the flag and `--yolo` as its alias. The catalog ships `--yolo` so Settings
 * shows the named YOLO mode; this alias still counts as the same bypass so a persisted longer flag cannot stay behind
 * after the switch is turned off.
 */
const GROK_AUTONOMY_ALIASES: ReadonlyArray<readonly string[]> = [['--always-approve']];

/**
 * Index of the first contiguous occurrence of `run` inside the launch arguments at or after `from`, or -1. Autonomy
 * tokens are matched as one run so a flag/value pair can never be half-matched or half-removed.
 */
function indexOfRun(arguments_: readonly string[], run: readonly string[], from: number): number {
    for (let start = from; start + run.length <= arguments_.length; start += 1) {
        if (run.every((token, offset) => arguments_[start + offset] === token)) return start;
    }
    return -1;
}

function autonomyRuns(provider: AgentProvider): ReadonlyArray<readonly string[]> {
    const run = agentProviderCatalog[provider].autonomyArgs;
    return provider === 'grok' ? [run, ...GROK_AUTONOMY_ALIASES] : [run];
}

/**
 * Whether these launch arguments already start `provider` without per-action approval.
 */
export function hasProviderAutonomy(
    arguments_: readonly string[],
    provider: AgentProvider,
): boolean {
    const tokens = expandLaunchArguments(arguments_);
    return autonomyRuns(provider).some((run) => indexOfRun(tokens, run, 0) !== -1);
}

/**
 * Whether the shipped default launches `provider` without per-action approval, so the Settings row can report and
 * restore its own default without restating the token list.
 */
export function hasDefaultProviderAutonomy(provider: AgentProvider): boolean {
    return hasProviderAutonomy(defaultAgentProviderSettings[provider].launch.args, provider);
}

/**
 * These launch arguments with `provider`'s autonomy tokens present or absent, leaving every other argument (including a
 * confinement argument such as Grok Build's `--sandbox workspace`) in place and in its original order.
 *
 * Turning autonomy on when it is already on returns the arguments untouched rather than duplicating or re-positioning
 * the tokens; turning it on otherwise prepends them, the position the shipped defaults use. Turning it off drops every
 * occurrence, so a hand-edited duplicate cannot survive as a silent bypass.
 */
export function withProviderAutonomy(
    arguments_: readonly string[],
    provider: AgentProvider,
    isEnabled: boolean,
): string[] {
    const run = agentProviderCatalog[provider].autonomyArgs;
    const tokens = expandLaunchArguments(arguments_);
    if (isEnabled) return hasProviderAutonomy(tokens, provider) ? [...tokens] : [...run, ...tokens];
    const next = [...tokens];
    for (const candidate of autonomyRuns(provider)) {
        for (
            let at = indexOfRun(next, candidate, 0);
            at !== -1;
            at = indexOfRun(next, candidate, at)
        ) {
            next.splice(at, candidate.length);
        }
    }
    return next;
}
