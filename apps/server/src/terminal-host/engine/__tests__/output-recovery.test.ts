import type { AgentOutputRecoverySettings, AgentProvider } from '@caxri/protocol';
import type { StructuredLogger } from '@caxri/system';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { AgentOutputRecovery } from '../output-recovery';
import { ensureLiveOutputRecovery, hasConfiguredOutputRecovery } from '../output-recovery-manager';
import type { LiveTerminal } from '../types';

function enabledSettings(): AgentOutputRecoverySettings {
    return {
        enabled: true,
        patterns: ['API timeout'],
        settleDelayMs: 250,
        continueDelayMs: 300,
    };
}

function createRecovery(
    overrides: {
        current?: () => boolean;
        provider?: AgentProvider;
        settings?: AgentOutputRecoverySettings;
        tail?: () => Promise<{ beforeCursorLine: string; cursorLine: string; full: string }>;
    } = {},
) {
    let settings = overrides.settings ?? enabledSettings();
    let tail = 'API timeout';
    const write = vi.fn(() => true);
    const onStatus = vi.fn();
    const loggerWrite = vi.fn<StructuredLogger['write']>();
    const logger = { write: loggerWrite } as unknown as StructuredLogger;
    const recovery = new AgentOutputRecovery({
        terminalId: 'terminal-1',
        provider: overrides.provider ?? 'codex',
        logger,
        getSettings: () => settings,
        isCurrent: overrides.current ?? (() => true),
        readTail:
            overrides.tail ??
            (() => Promise.resolve({ beforeCursorLine: tail, cursorLine: '', full: tail })),
        write,
        onStatus,
    });
    return {
        logger,
        loggerWrite,
        onStatus,
        recovery,
        setSettings: (next: AgentOutputRecoverySettings) => {
            settings = next;
        },
        setTail: (next: string) => {
            tail = next;
        },
        write,
    };
}

beforeEach(() => vi.useFakeTimers());
afterEach(() => vi.useRealTimers());

