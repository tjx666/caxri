import { Braces, SlidersHorizontal } from 'lucide-react';

import { ChromeTabPanel, ChromeTabs } from '../../components/chrome-tabs';
import { ToggleGroup, ToggleGroupItem } from '../../components/ui/toggle-group';
import { Tooltip } from '../../components/ui/tooltip';
import { CONFIG_KINDS } from './config-edit';
import { ConfigSourceView } from './config-source-view';
import { KeybindingsForm } from './keybindings-form';
import { SettingsPage } from './settings-page';
import { ThemeForm } from './theme-form';
import type { SettingsPageController } from './use-settings-page-controller';
import { useSettingsPageController } from './use-settings-page-controller';

/**
 * Same header copy and classes as the former `DialogHeader`/`DialogTitle`/`DialogDescription` trio, reproduced as plain
 * markup: a Workbench tab has no popup chrome to draw them from and no close button to reserve `pr-12` for.
 */
function SettingsWorkbenchView(controller: SettingsPageController) {
    const { commitSource, sourceErrors, state, tab, updateSource, view } = controller;

    const sourceView = state.theme.value && (
        <ConfigSourceView
            key={tab}
            error={sourceErrors[tab]}
            kind={tab}
            source={state[tab].source}
            theme={state.theme.value}
            onBlur={() => commitSource(tab)}
            onChange={(source) => updateSource(tab, source)}
            onRevert={() => updateSource(tab, state[tab].appliedSource)}
        />
    );

    return (
        // `data-settings-page`: the former `role="dialog"` gave E2E a stable scope to query within; a Workbench tab
        // has no such role, so this attribute is the replacement scoping hook (`openSettingsTab` in
        // `e2e/support/helpers.ts`).
        <div
            data-settings-page
            className="grid h-full grid-rows-[auto_auto_minmax(0,1fr)] overflow-hidden"
        >
            <div className="bg-surface pt-4 pr-4 pb-3 pl-4">
                <h1 className="m-0 text-[15px] font-semibold">Settings</h1>
                <p className="mt-1 mb-0 text-[11px] leading-[1.45] text-muted">
                    Changes apply immediately and are stored as editable files.
                </p>
            </div>
            {/*
             * The title and tab strip form one `bg-surface` header band over the `bg-background` content — a
             * background step, not a hairline (see `renderer-design-contract.test.ts`). The shared tab fill used to
             * stop at the last tab and read as a stray block. `pl-1` plus each tab's `px-3` lines the first label up
             * with the `pl-4` title.
             */}
            <div className="flex items-center bg-surface pl-1">
                <ChromeTabs
                    ariaLabel="Settings sections"
                    className="flex flex-1 self-stretch"
                    idPrefix="settings"
                    items={CONFIG_KINDS.map((value) => ({
                        value,
                        label: value[0].toUpperCase() + value.slice(1),
                        content: value[0].toUpperCase() + value.slice(1),
                    }))}
                    tabClassName="min-h-9 px-3"
                    value={tab}
                    onValueChange={controller.changeTab}
                />
                <ToggleGroup
                    aria-label="Settings view"
                    className="mr-2"
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
                            argvRowFocusRequest={controller.argvRowFocusRequest}
                            searchFocusRequestId={controller.searchFocusRequestId}
                            settings={state.settings.value}
                            trustedDomainsFocusRequestId={controller.trustedDomainsFocusRequestId}
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
                            importResult={controller.themeImportResult}
                            theme={state.theme.value}
                            warnings={state.theme.warnings}
                            onColorChange={controller.updateThemeColor}
                            onDismissImportResult={controller.dismissThemeImportResult}
                            onImport={() => {
                                // eslint-disable-next-line no-void -- intentional floating-promise discard, importTheme() reports its own errors
                                void controller.importTheme();
                            }}
                            onSelectBuiltin={controller.selectBuiltinTheme}
                        />
                    ))}
            </ChromeTabPanel>
        </div>
    );
}

/**
 * The Settings surface as a Workbench document tab (`caxri-settings://workbench`) instead of a fixed-size modal, so a
 * wide window can show a whole section without scrolling the container itself — only a section's own content scrolls.
 * Mounted only while its tab is the active one in its pane, exactly like every other document tab, which is also why
 * every load below runs unconditionally rather than behind an `isOpen` gate: rendering this component at all already
 * means Settings is open.
 *
 * Deliberately NOT registered with `useModalRegistration` (issue caxri#1289): Settings opens into the selected
 * Session's own pane layout now, so it must behave exactly like any other document tab — including standing aside for a
 * Session-switch gesture the same way a Terminal or editor tab would. Registering it as a modal was tried and reverted:
 * `useDialogStore.isModalOpen()` also gates every keyboard shortcut in `use-command-shortcuts.ts` (checked before a
 * command ever reaches `runCommand`), so it would have blocked `Cmd+W` itself while this tab was active — an open
 * Settings tab could never be closed from the keyboard again.
 */
export function SettingsWorkbenchPage() {
    const controller = useSettingsPageController();
    return <SettingsWorkbenchView {...controller} />;
}
