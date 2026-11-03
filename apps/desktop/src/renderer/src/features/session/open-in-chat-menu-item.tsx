import type { TerminalKind, TerminalSurface } from '@caxri/protocol';

import {
    MenuContent,
    MenuRadioGroup,
    MenuRadioItem,
    MenuSubmenu,
    MenuSubmenuTrigger,
} from '../../components/ui/menu';
import { Switch } from '../../components/ui/switch';
import { translate, useTranslation } from '../../i18n';
import { useSettings } from '../../stores/selectors';
import { tryCommand } from '../../stores/toasts';
import { applyFormEdit } from '../settings/config-edit';
import { getSettings, updateSettings } from '../settings/settings-client';
import type { AgentReadinessIssue } from '../terminal/new-terminal-agent';
import { agentChoiceMarker } from '../terminal/new-terminal-agent';

/**
 * Both controls write the persistent `session.openAgentsInChat` setting, not a choice for the next pick. The dialog's
 * Switch says so with "Always" (`session.openInChat.label`); the menus' "Open Agents In" row shows the saved value.
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
 * The New Session and New Terminal menus' footer row, `Open Agents In Chat ›`, with Chat and Terminal in a submenu like
 * the composer's model and effort picker. The saved value stays visible without opening anything and both outcomes are
 * named, where an unchecked "Open Agents in Chat" left the user to infer the Terminal. Choosing keeps the menus open
 * (Base UI's default for radio items) so the Agent rows' markers update before the user picks one.
 */
export function OpenInChatMenuItem() {
    const isOn = useIsOpenInChatOn();
    const { t } = useTranslation();
    const value: TerminalSurface = isOn ? 'chat' : 'pty';
    return (
        <MenuSubmenu>
            <MenuSubmenuTrigger>
                <span className="flex-1 truncate">{t('session.openAgentsIn.label')}</span>
                <span className="text-muted">
                    {t(isOn ? 'session.openAgentsIn.chat' : 'session.openAgentsIn.terminal')}
                </span>
            </MenuSubmenuTrigger>
            <MenuContent
                align="start"
                alignOffset={-4}
                className="min-w-28"
                side="right"
                sideOffset={6}
            >
                <MenuRadioGroup
                    value={value}
                    onValueChange={(next: TerminalSurface) => setOpenAgentsInChat(next === 'chat')}
                >
                    <MenuRadioItem value="chat">
                        <span className="flex-1 truncate">{t('session.openAgentsIn.chat')}</span>
                    </MenuRadioItem>
                    <MenuRadioItem value="pty">
                        <span className="flex-1 truncate">
                            {t('session.openAgentsIn.terminal')}
                        </span>
                    </MenuRadioItem>
                </MenuRadioGroup>
            </MenuContent>
        </MenuSubmenu>
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
 * The muted suffix an Agent row carries in the New Session and New Terminal menus and the Agent-choice dialog
 * (`agentChoiceMarker`). A row that opens a Chat still names it, to assistive tech only: sighted users read the setting
 * once on the footer control, while a screen reader moving through the rows would otherwise never hear where one
 * opens.
 */
export function AgentChoiceMarker({
    isDefault,
    issue,
    kind,
    surface,
}: {
    isDefault: boolean;
    issue?: AgentReadinessIssue;
    kind: TerminalKind;
    surface: TerminalSurface;
}) {
    const isOn = useIsOpenInChatOn();
    const { t } = useTranslation();
    const marker = agentChoiceMarker({ isDefault, issue, kind, surface }, isOn, t);
    return (
        <>
            {surface === 'chat' && <span className="sr-only">{t('terminal.new.chatMarker')}</span>}
            {marker && <span className="text-muted">{marker}</span>}
        </>
    );
}
