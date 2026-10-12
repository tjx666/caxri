import type { ProcessState } from '@caxri/protocol';
import { settingCategories, settingsSpecByKey } from '@caxri/protocol';
import { describe, expect, it } from 'vitest';

import { getTerminalExitPresentation, SUSPENDED_DETAIL } from '../terminal-exit-presentation';

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
                detail: SUSPENDED_DETAIL,
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
            expect(getTerminalExitPresentation(state)).toEqual(expected);
        },
    );

    it.each(['starting', 'running'] satisfies ProcessState[])(
        'does not render recovery UI while the Terminal is %s',
        (state) => {
            expect(getTerminalExitPresentation(state)).toBeUndefined();
        },
    );

    it.each([
        ['working_directory_unavailable', 'Working directory no longer exists'],
        ['executable_not_found', 'Agent CLI executable was not found'],
        ['spawn_failed', 'Terminal process could not be started'],
    ] as const)('maps failure reason %s to actionable copy', (failureReason, label) => {
        expect(getTerminalExitPresentation('failed', failureReason)).toEqual({
            icon: 'failed',
            label,
            tone: 'danger',
        });
    });

    it('falls back to the generic message when a failed Terminal has no failure reason', () => {
        expect(getTerminalExitPresentation('failed', undefined)).toEqual({
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
        expect(SUSPENDED_DETAIL).toContain(`Settings > ${title}.`);
    });
});
