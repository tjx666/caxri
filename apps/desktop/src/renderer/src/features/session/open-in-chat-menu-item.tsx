import type { TerminalSurface } from '@caxri/protocol';

import { MenuCheckboxItem } from '../../components/ui/menu';
import { Switch } from '../../components/ui/switch';
import { translate, useTranslation } from '../../i18n';
import { useSettings } from '../../stores/selectors';
import { tryCommand } from '../../stores/toasts';
import { applyFormEdit } from '../settings/config-edit';
import { getSettings, updateSettings } from '../settings/settings-client';
import { agentChoiceMarker } from '../terminal/new-terminal-agent';

/**
 * The toggle writes the persistent `session.openAgentsInChat` setting, not a choice for the next pick, so its label
 * (`session.openInChat.label`) says so with "Always": sitting in a menu of one-off choices, the Settings title alone
 * read like an action for the Agent about to be picked.
 */

/**
 * Writes `session.openAgentsInChat` through `settings.jsonc`, the same path the Settings page uses, so the menus and
 * the page always show one value.
 */
function setOpenAgentsInChat(isOn: boolean): void {
    void tryCommand(translate('session.openInChat.failed'), async () => {
        const { source } = await getSettings();
        await updateSettings({
            source: applyFormEdit(source, ['session.openAgentsInChat'], isOn),
        });
    });
}

function useIsOpenInChatOn(): boolean {
    return useSettings()?.['session.openAgentsInChat'] === true;
}

/**
 * The New Session and New Terminal menus' footer toggle. It stays in the open menu so each Agent row's "Chat" marker
 * updates before the user picks one.
 */
export function OpenInChatMenuItem() {
    const isOn = useIsOpenInChatOn();
    const { t } = useTranslation();
    return (
        <MenuCheckboxItem checked={isOn} onCheckedChange={setOpenAgentsInChat}>
            <span className="flex-1 truncate">{t('session.openInChat.label')}</span>
        </MenuCheckboxItem>
    );
}

/**
 * The same preference in the centered Agent-choice dialog, which has buttons rather than menu rows. A Switch, not a
 * Checkbox: it changes a saved preference immediately (see DESIGN.md's Settings redline).
 */
export function OpenInChatSwitch() {
    const isOn = useIsOpenInChatOn();
    const { t } = useTranslation();
    return (
        <label className="flex cursor-pointer items-center justify-between gap-2 px-1 text-[12px] text-muted">
            {t('session.openInChat.label')}
            <Switch checked={isOn} onCheckedChange={setOpenAgentsInChat} />
        </label>
    );
}

/**
 * The one muted suffix an Agent row carries in the New Session and New Terminal menus and the Agent-choice dialog: `Not
 * installed`, `Chat`, `Default`, or those joined (`agentChoiceMarker`).
 */
export function AgentChoiceMarker({
    isDefault,
    isUnavailable = false,
    surface,
}: {
    isDefault: boolean;
    isUnavailable?: boolean;
    surface: TerminalSurface;
}) {
    const { t } = useTranslation();
    const marker = agentChoiceMarker({ isDefault, isUnavailable, surface }, t);
    return marker ? <span className="text-muted">{marker}</span> : null;
}
