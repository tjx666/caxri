import type { ReactNode } from 'react';
import { useState } from 'react';

import { Braces, SlidersHorizontal } from 'lucide-react';

import { ToggleGroup, ToggleGroupItem } from '../../components/ui/toggle-group';
import { Tooltip } from '../../components/ui/tooltip';
import { useTranslation } from '../../i18n';
import { useIsLocalOnlyAvailable } from '../../stores/environment';
import { ConfigSourceView } from './config-source-view';
import { KeybindingsForm } from './keybindings-form';
import { SettingsNavigation } from './settings-navigation';
import type { SettingsNavigationState } from './settings-page';
import { SettingsPage } from './settings-page';
import { useSettingsRegistry } from './settings-registry';
import { ThemeForm } from './theme-form';
import type { SettingsPageController } from './use-settings-page-controller';
import { useSettingsPageController } from './use-settings-page-controller';

/**
 * Same header copy and classes as the former `DialogHeader`/`DialogTitle`/`DialogDescription` trio, reproduced as plain
 * markup: a Workbench tab has no popup chrome to draw them from. A surface that needs its own close control passes it
 * as `headerAction`, which sits in the header after the view toggle instead of floating over it.
 */
function SettingsWorkbenchView({
    headerAction,
    ...controller
}: SettingsPageController & { headerAction?: ReactNode }) {
    const { commitSource, sourceErrors, state, tab, updateSource, view } = controller;
    const { t } = useTranslation();
    const canImportTheme = useIsLocalOnlyAvailable();
    const { categories } = useSettingsRegistry();
    const [navigationState, setNavigationState] = useState<SettingsNavigationState>();

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

    let content: ReactNode;
    if (view === 'source') content = sourceView;
    else if (tab === 'settings')
        content = state.settings.value && (
            <SettingsPage
                key={
                    controller.notificationsFocusRequestId ??
                    controller.agentActionsFocusRequest?.id ??
                    controller.agentExecutableFocusRequest?.id ??
                    'settings'
                }
                agentActionsFocusRequest={controller.agentActionsFocusRequest}
                agentExecutableFocusRequest={controller.agentExecutableFocusRequest}
                anchorRequest={controller.anchorRequest}
                onAnchorRequestHandled={controller.completeAnchorRequest}
                notificationsFocusRequestId={controller.notificationsFocusRequestId}
                agentHookHealth={controller.agentHookHealth}
                agentSkillHealth={controller.agentSkillHealth}
                argvConfig={controller.argvConfig}
                gitExclusionsFocusRequestId={controller.gitExclusionsFocusRequestId}
                rowFocusRequest={controller.rowFocusRequest}
                searchFocusRequestId={controller.searchFocusRequestId}
                settings={state.settings.value}
                trustedDomainsFocusRequestId={controller.trustedDomainsFocusRequestId}
                onArgvConfigChange={controller.updateArgvConfig}
                onFieldChange={controller.updateSettingsField}
                onNavigationStateChange={setNavigationState}
            />
        );
    else if (tab === 'keybindings')
        content = (
            <KeybindingsForm
                focusRequestId={controller.keybindingsFocusRequestId}
                keybindings={state.keybindings.value}
                onAdd={controller.addBinding}
                onChange={controller.updateBinding}
                onRemove={controller.removeBinding}
            />
        );
    else
        content = state.theme.value && (
            <ThemeForm
                importResult={controller.themeImportResult}
                theme={state.theme.value}
                warnings={state.theme.warnings}
                onColorChange={controller.updateThemeColor}
                onDismissImportResult={controller.dismissThemeImportResult}
                onImport={
                    canImportTheme
                        ? () => {
                              void controller.importTheme();
                          }
                        : undefined
                }
                onSelectBuiltin={controller.selectBuiltinTheme}
            />
        );

    return (
        // `data-settings-page`: the former `role="dialog"` gave E2E a stable scope to query within; a Workbench tab
        // has no such role, so this attribute is the replacement scoping hook (`openSettingsTab` in
        // `e2e/support/settings.ts`).
        //
        // The page keeps a minimum width and scrolls sideways below it. Squeezed into a narrow split group, the 168px
        // navigation left the content a sliver and zh-CN labels wrapped one character per line.
        <div className="h-full overflow-x-auto overflow-y-hidden">
            <div
                data-settings-page
                className="grid h-full min-w-[30rem] grid-rows-[auto_minmax(0,1fr)] overflow-hidden"
            >
                {/*
                 * One `bg-surface` header band over the `bg-background` content: a background step, not a hairline
                 * (see `renderer-design-contract.test.ts`). The Workbench tab already says "Settings", so the heading
                 * stays for assistive tech alone.
                 */}
                <div className="flex items-center gap-3 bg-surface py-2 pr-2 pl-4">
                    <h1 className="sr-only">{t('settings.page.heading')}</h1>
                    <p className="m-0 min-w-0 flex-1 text-[11px] leading-[1.45] text-muted">
                        {t('settings.page.intro')}
                    </p>
                    <ToggleGroup
                        aria-label={t('settings.page.viewToggle')}
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
                        <Tooltip content={t('settings.page.view.ui')}>
                            <ToggleGroupItem
                                aria-label={t('settings.page.view.ui')}
                                size="dense"
                                value="ui"
                            >
                                <SlidersHorizontal size={14} />
                            </ToggleGroupItem>
                        </Tooltip>
                        <Tooltip content={t('settings.page.view.source')}>
                            <ToggleGroupItem
                                aria-label={t('settings.page.view.source')}
                                size="dense"
                                value="source"
                            >
                                <Braces size={14} />
                            </ToggleGroupItem>
                        </Tooltip>
                    </ToggleGroup>
                    {headerAction}
                </div>
                <div className="grid min-h-0 grid-cols-[168px_minmax(0,1fr)] overflow-hidden">
                    <SettingsNavigation
                        activeAnchor={navigationState?.activeAnchor}
                        categories={categories}
                        counts={navigationState?.counts}
                        searching={navigationState?.searching}
                        section={tab}
                        onNavigate={controller.navigateToAnchor}
                        onSectionChange={controller.changeTab}
                    />
                    <div className="grid min-h-0 overflow-hidden">{content}</div>
                </div>
            </div>
        </div>
    );
}

/**
 * The Settings surface as a Workbench document tab (`caxri-settings://workbench`) instead of a fixed-size modal, so a
 * wide window can show a whole section without scrolling the container itself: only a section's own content scrolls.
 * Mounted only while its tab is the active one in its pane, exactly like every other document tab, which is also why
 * every load below runs unconditionally rather than behind an `isOpen` gate: rendering this component at all already
 * means Settings is open.
 *
 * Deliberately NOT registered with `useModalRegistration` (issue caxri#1289): Settings opens into the selected
 * Session's own pane layout now, so it must behave exactly like any other document tab, including standing aside for a
 * Session-switch gesture the same way a Terminal or editor tab would. Registering it as a modal was tried and reverted:
 * `useDialogStore.isModalOpen()` also gates every keyboard shortcut in `use-command-shortcuts.ts` (checked before a
 * command ever reaches `runCommand`), so it would have blocked `Cmd+W` itself while this tab was active: an open
 * Settings tab could never be closed from the keyboard again.
 */
export function SettingsWorkbenchPage({ headerAction }: { headerAction?: ReactNode } = {}) {
    const controller = useSettingsPageController();
    return <SettingsWorkbenchView {...controller} headerAction={headerAction} />;
}
