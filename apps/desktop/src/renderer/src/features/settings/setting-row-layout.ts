import { settingsSpecByKey } from '@caxri/protocol';

import type { SettingRowDescriptor } from './settings-registry';

/**
 * Shared right-aligned width for every short control (`EnumControl`'s select and `IntegerControl`'s number field) on a
 * horizontal row. `Field`'s `justify-between` already lines up each control's right edge regardless of its own width;
 * without a shared width the left edges still stagger wherever a select sits above or below a number field in the same
 * section, which is the "not the same width" half of the alignment bug this fixes.
 */
export const SHORT_CONTROL_WIDTH_CLASS_NAME = 'w-52';

/**
 * Binding types whose editor is not a `setting` binding but still needs the whole row width: a rule list, a launch
 * argument editor, or a health readout cannot be usefully compressed beside a label.
 */
const FULL_WIDTH_BINDING_TYPES: ReadonlySet<SettingRowDescriptor['binding']['type']> = new Set([
    'files-exclude',
    'ignored-checks',
    'mobile-access',
    'provider-actions',
    'provider-launch',
    'provider-recovery',
    'provider-skill-health',
    'terminal-reference-links',
    'trusted-domains',
    'trusted-folders',
]);

/**
 * Whether a row's editor spans the full row width, under its title, instead of sitting right of the label at the shared
 * short-control width: a plain-text or explanatory input needs its own line to stay readable and to leave room for
 * typing, per DESIGN.md's short-control-vs-full-width-row split.
 */
export function isFullWidthRow(row: SettingRowDescriptor): boolean {
    if (row.binding.type === 'setting') return settingsSpecByKey[row.binding.key].kind === 'string';
    return FULL_WIDTH_BINDING_TYPES.has(row.binding.type);
}
