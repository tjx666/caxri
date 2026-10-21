import { describe, expect, it } from 'vitest';

import type { Translate } from '../../../i18n';
import { sessionTabTooltip } from '../session-tab-tooltip';

const t: Translate = (key, parameters) => `${key}:${Object.values(parameters ?? {}).join(',')}`;

describe('sessionTabTooltip', () => {
    it('lists the facts the tab cannot show, one per line', () => {
        expect(
            sessionTabTooltip(
                {
                    agentLabel: 'Codex',
                    projectTitle: 'Alpha',
                    shortcutDigit: '2',
                    statusLabel: 'Working',
                    suffix: '#2',
                    title: 'Untitled',
                    workingLocation: 'wt-a',
                },
                t,
            ).split('\n'),
        ).toEqual([
            'Untitled (#2)',
            'sessionTabs.tooltip.project:Alpha',
            'sessionTabs.tooltip.agent:Codex',
            'sessionTabs.tooltip.worktree:wt-a',
            'sessionTabs.tooltip.status:Working',
            'sessionTabs.tooltip.shortcut:2',
        ]);
    });

    it('omits lines without a value', () => {
        expect(sessionTabTooltip({ agentLabel: 'Shell', title: 'Run' }, t)).toBe(
            'Run\nsessionTabs.tooltip.agent:Shell',
        );
    });
});
