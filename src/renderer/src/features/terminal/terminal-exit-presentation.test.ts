import { describe, expect, it } from 'vitest';

import type { ProcessState } from '@shared/types';

import { getTerminalExitPresentation } from './terminal-exit-presentation';

describe('getTerminalExitPresentation', () => {
    it.each([
        ['stopped', { icon: 'completed', label: 'Process exited normally', tone: 'neutral' }],
        ['failed', { icon: 'failed', label: 'Terminal failed to start', tone: 'danger' }],
        ['dead', { icon: 'unexpected', label: 'Terminal stopped unexpectedly', tone: 'danger' }],
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
});
