import { describe, expect, it } from 'vitest';

import {
    revealedSettingRowIds,
    rowFocusRequest,
    settingsSectionForRequest,
} from '../settings-focus-requests';

describe('settingsSectionForRequest', () => {
    it('opens Source and Keybindings requests on their own section', () => {
        expect(settingsSectionForRequest('source')).toEqual({ tab: 'settings', view: 'source' });
        expect(settingsSectionForRequest('keybindings')).toEqual({
            tab: 'keybindings',
            view: 'ui',
        });
    });

    it('lands every other request, including an untargeted open, on the Settings list', () => {
        for (const view of ['ui', 'trusted-domains', 'notifications', 'agent-actions'] as const)
            expect(settingsSectionForRequest(view)).toEqual({ tab: 'settings', view: 'ui' });
    });
});

describe('rowFocusRequest', () => {
    it('maps a row-scrolling view to its row id and ignores other views', () => {
        expect(rowFocusRequest({ id: 3, view: 'remote-debugging' })).toEqual({
            id: 3,
            rowId: 'security.remoteDebugging',
        });
        expect(rowFocusRequest({ id: 3, view: 'ui' })).toBeUndefined();
    });
});

describe('revealedSettingRowIds', () => {
    it('names the row each open focus request scrolls to', () => {
        expect([
            ...revealedSettingRowIds({
                gitExclusionsFocusRequestId: 1,
                rowFocusRequest: { rowId: 'security.remoteDebugging' },
                agentExecutableFocusRequest: { provider: 'codex' },
            }),
        ]).toEqual(['git.diffExclude', 'security.remoteDebugging', 'agents.codex.executable']);
        expect(revealedSettingRowIds({}).size).toBe(0);
    });
});
