import { MenuCheckboxItem } from '../../components/ui/menu';
import { Switch } from '../../components/ui/switch';
import { useSettings } from '../../stores/selectors';
import { tryCommand } from '../../stores/toasts';
import { applyFormEdit } from '../settings/config-edit';
import { getSettings, updateSettings } from '../settings/settings-client';

/**
 * The Settings title of `session.openAgentsInChat` (`settings-spec.ts`): the toggle writes that persistent setting, so
 * it names it the way Settings does rather than reading like a one-off action for the next pick.
 */
const LABEL = 'Open Agents in Chat';

/**
 * Writes `session.openAgentsInChat` through `settings.jsonc`, the same path the Settings page uses, so the menus and
 * the page always show one value.
 */
function setOpenAgentsInChat(isOn: boolean): void {
    // eslint-disable-next-line no-void -- tryCommand reports a failed write through the toast
    void tryCommand('Unable to change how Agents open', async () => {
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
 * The New Session and New Terminal menus' footer toggle. It stays in the open menu so the "Chat" marker on each Agent
 * row updates before the user picks one.
 */
export function OpenInChatMenuItem() {
    const isOn = useIsOpenInChatOn();
    return (
        <MenuCheckboxItem checked={isOn} onCheckedChange={setOpenAgentsInChat}>
            <span className="flex-1 truncate">{LABEL}</span>
        </MenuCheckboxItem>
    );
}

/**
 * The same preference in the centered Agent-choice dialog, which has buttons rather than menu rows. A Switch, not a
 * Checkbox: it changes a saved preference immediately (see DESIGN.md's Settings redline).
 */
export function OpenInChatSwitch() {
    const isOn = useIsOpenInChatOn();
    return (
        <label className="flex cursor-pointer items-center justify-between gap-2 px-1 text-[12px] text-muted">
            {LABEL}
            <Switch checked={isOn} onCheckedChange={setOpenAgentsInChat} />
        </label>
    );
}

/**
 * The muted marker an Agent row carries when choosing it will open a Chat.
 */
export function ChatSurfaceMarker() {
    return <span className="text-muted">Chat</span>;
}
