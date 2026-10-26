import type { TerminalKind } from '@caxri/protocol';

import { translate } from '../../i18n';
import { tryCommand } from '../../stores/toasts';
import { applyFormEdit } from '../settings/config-edit';
import { getSettings, updateSettings } from '../settings/settings-client';

/**
 * Writes `session.defaultAgent` through `settings.jsonc`, the same path the Settings page and the Open Agents in Chat
 * toggle use, so the Create Session dialog's "Always use this Agent" and the Settings row always show one value.
 */
export function setDefaultAgent(kind: TerminalKind): void {
    void tryCommand(translate('session.createDialog.makeDefaultFailed'), async () => {
        const { source } = await getSettings();
        await updateSettings({ source: applyFormEdit(source, ['session.defaultAgent'], kind) });
    });
}

/**
 * Whether choosing `kind` with "Always use this Agent" on needs a settings write. A pick that already is the default
 * writes nothing, so a repeat visit never rewrites the file.
 */
export function shouldMakeDefault(
    isRequested: boolean,
    kind: TerminalKind | null,
    currentDefault: TerminalKind | null | undefined,
): kind is TerminalKind {
    return isRequested && kind !== null && kind !== currentDefault;
}
