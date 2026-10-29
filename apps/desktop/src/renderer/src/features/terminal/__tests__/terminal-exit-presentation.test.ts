import type { ProcessState } from '@caxri/protocol';
import { settingCategories, settingsSpecByKey } from '@caxri/protocol';
import { describe, expect, it } from 'vitest';

import { translate } from '../../../i18n';
import { getTerminalExitPresentation, suspendedDetail } from '../terminal-exit-presentation';

describe('getTerminalExitPresentation', () => {
    it.each([
        ['stopped', { icon: 'completed', label: 'Process exited normally', tone: 'neutral' }],
        ['failed', { icon: 'failed', label: 'Terminal failed to start', tone: 'danger' }],
        ['dead', { icon: 'unexpected', label: 'Terminal stopped unexpectedly', tone: 'danger' }],
        [
            'interrupted',
            {
                icon: 'pending',
                label: 'Interrupted by app shutdown — restoring',
                tone: 'neutral',
            },
        ],
        [
            'suspended',
            {
                detail: suspendedDetail(translate),
                icon: 'pending',
                label: 'Suspended in the background, resuming',
                tone: 'neutral',
            },
        ],
        [
            'detached',
            {
                icon: 'detached',
                label: 'Detached — resume when you are done elsewhere',
                tone: 'neutral',
            },
        ],
    ] satisfies Array<[ProcessState, ReturnType<typeof getTerminalExitPresentation>]>)(
        'maps %s to a distinct recovery presentation',
        (state, expected) => {
            expect(
                getTerminalExitPresentation(state, undefined, undefined, undefined, translate),
            ).toEqual(expected);
        },
    );

    it.each(['starting', 'running'] satisfies ProcessState[])(
        'does not render recovery UI while the Terminal is %s',
        (state) => {
            expect(
                getTerminalExitPresentation(state, undefined, undefined, undefined, translate),
            ).toBeUndefined();
        },
    );

    it.each([
        ['working_directory_unavailable', 'Working directory no longer exists'],
        ['executable_not_found', 'Agent CLI executable was not found'],
        ['spawn_failed', 'Terminal process could not be started'],
    ] as const)('maps failure reason %s to actionable copy', (failureReason, label) => {
        expect(
            getTerminalExitPresentation('failed', failureReason, undefined, undefined, translate),
        ).toEqual({
            icon: 'failed',
            label,
            tone: 'danger',
        });
    });

    it('falls back to the generic message when a failed Terminal has no failure reason', () => {
        expect(
            getTerminalExitPresentation('failed', undefined, undefined, undefined, translate),
        ).toEqual({
            icon: 'failed',
            label: 'Terminal failed to start',
            tone: 'danger',
        });
    });

    it('prefers a specific launch failure detail over the reason fallback', () => {
        expect(
            getTerminalExitPresentation(
                'failed',
                'executable_not_found',
                'Claude CLI was not found',
                undefined,
                translate,
            ),
        ).toEqual({
            icon: 'failed',
            label: 'Claude CLI was not found',
            tone: 'danger',
        });
    });

    /**
     * The tooltip sends the user to a Settings category by name, so it must keep naming the category the suspension
     * settings actually live in.
     */
    it('names the Settings category that owns the suspension settings', () => {
        const category = settingsSpecByKey['terminal.idleSuspension.enabled'].category;
        expect(settingsSpecByKey['terminal.suspendUntouchedAgents'].category).toBe(category);
        const title = settingCategories.find((entry) => entry.id === category)?.title;
        expect(suspendedDetail(translate)).toContain(`Settings › ${title}.`);
    });

    describe('with exit context', () => {
        it('names the exit code of a failed process', () => {
            expect(
                getTerminalExitPresentation(
                    'dead',
                    undefined,
                    undefined,
                    {
                        exit: { exitCode: 2 },
                    },
                    translate,
                )?.label,
            ).toBe('Terminal stopped unexpectedly (exit code 2)');
        });

        it('names the signal that ended the process', () => {
            expect(
                getTerminalExitPresentation(
                    'dead',
                    undefined,
                    undefined,
                    {
                        exit: { exitCode: 0, signal: 9 },
                    },
                    translate,
                )?.label,
            ).toBe('Terminal stopped unexpectedly (signal SIGKILL)');
            expect(
                getTerminalExitPresentation(
                    'dead',
                    undefined,
                    undefined,
                    {
                        exit: { exitCode: 0, signal: 99 },
                    },
                    translate,
                )?.label,
            ).toBe('Terminal stopped unexpectedly (signal 99)');
        });

        it('flags an Agent that exits within seconds of launch', () => {
            expect(
                getTerminalExitPresentation(
                    'dead',
                    undefined,
                    undefined,
                    {
                        exit: { exitCode: 1, ranForMs: 1_200 },
                        isAgent: true,
                    },
                    translate,
                )?.label,
            ).toBe('The Agent exited right after starting (exit code 1)');
        });

        it('does not claim an early exit for a shell, a long run, or an unseen launch', () => {
            const early = { exitCode: 1, ranForMs: 1_200 };
            expect(
                getTerminalExitPresentation(
                    'dead',
                    undefined,
                    undefined,
                    { exit: early },
                    translate,
                )?.label,
            ).toBe('Terminal stopped unexpectedly (exit code 1)');
            expect(
                getTerminalExitPresentation(
                    'dead',
                    undefined,
                    undefined,
                    {
                        exit: { exitCode: 1, ranForMs: 60_000 },
                        isAgent: true,
                    },
                    translate,
                )?.label,
            ).toBe('Terminal stopped unexpectedly (exit code 1)');
            expect(
                getTerminalExitPresentation(
                    'dead',
                    undefined,
                    undefined,
                    {
                        exit: { exitCode: 1 },
                        isAgent: true,
                    },
                    translate,
                )?.label,
            ).toBe('Terminal stopped unexpectedly (exit code 1)');
        });

        it('keeps a clean exit neutral', () => {
            expect(
                getTerminalExitPresentation(
                    'stopped',
                    undefined,
                    undefined,
                    {
                        exit: { exitCode: 0 },
                    },
                    translate,
                ),
            ).toEqual({ icon: 'completed', label: 'Process exited normally', tone: 'neutral' });
        });

        it('shows the missing folder when the working directory is gone', () => {
            expect(
                getTerminalExitPresentation(
                    'failed',
                    'working_directory_unavailable',
                    undefined,
                    {
                        cwd: '/work/gone',
                    },
                    translate,
                )?.label,
            ).toBe('Folder no longer exists: /work/gone');
        });
    });
});
