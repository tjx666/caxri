import { describe, expect, it } from 'vitest';

import { markAllDoneSummary } from '../agent-activity-commands';

const translate = (key: string, parameters?: Record<string, unknown>) =>
    `${key}${parameters ? JSON.stringify(parameters) : ''}`;

describe('markAllDoneSummary', () => {
    it('reports only the resolved count when everything resolved', () => {
        expect(markAllDoneSummary(3, 3, translate)).toBe(
            'agentActivity.markAllDone.resolvedOther{"count":3}',
        );
    });

    it('adds the Sessions that stay pending after a newer turn', () => {
        expect(markAllDoneSummary(3, 1, translate)).toBe(
            'agentActivity.markAllDone.resolvedOne{"count":1}agentActivity.markAllDone.stayedOther{"count":2}',
        );
    });

    it('says none resolved when every Session had new activity', () => {
        expect(markAllDoneSummary(1, 0, translate)).toBe(
            'agentActivity.markAllDone.resolvedNone' +
                'agentActivity.markAllDone.stayedOne{"count":1}',
        );
    });
});
