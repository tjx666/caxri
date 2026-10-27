import type { AgentProvider, TerminalRecord } from '@caxri/protocol';
import { defaultAppSettings } from '@caxri/protocol';
import { beforeEach, describe, expect, it, vi } from 'vitest';

const mocks = vi.hoisted(() => ({
    source: '{\n  // keep me\n}\n',
    updateSettings: vi.fn<(input: { source: string }) => Promise<void>>(),
    restartTerminal: vi.fn<(terminalId: string) => void>(),
    restartTerminalWithRecovery: vi.fn<(terminalId: string) => void>(),
}));

vi.mock('../../settings/settings-client', () => ({
    getSettings: () => Promise.resolve({ source: mocks.source }),
    updateSettings: mocks.updateSettings,
}));
vi.mock('../terminal-commands', () => ({
    restartTerminal: mocks.restartTerminal,
    restartTerminalWithRecovery: mocks.restartTerminalWithRecovery,
}));
vi.mock('../../../stores/toasts', () => ({
    tryCommand: async (_title: string, run: () => Promise<void>) => run(),
}));

import {
    dismissLifecycleHookSuggestion,
    enableLifecycleHooks,
    enableLifecycleHooksAndRestart,
    stopSuggestingLifecycleHooks,
    terminalHookSuggestion,
    useTerminalHookSuggestionStore,
} from '../terminal-hook-suggestion-state';

type SuggestionTerminal = Parameters<typeof terminalHookSuggestion>[0]['terminal'];

function agentTerminal(overrides: Partial<TerminalRecord> = {}): SuggestionTerminal {
    return {
        kind: 'claude',
        provider: 'claude',
        lastProcessState: 'running',
        processId: 100,
        ...overrides,
    };
}

function settingsWith(
    hooks: Partial<Record<AgentProvider, boolean>> = {},
    isSuggesting = true,
): Parameters<typeof terminalHookSuggestion>[0]['settings'] {
    const providers = structuredClone(defaultAppSettings['agents.providers']);
    for (const [provider, enabled] of Object.entries(hooks))
        providers[provider as AgentProvider].hooks.enabled = enabled;
    return { 'agents.providers': providers, 'agents.suggestLifecycleHooks': isSuggesting };
}

function suggestion(
    terminal: SuggestionTerminal,
    settings = settingsWith(),
    extra: { isDismissed?: boolean; enabledDuringProcess?: number } = {},
) {
    return terminalHookSuggestion({ isDismissed: false, settings, terminal, ...extra });
}

beforeEach(() => {
    mocks.updateSettings.mockReset().mockResolvedValue(undefined);
    mocks.restartTerminal.mockClear();
    mocks.restartTerminalWithRecovery.mockClear();
    useTerminalHookSuggestionStore.setState({ dismissed: {}, enabledDuringProcess: {} });
});

describe('terminalHookSuggestion', () => {
    it('suggests hooks for a running Terminal Agent whose provider has them off by default', () => {
        expect(suggestion(agentTerminal())).toBe('suggest');
        expect(suggestion(agentTerminal({ kind: 'codex', provider: 'codex' }))).toBe('suggest');
    });

    it('stays quiet for a Chat, a Shell, an Agent that is not running, and a provider with hooks on', () => {
        expect(suggestion(agentTerminal({ surface: 'chat' }))).toBeUndefined();
        expect(suggestion(agentTerminal({ kind: 'shell', provider: undefined }))).toBeUndefined();
        expect(suggestion(agentTerminal({ lastProcessState: 'stopped' }))).toBeUndefined();
        expect(suggestion(agentTerminal(), settingsWith({ claude: true }))).toBeUndefined();
    });

    it('honors a dismissal and "Don\'t ask again"', () => {
        expect(suggestion(agentTerminal(), settingsWith(), { isDismissed: true })).toBeUndefined();
        expect(suggestion(agentTerminal(), settingsWith({}, false))).toBeUndefined();
    });

    it('asks for a restart only while the process that was running when hooks turned on is still running', () => {
        const enabled = settingsWith({ claude: true });
        expect(suggestion(agentTerminal(), enabled, { enabledDuringProcess: 100 })).toBe('restart');
        expect(
            suggestion(agentTerminal({ processId: 101 }), enabled, { enabledDuringProcess: 100 }),
        ).toBeUndefined();
        // The write has not reached the settings snapshot yet: keep suggesting rather than claim a restart applies.
        expect(suggestion(agentTerminal(), settingsWith(), { enabledDuringProcess: 100 })).toBe(
            'suggest',
        );
    });

    it('offers Grok Build its required hooks after a failed launch, even with suggestions off', () => {
        const grok = agentTerminal({
            kind: 'grok',
            provider: 'grok',
            lastProcessState: 'failed',
            failureReason: 'spawn_failed',
        });
        expect(suggestion(grok, settingsWith({}, false), { isDismissed: true })).toBe('required');
        expect(suggestion({ ...grok, failureReason: 'executable_not_found' })).toBeUndefined();
        expect(suggestion({ ...grok, lastProcessState: 'running' })).toBeUndefined();
        expect(suggestion(grok, settingsWith({ grok: true }))).toBeUndefined();
    });
});

describe('lifecycle hook suggestion commands', () => {
    it('turns the provider hooks on in settings.jsonc, keeping comments, and remembers the running process', async () => {
        enableLifecycleHooks('terminal-1', 'codex', 100);
        await vi.waitFor(() => expect(mocks.updateSettings).toHaveBeenCalledOnce());
        const { source } = mocks.updateSettings.mock.calls[0][0];
        expect(source).toContain('// keep me');
        expect(source).toMatch(
            /"agents\.providers":\s*\{\s*"codex":\s*\{\s*"hooks":\s*\{\s*"enabled": true/u,
        );
        await vi.waitFor(() =>
            expect(useTerminalHookSuggestionStore.getState().enabledDuringProcess).toEqual({
                'terminal-1': 100,
            }),
        );
        expect(mocks.restartTerminal).not.toHaveBeenCalled();
    });

    it('restarts a Terminal that could not start only after the hooks are on', async () => {
        enableLifecycleHooksAndRestart('terminal-1', 'grok');
        await vi.waitFor(() =>
            expect(mocks.restartTerminalWithRecovery).toHaveBeenCalledWith('terminal-1'),
        );
        expect(mocks.updateSettings.mock.invocationCallOrder[0]).toBeLessThan(
            mocks.restartTerminalWithRecovery.mock.invocationCallOrder[0],
        );
    });

    it('writes "Don\'t ask again" as the agents.suggestLifecycleHooks setting', async () => {
        stopSuggestingLifecycleHooks();
        await vi.waitFor(() => expect(mocks.updateSettings).toHaveBeenCalledOnce());
        expect(mocks.updateSettings.mock.calls[0][0].source).toMatch(
            /"agents\.suggestLifecycleHooks": false/u,
        );
    });

    it('dismisses one Terminal and forgets its pending restart', () => {
        useTerminalHookSuggestionStore.setState({ enabledDuringProcess: { 'terminal-1': 100 } });
        dismissLifecycleHookSuggestion('terminal-1');
        const state = useTerminalHookSuggestionStore.getState();
        expect(state.dismissed).toEqual({ 'terminal-1': true });
        expect(state.enabledDuringProcess['terminal-1']).toBeUndefined();
    });
});
