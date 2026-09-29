import { describe, expect, it } from 'vitest';

import { e2eLaunchLogFields } from '../e2e-launch';

describe('e2eLaunchLogFields', () => {
    it('reports a blocked Agent policy when none is configured', () => {
        expect(e2eLaunchLogFields(undefined, 'hidden')).toEqual({
            agentMode: 'blocked',
            agentProvider: null,
            windowMode: 'hidden',
        });
    });

    it('lists fake Agent providers in a stable order', () => {
        const fields = e2eLaunchLogFields(
            { mode: 'fake', executables: { codex: '/fake/codex', claude: '/fake/claude' } },
            'visible',
        );
        expect(fields.agentProvider).toBe('claude,codex');
    });
});
