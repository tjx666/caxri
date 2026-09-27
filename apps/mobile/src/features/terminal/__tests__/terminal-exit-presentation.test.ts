import { describe, expect, it } from 'vitest';

import { mobileTerminalExitPresentation } from '../terminal-exit-presentation';

describe('mobileTerminalExitPresentation', () => {
    it('keeps a clean exit muted', () => {
        expect(mobileTerminalExitPresentation('stopped')).toEqual({
            label: 'Terminal has stopped',
            tone: 'muted',
        });
    });

    it('marks an unexpected stop as danger', () => {
        expect(mobileTerminalExitPresentation('dead')).toEqual({
            label: 'Terminal stopped unexpectedly',
            tone: 'danger',
        });
    });

    it('marks a failed Terminal as danger with a generic fallback', () => {
        expect(mobileTerminalExitPresentation('failed')).toEqual({
            label: 'Terminal exited with an error',
            tone: 'danger',
        });
    });

    it('marks a failed Terminal as danger with the specific failure reason', () => {
        expect(mobileTerminalExitPresentation('failed', 'executable_not_found')).toEqual({
            label: 'Agent CLI executable was not found',
            tone: 'danger',
        });
    });

    it('keeps automatic Desktop-side transitions muted rather than treating them as errors', () => {
        expect(mobileTerminalExitPresentation('interrupted').tone).toBe('muted');
        expect(mobileTerminalExitPresentation('suspended').tone).toBe('muted');
        expect(mobileTerminalExitPresentation('detached').tone).toBe('muted');
    });
});
