import type { ClaudeWindowState } from '@caxri/protocol';
import { describe, expect, it } from 'vitest';

import {
    claudeWindowsAccountToAnnounce,
    parseAnnouncedAccounts,
} from './claude-windows-default-notice';

function stateWith(account: Partial<NonNullable<ClaudeWindowState['account']>>): ClaudeWindowState {
    return {
        account: {
            key: 'account-a',
            planType: 'pro',
            keepRolling: true,
            keepRollingIsDefault: true,
            firstWorkdayResetMinutes: 600,
            ...account,
        },
        status: 'waitingForAnchor',
        background: 'registered',
    } as ClaudeWindowState;
}

describe('claudeWindowsAccountToAnnounce', () => {
    it('announces a keeper that is on only because of the plan default', () => {
        expect(claudeWindowsAccountToAnnounce(stateWith({}), [])).toBe('account-a');
    });

    it('stays quiet once the account was told on this device', () => {
        expect(claudeWindowsAccountToAnnounce(stateWith({}), ['account-a'])).toBeUndefined();
    });

    it('announces a newly signed-in account even after another one was told', () => {
        expect(claudeWindowsAccountToAnnounce(stateWith({ key: 'account-b' }), ['account-a'])).toBe(
            'account-b',
        );
    });

    it('stays quiet when the user already chose, either way', () => {
        expect(
            claudeWindowsAccountToAnnounce(stateWith({ keepRollingIsDefault: false }), []),
        ).toBeUndefined();
        expect(
            claudeWindowsAccountToAnnounce(
                stateWith({ keepRolling: false, keepRollingIsDefault: false }),
                [],
            ),
        ).toBeUndefined();
    });

    it('stays quiet when the default leaves the keeper off, as for Max', () => {
        expect(
            claudeWindowsAccountToAnnounce(stateWith({ planType: 'max', keepRolling: false }), []),
        ).toBeUndefined();
    });

    it('stays quiet before Claude Code identified an account', () => {
        expect(
            claudeWindowsAccountToAnnounce(
                { status: 'off', background: 'unknown', wakeTimes: [] },
                [],
            ),
        ).toBeUndefined();
        expect(claudeWindowsAccountToAnnounce(undefined, [])).toBeUndefined();
    });
});

describe('parseAnnouncedAccounts', () => {
    it('keeps string keys and reads anything corrupt as nobody told', () => {
        expect(parseAnnouncedAccounts(['a', 1, null, 'b'])).toEqual(['a', 'b']);
        expect(parseAnnouncedAccounts({ a: 1 })).toEqual([]);
        expect(parseAnnouncedAccounts(undefined)).toEqual([]);
    });
});
