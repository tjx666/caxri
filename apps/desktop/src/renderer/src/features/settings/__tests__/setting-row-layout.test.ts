import { describe, expect, it } from 'vitest';

import { isFullWidthRow, SHORT_CONTROL_WIDTH_CLASS_NAME } from '../setting-row-layout';
import type { SettingRowBinding, SettingRowDescriptor } from '../settings-registry';

function row(binding: SettingRowBinding): SettingRowDescriptor {
    return {
        id: 'test-row',
        category: 'general',
        title: 'Test row',
        accessibleTitle: 'Test row',
        binding,
        haystack: 'test row',
    };
}

describe('isFullWidthRow', () => {
    it('spans the full row for a string-kind setting, which needs its own line to stay readable', () => {
        expect(isFullWidthRow(row({ type: 'setting', key: 'workbench.fontFamily' }))).toBe(true);
    });

    it.each([
        { key: 'terminal.copyOnSelect', kind: 'boolean' },
        { key: 'terminal.fontSize', kind: 'integer' },
        { key: 'editor.wordWrap', kind: 'enum' },
    ] as const)(
        'keeps a $kind-kind setting ($key) beside its label at the shared short-control width',
        ({ key }) => {
            expect(isFullWidthRow(row({ type: 'setting', key }))).toBe(false);
        },
    );

    it.each([
        { type: 'files-exclude', key: 'files.exclude' },
        { type: 'ignored-checks' },
        { type: 'mobile-access' },
        { type: 'provider-actions', provider: 'claude' },
        { type: 'provider-launch', provider: 'claude', field: 'executable' },
        { type: 'provider-recovery', provider: 'claude' },
        { type: 'provider-skill-health', provider: 'claude' },
        { type: 'terminal-reference-links' },
        { type: 'trusted-domains' },
        { type: 'trusted-folders' },
    ] as const)('spans the full row for the $type editor', (binding) => {
        expect(isFullWidthRow(row(binding as SettingRowBinding))).toBe(true);
    });

    it.each([
        { type: 'archived-sessions' },
        { type: 'delegation-depth' },
        { type: 'hardware-acceleration' },
        { type: 'remote-debugging' },
        { type: 'provider-toggle', provider: 'claude', field: 'hooks' },
        { type: 'provider-autonomy', provider: 'claude' },
    ] as const)(
        'keeps the $type control beside its label — it is a toggle or a compact number, not a form',
        (binding) => {
            expect(isFullWidthRow(row(binding as SettingRowBinding))).toBe(false);
        },
    );
});

describe('SHORT_CONTROL_WIDTH_CLASS_NAME', () => {
    it('is one Tailwind width class shared by every short control, so a select and a number field line up', () => {
        expect(SHORT_CONTROL_WIDTH_CLASS_NAME).toMatch(/^w-\d+$/);
    });
});
