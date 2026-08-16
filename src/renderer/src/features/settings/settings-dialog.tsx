import { useRef } from 'react';

import { Braces, FileJson, SlidersHorizontal } from 'lucide-react';

import { ChromeTabPanel, ChromeTabs } from '../../components/chrome-tabs';
import { Button } from '../../components/ui/button';
import {
    Dialog,
    DialogContent,
    DialogDescription,
    DialogHeader,
    DialogTitle,
} from '../../components/ui/dialog';
import { caxri } from '../../lib/caxri';
import { CONFIG_FILE_NAMES, CONFIG_KINDS } from './config-edit';
import { ConfigSourceView } from './config-source-view';
import { KeybindingsForm } from './keybindings-form';
import { SettingsPage } from './settings-page';
import { ThemeForm } from './theme-form';
import type { SettingsDialogController } from './use-settings-dialog-controller';
import { onSettingsError, useSettingsDialogController } from './use-settings-dialog-controller';

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
                className="grid h-[min(760px,calc(100vh-48px))] w-[min(920px,calc(100vw-48px))] grid-rows-[auto_auto_minmax(0,1fr)_auto] overflow-hidden"
            >
                <DialogHeader>
                    <DialogTitle>Settings</DialogTitle>
                    <DialogDescription>
                        Changes apply immediately and are stored as editable files.
                    </DialogDescription>
                </DialogHeader>
                <div className="flex border-b border-border">
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
                    <Button
                        aria-label={
                            view === 'ui'
                                ? `Open ${CONFIG_FILE_NAMES[tab]} Source`
                                : `Back to ${tab[0].toUpperCase() + tab.slice(1)} UI`
                        }
                        aria-pressed={view === 'source'}
                        className="my-1 mr-2"
                        size="sm"
                        variant="ghost"
                        onClick={view === 'ui' ? controller.showSource : controller.showUi}
                    >
                        {view === 'ui' ? <Braces size={14} /> : <SlidersHorizontal size={14} />}
                        {view === 'ui' ? 'Source' : 'UI'}
                    </Button>
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
                                agentHookHealth={controller.agentHookHealth}
                                agentSkillHealth={controller.agentSkillHealth}
                                argvConfig={controller.argvConfig}
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
                            />
                        ))}
                </ChromeTabPanel>

                <footer className="dialog-actions flex justify-end gap-2 border-t border-border px-3 py-2">
                    <Button
                        variant="ghost"
                        onClick={() => {
                            async function openConfigFile(): Promise<void> {
                                try {
                                    await caxri.request('app.openConfigFile', { kind: tab });
                                } catch (error: unknown) {
                                    onSettingsError(error, 'Unable to open the config file');
                                }
                            }
                            // eslint-disable-next-line no-void -- intentional floating-promise discard, see above
                            void openConfigFile();
                        }}
                    >
                        <FileJson size={14} /> Open Config File
                    </Button>
                </footer>
            </DialogContent>
        </Dialog>
    );
}

export function SettingsDialog() {
    const controller = useSettingsDialogController();
    return <SettingsDialogView {...controller} />;
}
