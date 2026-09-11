import { useRef } from 'react';

import { Braces, SlidersHorizontal } from 'lucide-react';

import { ChromeTabPanel, ChromeTabs } from '../../components/chrome-tabs';
import {
    Dialog,
    DialogContent,
    DialogDescription,
    DialogHeader,
    DialogTitle,
} from '../../components/ui/dialog';
import { ToggleGroup, ToggleGroupItem } from '../../components/ui/toggle-group';
import { Tooltip } from '../../components/ui/tooltip';
import { CONFIG_KINDS } from './config-edit';
import { ConfigSourceView } from './config-source-view';
import { KeybindingsForm } from './keybindings-form';
import { SettingsPage } from './settings-page';
import { ThemeForm } from './theme-form';
import type { SettingsDialogController } from './use-settings-dialog-controller';
import { useSettingsDialogController } from './use-settings-dialog-controller';

function SettingsDialogView(controller: SettingsDialogController) {
    const { commitSource, sourceErrors, state, tab, updateSource, view } = controller;
    // Base UI's default `initialFocus` moves focus to the first tabbable element inside
    // the popup — the selected ChromeTabs tab button. When the dialog opens via a
    // keyboard shortcut that focus is keyboard-driven, so the tab's `focus-visible`
    // outline draws around it, which reads as a stray box rather than an intentional
    // affordance. Focusing the popup container itself instead avoids that, while Tab
    // still moves focus into the dialog's controls normally.
    const popupReference = useRef<HTMLDivElement>(null);

    const sourceView = state.theme.value && (
        <ConfigSourceView
            error={sourceErrors[tab]}
            kind={tab}
            source={state[tab].source}
            theme={state.theme.value}
            onBlur={() => commitSource(tab)}
            onChange={(source) => updateSource(tab, source)}
        />
    );

    return (
        <Dialog open={controller.open} onOpenChange={controller.onOpenChange}>
            <DialogContent
                ref={popupReference}
                initialFocus={popupReference}
                className="grid h-[min(760px,calc(100vh-48px))] w-[min(920px,calc(100vw-48px))] grid-rows-[auto_auto_minmax(0,1fr)] overflow-hidden"
            >
                <DialogHeader>
                    <DialogTitle>Settings</DialogTitle>
                    <DialogDescription>
                        Changes apply immediately and are stored as editable files.
                    </DialogDescription>
                </DialogHeader>
                <div className="flex">
                    <ChromeTabs
                        ariaLabel="Settings sections"
                        className="flex flex-1"
                        idPrefix="settings"
                        items={CONFIG_KINDS.map((value) => ({
                            value,
                            label: value[0].toUpperCase() + value.slice(1),
                            content: value[0].toUpperCase() + value.slice(1),
                        }))}
                        tabClassName="min-h-9 px-4"
                        value={tab}
                        onValueChange={controller.changeTab}
                    />
                    <ToggleGroup
                        aria-label="Settings view"
                        className="my-1 mr-2"
                        value={[view]}
                        onValueChange={(next: Array<'ui' | 'source'>) => {
                            // Base UI reports re-activating the selected segment as an empty
                            // selection; the view toggle must stay on the current view instead of
                            // snapping back to UI.
                            if (next.length === 0) return;
                            const nextView = next[0];
                            if (nextView === 'source') controller.showSource();
                            else controller.showUi();
                        }}
                    >
                        <Tooltip content="UI">
                            <ToggleGroupItem aria-label="UI" size="dense" value="ui">
                                <SlidersHorizontal size={14} />
                            </ToggleGroupItem>
                        </Tooltip>
                        <Tooltip content="Source">
                            <ToggleGroupItem aria-label="Source" size="dense" value="source">
                                <Braces size={14} />
                            </ToggleGroupItem>
                        </Tooltip>
                    </ToggleGroup>
                </div>

                <ChromeTabPanel
                    active={tab === 'settings'}
                    className="grid min-h-0 overflow-hidden"
                    idPrefix="settings"
                    value="settings"
                >
                    {tab === 'settings' &&
                        state.settings.value &&
                        (view === 'source' ? (
                            sourceView
                        ) : (
                            <SettingsPage
                                key={
                                    controller.notificationsFocusRequestId ??
                                    controller.agentActionsFocusRequest?.id ??
                                    'settings'
                                }
                                agentActionsFocusRequest={controller.agentActionsFocusRequest}
                                notificationsFocusRequestId={controller.notificationsFocusRequestId}
                                agentHookHealth={controller.agentHookHealth}
                                agentSkillHealth={controller.agentSkillHealth}
                                argvConfig={controller.argvConfig}
                                gitExclusionsFocusRequestId={controller.gitExclusionsFocusRequestId}
                                hardwareAccelerationFocusRequestId={
                                    controller.hardwareAccelerationFocusRequestId
                                }
                                settings={state.settings.value}
                                trustedDomainsFocusRequestId={
                                    controller.trustedDomainsFocusRequestId
                                }
                                onArgvConfigChange={controller.updateArgvConfig}
                                onFieldChange={controller.updateSettingsField}
                            />
                        ))}
                </ChromeTabPanel>

                <ChromeTabPanel
                    active={tab === 'keybindings'}
                    className="grid min-h-0 overflow-hidden"
                    idPrefix="settings"
                    value="keybindings"
                >
                    {tab === 'keybindings' &&
                        (view === 'source' ? (
                            sourceView
                        ) : (
                            <KeybindingsForm
                                focusRequestId={controller.keybindingsFocusRequestId}
                                keybindings={state.keybindings.value}
                                onAdd={controller.addBinding}
                                onChange={controller.updateBinding}
                                onRemove={controller.removeBinding}
                            />
                        ))}
                </ChromeTabPanel>

                <ChromeTabPanel
                    active={tab === 'theme'}
                    className="grid min-h-0 overflow-hidden"
                    idPrefix="settings"
                    value="theme"
                >
                    {tab === 'theme' &&
                        state.theme.value &&
                        (view === 'source' ? (
                            sourceView
                        ) : (
                            <ThemeForm
                                theme={state.theme.value}
                                onColorChange={controller.updateThemeColor}
                                onImport={() => {
                                    // eslint-disable-next-line no-void -- intentional floating-promise discard, importTheme() reports its own errors
                                    void controller.importTheme();
                                }}
                                onSelectBuiltin={controller.selectBuiltinTheme}
                            />
                        ))}
                </ChromeTabPanel>
            </DialogContent>
        </Dialog>
    );
}

export function SettingsDialog() {
    const controller = useSettingsDialogController();
    return <SettingsDialogView {...controller} />;
}
