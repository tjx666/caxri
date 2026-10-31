import { describe, expect, it } from 'vitest';

import { createL10n, formatL10nMessage } from '../l10n.js';

describe('formatL10nMessage', () => {
    it('fills positional and named placeholders', () => {
        expect(formatL10nMessage('{0} of {1}', [2, 5])).toBe('2 of 5');
        expect(formatL10nMessage('{count} on {branch}', { count: 3, branch: 'main' })).toBe(
            '3 on main',
        );
    });

    it('leaves a placeholder without an argument visible', () => {
        expect(formatL10nMessage('{count} on {branch}', { count: 3 })).toBe('3 on {branch}');
        expect(formatL10nMessage('{toString}', {})).toBe('{toString}');
    });
});

describe('createL10n', () => {
    it('reads the current bundle on every call', () => {
        const source: { bundle?: Record<string, string> } = {};
        const l10n = createL10n(() => source.bundle);
        expect(l10n.t('Sync Changes')).toBe('Sync Changes');
        source.bundle = { 'Sync Changes': '同步更改', '{count} ahead': '领先 {count}' };
        expect(l10n.t('Sync Changes')).toBe('同步更改');
        expect(l10n.t('{count} ahead', { count: 2 })).toBe('领先 2');
    });

    it('falls back to the English message when the bundle lacks it', () => {
        const l10n = createL10n(() => ({ 'Sync Changes': '同步更改' }));
        expect(l10n.t('Discard All Changes')).toBe('Discard All Changes');
        expect(l10n.t('constructor')).toBe('constructor');
    });
});
