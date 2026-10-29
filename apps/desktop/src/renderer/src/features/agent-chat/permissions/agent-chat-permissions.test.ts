import type { AppLocale } from '@caxri/protocol';
import { afterEach, describe, expect, it } from 'vitest';

import { translate, useLocaleStore, withLocale } from '../../../i18n';
import {
    agentChatPermissionLabel,
    agentChatPermissionView,
    agentChatProjectDefault,
    isAgentChatPermissionDeferred,
    isAgentChatProjectDefault,
    nextAgentChatPermissionTurnBaseline,
} from './agent-chat-permissions';

const translateIn = (locale: AppLocale): typeof translate =>
    withLocale((...parameters) => {
        useLocaleStore.setState({ locale });
        return translate(...parameters);
    }, locale);

afterEach(() => useLocaleStore.setState({ locale: 'en' }));

describe('Agent Chat permission picker', () => {
    it('writes the trigger in the language of the translator it is given', () => {
        /**
         * A language switch changes only `t`; the view must follow it instead of a cached global lookup.
         */
        const view = (t: typeof translate) =>
            agentChatPermissionView({ permissionMode: 'fullAccess' }, 'claude', undefined, t);
        expect(view(translateIn('en')).label).toBe('Full access');
        expect(view(translateIn('zh-CN')).label).toBe('完全访问');
        expect(view(translateIn('zh-CN')).projectDefaultItem.label).not.toBe(
            'Use as Project default',
        );
    });

    it('names the level in the provider words, and Custom without one', () => {
        expect(
            agentChatPermissionLabel({ permissionMode: 'acceptEdits' }, 'codex', translate),
        ).toBe('Default');
        expect(
            agentChatPermissionLabel({ permissionMode: 'acceptEdits' }, 'claude', translate),
        ).toBe('Accept edits');
        expect(agentChatPermissionLabel({}, 'codex', translate)).toBe('Custom');
    });

    it('saves the level and plan mode as the Project default, and nothing for Custom', () => {
        expect(agentChatProjectDefault({ permissionMode: 'auto', planMode: true })).toEqual({
            permissionMode: 'auto',
            planMode: true,
        });
        // Grok Build has no plan mode, so its default carries none.
        expect(agentChatProjectDefault({ permissionMode: 'auto' })).toEqual({
            permissionMode: 'auto',
        });
        expect(agentChatProjectDefault({ planMode: false })).toBeUndefined();
    });

    it('recognizes the default the Project already has for that provider', () => {
        const defaults = { codex: { permissionMode: 'readOnly' as const } };
        expect(
            isAgentChatProjectDefault(
                { permissionMode: 'readOnly', planMode: false },
                defaults,
                'codex',
            ),
        ).toBe(true);
        expect(
            isAgentChatProjectDefault(
                { permissionMode: 'readOnly', planMode: true },
                defaults,
                'codex',
            ),
        ).toBe(false);
        expect(isAgentChatProjectDefault({ permissionMode: 'readOnly' }, defaults, 'claude')).toBe(
            false,
        );
        expect(isAgentChatProjectDefault({ permissionMode: 'readOnly' }, undefined, 'codex')).toBe(
            false,
        );
    });

    it('describes the trigger and whether the Chat already matches the Project default', () => {
        expect(
            agentChatPermissionView(
                { permissionMode: 'fullAccess', planMode: true },
                'claude',
                {
                    claude: { permissionMode: 'fullAccess', planMode: true },
                },
                translate,
            ),
        ).toEqual({
            label: 'Full access',
            ariaLabel: 'Permissions: Full access',
            isFullAccess: true,
            projectDefault: { permissionMode: 'fullAccess', planMode: true },
            isSavedDefault: true,
            projectDefaultItem: { label: 'Project default', isChecked: true },
            // Unchecking the checked row clears it, so no second row repeats that.
            showsClearProjectDefault: false,
            pendingCaption: undefined,
        });
        expect(agentChatPermissionView({ planMode: false }, 'codex', undefined, translate)).toEqual(
            {
                label: 'Custom',
                ariaLabel: 'Permissions: Custom',
                isFullAccess: false,
                projectDefault: undefined,
                isSavedDefault: false,
                // Shown but unavailable, with the reason, rather than missing from the menu.
                projectDefaultItem: {
                    label: 'Use as Project default',
                    isChecked: false,
                    disabledReason: 'Choose a level to save it as the default',
                },
                showsClearProjectDefault: false,
                pendingCaption: undefined,
            },
        );
        expect(
            agentChatPermissionView({ permissionMode: 'auto' }, 'codex', undefined, translate)
                .projectDefaultItem,
        ).toEqual({ label: 'Use as Project default', isChecked: false });
    });

    it('offers clearing a saved Project default even when the Chat differs from it', () => {
        const view = agentChatPermissionView(
            { permissionMode: 'auto' },
            'codex',
            {
                codex: { permissionMode: 'readOnly' },
                claude: { permissionMode: 'auto' },
            },
            translate,
        );
        expect(view.isSavedDefault).toBe(false);
        expect(view.showsClearProjectDefault).toBe(true);
        // Another provider's default does not count.
        expect(
            agentChatPermissionView(
                { permissionMode: 'auto' },
                'grok',
                {
                    claude: { permissionMode: 'auto' },
                },
                translate,
            ).showsClearProjectDefault,
        ).toBe(false);
    });

    it('says when the shown choice waits for the next turn', () => {
        const view = agentChatPermissionView(
            { permissionMode: 'readOnly' },
            'codex',
            undefined,
            translate,
            {
                isDeferred: true,
            },
        );
        expect(view.pendingCaption).toBe('from next turn');
        expect(view.ariaLabel).toBe('Permissions: Read only, from the next turn');
    });
});