describe('AgentOutputRecovery', () => {
    it('stays inert until the provider setting is explicitly enabled', async () => {
        const capacityMessage = '⚠ Selected model is at capacity. Please try a different model.';
        const fixture = createRecovery({
            provider: 'claude',
            settings: { ...enabledSettings(), enabled: false, patterns: [] },
            tail: () =>
                Promise.resolve({
                    beforeCursorLine: capacityMessage,
                    cursorLine: '❯',
                    full: `${capacityMessage}\n❯`,
                }),
        });

        fixture.recovery.observeOutput();
        await vi.advanceTimersByTimeAsync(2_000);

        expect(fixture.write).not.toHaveBeenCalled();
        expect(fixture.onStatus).not.toHaveBeenCalled();
    });

    it('matches the stable parsed suffix and sends Escape before continue', async () => {
        const fixture = createRecovery();

        fixture.recovery.observeOutput();
        await vi.advanceTimersByTimeAsync(249);
        expect(fixture.write).not.toHaveBeenCalled();
        await vi.advanceTimersByTimeAsync(1);
        expect(fixture.write).toHaveBeenCalledWith('\u{1B}');
        await vi.advanceTimersByTimeAsync(299);
        expect(fixture.write).toHaveBeenCalledTimes(1);
        await vi.advanceTimersByTimeAsync(1);

        expect(fixture.write.mock.calls).toEqual([['\u{1B}'], ['continue\r']]);
        expect(fixture.onStatus).toHaveBeenCalledWith('recovered');
        expect(fixture.loggerWrite).toHaveBeenCalledWith('info', 'pty.output_recovery_completed', {
            fields: {
                provider: 'codex',
                ruleIndex: 0,
                ruleSource: 'custom',
                terminalId: 'terminal-1',
            },
        });
    });

    it('recovers a Claude Code capacity stop without requiring a custom pattern', async () => {
        const capacityMessage = '⚠ Selected model is at capacity. Please try a different model.';
        const fixture = createRecovery({
            provider: 'claude',
            settings: { ...enabledSettings(), patterns: [] },
            tail: () =>
                Promise.resolve({
                    beforeCursorLine: capacityMessage,
                    cursorLine: '❯',
                    full: `${capacityMessage}\n❯`,
                }),
        });

        fixture.recovery.observeOutput();
        await vi.advanceTimersByTimeAsync(550);

        expect(fixture.write.mock.calls).toEqual([['\u{1B}'], ['continue\r']]);
        expect(fixture.onStatus).toHaveBeenCalledWith('recovered');
        expect(fixture.loggerWrite).toHaveBeenCalledWith('info', 'pty.output_recovery_completed', {
            fields: {
                provider: 'claude',
                ruleIndex: 0,
                ruleSource: 'builtin',
                terminalId: 'terminal-1',
            },
        });
    });

    it.each([
        {
            name: 'another provider',
            provider: 'codex' as const,
            tail: '⚠ Selected model is at capacity. Please try a different model.',
        },
        {
            name: 'a partial message',
            provider: 'claude' as const,
            tail: '⚠ Selected model is at capacity.',
        },
        {
            name: 'newer progress',
            provider: 'claude' as const,
            tail: '⚠ Selected model is at capacity. Please try a different model.\nWorking',
        },
    ])('does not treat $name as the Claude capacity stop', async ({ provider, tail }) => {
        const fixture = createRecovery({
            provider,
            settings: { ...enabledSettings(), patterns: [] },
            tail: () => Promise.resolve({ beforeCursorLine: tail, cursorLine: '', full: tail }),
        });

        fixture.recovery.observeOutput();
        await vi.advanceTimersByTimeAsync(550);

        expect(fixture.write).not.toHaveBeenCalled();
        expect(fixture.onStatus).not.toHaveBeenCalled();
    });

    it('does not treat the capacity text typed into the Claude composer as a built-in stop', async () => {
        const capacityMessage = 'Selected model is at capacity. Please try a different model.';
        const composerLine = `❯ ${capacityMessage}`;
        const fixture = createRecovery({
            provider: 'claude',
            settings: { ...enabledSettings(), patterns: [] },
            tail: () =>
                Promise.resolve({
                    beforeCursorLine: '',
                    cursorLine: composerLine,
                    full: composerLine,
                }),
        });

        fixture.recovery.observeOutput();
        await vi.advanceTimersByTimeAsync(550);

        expect(fixture.write).not.toHaveBeenCalled();
        expect(fixture.onStatus).not.toHaveBeenCalled();
    });

    it('does not treat a submitted prompt ending in the full capacity warning as a built-in stop', async () => {
        const capacityWarning = '⚠ Selected model is at capacity. Please try a different model.';
        const submittedPrompt = `❯ ${capacityWarning}`;
        const durationLine = '* Cogitated for 1s';
        const fixture = createRecovery({
            provider: 'claude',
            settings: { ...enabledSettings(), patterns: [] },
            tail: () =>
                Promise.resolve({
                    beforeCursorLine: submittedPrompt,
                    cursorLine: durationLine,
                    full: `${submittedPrompt}\n${durationLine}`,
                }),
        });

        fixture.recovery.observeOutput();
        await vi.advanceTimersByTimeAsync(550);

        expect(fixture.write).not.toHaveBeenCalled();
        expect(fixture.onStatus).not.toHaveBeenCalled();
    });

    it('prefers an identical custom pattern without duplicating a built-in recovery', async () => {
        const capacityMessage = 'Selected model is at capacity. Please try a different model.';
        const capacityWarning = `⚠ ${capacityMessage}`;
        const fixture = createRecovery({
            provider: 'claude',
            settings: { ...enabledSettings(), patterns: [capacityMessage] },
            tail: () =>
                Promise.resolve({
                    beforeCursorLine: capacityWarning,
                    cursorLine: '❯',
                    full: `${capacityWarning}\n❯`,
                }),
        });

        fixture.recovery.observeOutput();
        await vi.advanceTimersByTimeAsync(550);

        expect(fixture.write.mock.calls).toEqual([['\u{1B}'], ['continue\r']]);
        expect(fixture.loggerWrite).toHaveBeenCalledWith('info', 'pty.output_recovery_completed', {
            fields: {
                provider: 'claude',
                ruleIndex: 0,
                ruleSource: 'custom',
                terminalId: 'terminal-1',
            },
        });
    });

    it('matches completed output above the active Agent status line', async () => {
        const fixture = createRecovery({
            provider: 'claude',
            tail: () =>
                Promise.resolve({
                    beforeCursorLine: 'API timeout',
                    cursorLine: '* Cogitated for 21m 52s',
                    full: 'API timeout\n* Cogitated for 21m 52s',
                }),
        });

        fixture.recovery.observeOutput();
        await vi.advanceTimersByTimeAsync(250);

        expect(fixture.write).toHaveBeenCalledWith('\u{1B}');
    });

    it('does not ignore an ordinary active progress line after a historical error', async () => {
        const fixture = createRecovery({
            provider: 'claude',
            tail: () =>
                Promise.resolve({
                    beforeCursorLine: 'API timeout',
                    cursorLine: 'Downloading dependencies',
                    full: 'API timeout\nDownloading dependencies',
                }),
        });

        fixture.recovery.observeOutput();
        await vi.advanceTimersByTimeAsync(550);

        expect(fixture.write).not.toHaveBeenCalled();
    });

    it('does not match historical errors before a completed newer output line', async () => {
        const fixture = createRecovery({
            tail: () =>
                Promise.resolve({
                    beforeCursorLine: 'API timeout',
                    cursorLine: 'request succeeded',
                    full: 'API timeout\nrequest succeeded',
                }),
        });

        fixture.recovery.observeOutput();
        await vi.advanceTimersByTimeAsync(550);

        expect(fixture.write).not.toHaveBeenCalled();
    });

    it('re-arms a rule when Escape exposes non-matching progress before Continue', async () => {
        const fixture = createRecovery();

        fixture.recovery.observeOutput();
        await vi.advanceTimersByTimeAsync(250);
        fixture.setTail('Agent prompt');
        fixture.recovery.observeOutput();
        await vi.advanceTimersByTimeAsync(300);
        fixture.setTail('API timeout');
        fixture.recovery.observeOutput();
        await vi.advanceTimersByTimeAsync(250);

        expect(fixture.write.mock.calls).toEqual([['\u{1B}'], ['continue\r'], ['\u{1B}']]);
    });

    it('does not re-arm when output after Escape still shows the same error', async () => {
        const fixture = createRecovery();

        fixture.recovery.observeOutput();
        await vi.advanceTimersByTimeAsync(250);
        fixture.recovery.observeOutput();
        await vi.advanceTimersByTimeAsync(300);
        fixture.recovery.observeOutput();
        await vi.advanceTimersByTimeAsync(250);

        expect(fixture.write.mock.calls).toEqual([['\u{1B}'], ['continue\r']]);
    });

    it('restarts the quiet period when newer output arrives before Escape', async () => {
        const fixture = createRecovery();

        fixture.recovery.observeOutput();
        await vi.advanceTimersByTimeAsync(200);
        fixture.recovery.observeOutput();
        await vi.advanceTimersByTimeAsync(249);
        expect(fixture.write).not.toHaveBeenCalled();
        await vi.advanceTimersByTimeAsync(1);

        expect(fixture.write).toHaveBeenCalledTimes(1);
        expect(fixture.write).toHaveBeenCalledWith('\u{1B}');
    });

    it('allows prompt output after Escape but cancels Continue when the user takes over', async () => {
        const fixture = createRecovery();

        fixture.recovery.observeOutput();
        await vi.advanceTimersByTimeAsync(250);
        fixture.setTail('Agent prompt');
        fixture.recovery.observeOutput();
        await vi.advanceTimersByTimeAsync(300);
        expect(fixture.write.mock.calls).toEqual([['\u{1B}'], ['continue\r']]);

        fixture.setTail('progress');
        fixture.recovery.observeOutput();
        await vi.advanceTimersByTimeAsync(250);
        fixture.setTail('API timeout');
        fixture.recovery.observeOutput();
        await vi.advanceTimersByTimeAsync(250);
        fixture.recovery.observeUserInput();
        await vi.advanceTimersByTimeAsync(300);

        expect(fixture.write.mock.calls).toEqual([['\u{1B}'], ['continue\r'], ['\u{1B}']]);
    });

    it('re-evaluates the current parsed tail on a hot settings change', async () => {
        const fixture = createRecovery({
            settings: { ...enabledSettings(), enabled: false },
        });
        fixture.recovery.observeOutput();

        fixture.setSettings(enabledSettings());
        fixture.recovery.settingsChanged();
        await vi.advanceTimersByTimeAsync(250);

        expect(fixture.write).toHaveBeenCalledWith('\u{1B}');
    });

    it('fences delayed writes to the current PTY generation', async () => {
        let isCurrent = true;
        const fixture = createRecovery({ current: () => isCurrent });

        fixture.recovery.observeOutput();
        await vi.advanceTimersByTimeAsync(250);
        isCurrent = false;
        await vi.advanceTimersByTimeAsync(300);

        expect(fixture.write.mock.calls).toEqual([['\u{1B}']]);
        expect(fixture.onStatus).not.toHaveBeenCalled();
    });

    it('re-arms only after non-matching progress and rate-limits repeated recovery loops', async () => {
        const fixture = createRecovery();

        for (let attempt = 0; attempt < 3; attempt += 1) {
            fixture.setTail('API timeout');
            fixture.recovery.observeOutput();
            // eslint-disable-next-line no-await-in-loop -- each recovery attempt must complete before re-arming
            await vi.advanceTimersByTimeAsync(550);
            fixture.setTail(`progress ${attempt}`);
            fixture.recovery.observeOutput();
            // eslint-disable-next-line no-await-in-loop -- the non-matching tail re-arms the next sequential attempt
            await vi.advanceTimersByTimeAsync(250);
        }
        fixture.setTail('API timeout');
        fixture.recovery.observeOutput();
        await vi.advanceTimersByTimeAsync(250);

        expect(fixture.write).toHaveBeenCalledTimes(6);
        expect(fixture.onStatus.mock.calls).toEqual([
            ['recovered'],
            ['recovered'],
            ['recovered'],
            ['rate-limited'],
        ]);
    });
});

describe('output recovery ownership', () => {
    it('treats an enabled Claude built-in rule as configured with no custom patterns', () => {
        const claudeSettings = { ...enabledSettings(), patterns: [] };

        expect(
            hasConfiguredOutputRecovery((provider) =>
                provider === 'claude'
                    ? claudeSettings
                    : { ...enabledSettings(), enabled: false, patterns: [] },
            ),
        ).toBe(true);
    });

    it('creates the per-Terminal recovery owner for an enabled Claude built-in rule', () => {
        const settings = { ...enabledSettings(), patterns: [] };
        const live = {
            record: { id: 'terminal-1' },
            screen: { textTail: vi.fn() },
        } as unknown as LiveTerminal;

        const recovery = ensureLiveOutputRecovery(live, {
            emit: vi.fn(),
            getSettings: () => settings,
            isCurrent: () => true,
            logger: { write: vi.fn() } as unknown as StructuredLogger,
            provider: 'claude',
            write: vi.fn(() => true),
        });

        expect(recovery).toBeInstanceOf(AgentOutputRecovery);
        expect(live.outputRecovery).toBe(recovery);
        expect(live.outputRecoveryProvider).toBe('claude');
        recovery?.dispose();
    });
});
