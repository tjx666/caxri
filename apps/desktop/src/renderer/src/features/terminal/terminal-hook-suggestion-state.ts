import type { AgentProvider, AppSettings, TerminalRecord } from '@caxri/protocol';
import { agentProviderCatalog, isChatTerminal } from '@caxri/protocol';
import { create } from 'zustand';

import { translate } from '../../i18n';
import { tryCommand } from '../../stores/toasts';
import { applyFormEdit } from '../settings/config-edit';
import { getSettings, updateSettings } from '../settings/settings-client';
import { restartTerminal, restartTerminalWithRecovery } from './terminal-commands';

/**
 * What a Terminal pane says about its provider's lifecycle hooks:
 *
 * - `suggest`: an Agent runs in this Terminal without them; offer to turn them on.
 * - `restart`: they were turned on from this pane while this process was already running, so it has no hook credentials
 *   until it restarts.
 * - `required`: the provider cannot start in a Terminal without them (Grok Build) and this launch failed for that.
 */
export type TerminalHookSuggestion = 'required' | 'restart' | 'suggest';

interface TerminalHookSuggestionState {
    /**
     * Terminals whose suggestion the user closed for now. In memory only: the next Caxri launch asks again unless the
     * user chose "Don't ask again", which is the `agents.suggestLifecycleHooks` setting.
     */
    dismissed: Record<string, true | undefined>;
    /**
     * The process each Terminal was running when the user turned hooks on from its pane. A different process (restarted
     * from here, the tab menu, or anywhere else) was launched with the hooks and needs no restart prompt.
     */
    enabledDuringProcess: Record<string, number | undefined>;
}

export const useTerminalHookSuggestionStore = create<TerminalHookSuggestionState>(() => ({
    dismissed: {},
    enabledDuringProcess: {},
}));

export interface TerminalHookSuggestionInput {
    terminal: Pick<
        TerminalRecord,
        'failureReason' | 'kind' | 'lastProcessState' | 'processId' | 'provider' | 'surface'
    >;
    settings: Pick<AppSettings, 'agents.providers' | 'agents.suggestLifecycleHooks'>;
    isDismissed: boolean;
    /**
     * `enabledDuringProcess` for this Terminal, when the user turned hooks on from its pane.
     */
    enabledDuringProcess?: number;
}

/**
 * Pure decision behind the pane row; see {@link TerminalHookSuggestion}. A Chat never shows it: Agent Chat reports
 * through its provider protocol, not lifecycle hooks.
 */
export function terminalHookSuggestion({
    enabledDuringProcess,
    isDismissed,
    settings,
    terminal,
}: TerminalHookSuggestionInput): TerminalHookSuggestion | undefined {
    const provider = terminal.provider ?? (terminal.kind === 'shell' ? undefined : terminal.kind);
    if (!provider || isChatTerminal(terminal)) return undefined;
    const isEnabled = settings['agents.providers'][provider].hooks.enabled;
    if (isEnabled)
        return enabledDuringProcess !== undefined &&
            terminal.lastProcessState === 'running' &&
            terminal.processId === enabledDuringProcess
            ? 'restart'
            : undefined;
    if (agentProviderCatalog[provider].requiresLifecycleHooks)
        /**
         * The launch failure has no closed reason of its own (the Terminal failure enum is a database constraint), but
         * with the hooks off every launch of this provider fails on them before the spawn, so `spawn_failed` is that.
         */
        return terminal.lastProcessState === 'failed' && terminal.failureReason === 'spawn_failed'
            ? 'required'
            : undefined;
    if (isDismissed || !settings['agents.suggestLifecycleHooks']) return undefined;
    return terminal.lastProcessState === 'running' ? 'suggest' : undefined;
}

function hooksPath(provider: AgentProvider): string[] {
    return ['agents.providers', provider, 'hooks', 'enabled'];
}

async function writeHooksEnabled(provider: AgentProvider): Promise<void> {
    const { source } = await getSettings();
    // `settings.update` resolves only after the hook manager has reconciled, so a launch right after it gets the hooks.
    await updateSettings({ source: applyFormEdit(source, hooksPath(provider), true) });
}

/**
 * "Enable" on a running Agent: turns the provider's hooks on through `settings.jsonc`, the same file the Settings row
 * writes, then asks for a restart instead of restarting on its own, because ending the user's current turn is theirs to
 * decide.
 */
export function enableLifecycleHooks(
    terminalId: string,
    provider: AgentProvider,
    processId: number | undefined,
): void {
    void tryCommand(translate('terminal.hookSuggestion.enableFailed'), async () => {
        await writeHooksEnabled(provider);
        useTerminalHookSuggestionStore.setState((state) => ({
            enabledDuringProcess: { ...state.enabledDuringProcess, [terminalId]: processId },
        }));
    });
}

/**
 * "Enable and Restart" on a Terminal that could not start without hooks: nothing is running, so there is no turn to
 * protect.
 */
export function enableLifecycleHooksAndRestart(terminalId: string, provider: AgentProvider): void {
    void tryCommand(translate('terminal.hookSuggestion.enableFailed'), async () => {
        await writeHooksEnabled(provider);
        restartTerminalWithRecovery(terminalId);
    });
}

/**
 * The restart the `restart` row offers: the guarded "Restart Agent", which asks before ending a running turn.
 */
export function restartForLifecycleHooks(terminalId: string): void {
    restartTerminal(terminalId);
}

export function dismissLifecycleHookSuggestion(terminalId: string): void {
    useTerminalHookSuggestionStore.setState((state) => ({
        dismissed: { ...state.dismissed, [terminalId]: true },
        enabledDuringProcess: { ...state.enabledDuringProcess, [terminalId]: undefined },
    }));
}

/**
 * "Don't ask again": turns `agents.suggestLifecycleHooks` off, which the Settings page shows and can turn back on.
 */
export function stopSuggestingLifecycleHooks(): void {
    void tryCommand(translate('terminal.hookSuggestion.dontAskAgainFailed'), async () => {
        const { source } = await getSettings();
        await updateSettings({
            source: applyFormEdit(source, ['agents.suggestLifecycleHooks'], false),
        });
    });
}