describe('Agent Chat permission switch during a turn', () => {
    const reported = { permissionMode: 'fullAccess' as const, planMode: false };

    it('captures what the running turn uses only for a provider that applies switches next turn', () => {
        expect(
            nextAgentChatPermissionTurnBaseline(undefined, {
                activeTurnId: 'turn-1',
                appliesOnNextTurn: true,
                reported,
            }),
        ).toEqual({ turnId: 'turn-1', permissionMode: 'fullAccess', planMode: false });
        expect(
            nextAgentChatPermissionTurnBaseline(undefined, {
                activeTurnId: 'turn-1',
                appliesOnNextTurn: false,
                reported,
            }),
        ).toBeUndefined();
        expect(
            nextAgentChatPermissionTurnBaseline(undefined, {
                activeTurnId: undefined,
                appliesOnNextTurn: true,
                reported,
            }),
        ).toBeUndefined();
    });

    it('keeps the first capture of a turn, so a second switch still compares with what the turn runs', () => {
        const first = { turnId: 'turn-1', permissionMode: 'fullAccess' as const, planMode: false };
        expect(
            nextAgentChatPermissionTurnBaseline(first, {
                activeTurnId: 'turn-1',
                appliesOnNextTurn: true,
                reported: { permissionMode: 'readOnly', planMode: false },
            }),
        ).toBe(first);
    });

    it('defers a changed choice until the turn that captured it ends', () => {
        const baseline = {
            turnId: 'turn-1',
            permissionMode: 'fullAccess' as const,
            planMode: false,
        };
        const shown = { permissionMode: 'readOnly' as const, planMode: false };
        expect(isAgentChatPermissionDeferred(baseline, shown, 'turn-1')).toBe(true);
        // Switching back to what the turn runs leaves nothing waiting.
        expect(isAgentChatPermissionDeferred(baseline, reported, 'turn-1')).toBe(false);
        expect(isAgentChatPermissionDeferred(baseline, shown, 'turn-2')).toBe(false);
        expect(isAgentChatPermissionDeferred(baseline, shown, undefined)).toBe(false);
        expect(isAgentChatPermissionDeferred(undefined, shown, 'turn-1')).toBe(false);
        expect(
            isAgentChatPermissionDeferred(
                baseline,
                { permissionMode: 'fullAccess', planMode: true },
                'turn-1',
            ),
        ).toBe(true);
    });
});
