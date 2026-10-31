import type { ReactNode } from 'react';
import { useState } from 'react';

import type { AppSettings, SystemColorScheme } from '@caxri/protocol';
import { resolveEffectiveTheme } from '@caxri/protocol';
import { ArrowLeft, Braces, SlidersHorizontal } from 'lucide-react';

import { SurfaceErrorBoundary } from '../../components/surface-error-boundary';
import { Button } from '../../components/ui/button';
import { ToggleGroup, ToggleGroupItem } from '../../components/ui/toggle-group';
import { Tooltip } from '../../components/ui/tooltip';
import { useSystemColorScheme } from '../../hooks/use-system-color-scheme';
import { useTranslation } from '../../i18n';
import { useCommandShortcut } from '../../lib/keybindings';
import { cn } from '../../lib/utilities';
import { isPrimarySidebarShown, useChromeLayoutStore } from '../../stores/chrome-layout';
import { closeSettings } from '../../stores/dialogs';
import { useIsLocalOnlyAvailable } from '../../stores/environment';
import { useIsFullScreen } from '../../stores/selectors';
import { ConfigSourceView } from './config-source-view';
import type { SettingsPageController } from './hooks/use-settings-page-controller';
import { useSettingsPageController } from './hooks/use-settings-page-controller';
import { KeybindingsForm } from './keybindings-form';
import { SettingsNavigation } from './settings-navigation';
import type { SettingsNavigationState } from './settings-page';
import { SettingsPage } from './settings-page';
import { useSettingsRegistry } from './settings-registry';
import { ThemeForm } from './theme-form';

function readThemeAppearance(settings: AppSettings | undefined) {
    return {
        isFollowingSystem: settings?.['workbench.theme.followSystem'] === true,
        lightThemeId: settings?.['workbench.theme.light'] ?? '',
        darkThemeId: settings?.['workbench.theme.dark'] ?? '',
    };
}

/**
 * Writes one slot of the follow-system pair. The Theme tab's picker only offers the presets of `scheme`, which
 * `theme-appearance.test.ts` pins to the options of these two settings, so the casts only narrow what is already true.
 */
function setPreferredTheme(
    update: SettingsPageController['updateSettingsField'],
    scheme: SystemColorScheme,
    id: string,
): void {
    if (scheme === 'light')
        update('workbench.theme.light', id as AppSettings['workbench.theme.light']);
    else update('workbench.theme.dark', id as AppSettings['workbench.theme.dark']);
}

/**
 * The page's header takes the place of the Workbench's root tab bar, so it is the window's title bar too: the same
 * fill, drag region, and windowed traffic-light inset. It leads with Back, the way the full-page settings of comparable
 * apps return to where the user was, and names the page visibly: with no tab above it, nothing else on screen says
 * "Settings".
 */
function SettingsPageTitleBar({ children }: { children: ReactNode }) {
    const { t } = useTranslation();
    const closeShortcut = useCommandShortcut('settings.close');
    const isPrimarySidebarVisible = useChromeLayoutStore(isPrimarySidebarShown);
    const isFullScreen = useIsFullScreen();
    return (
        <div
            className={cn(
                'flex h-9 items-center gap-3 bg-title-bar-active-background pr-2 pl-2 text-title-bar-active-foreground [-webkit-app-region:drag] window-inactive:bg-title-bar-inactive-background window-inactive:text-title-bar-inactive-foreground',
                !isPrimarySidebarVisible && !isFullScreen && 'pl-(--traffic-light-clearance)',
            )}
        >
            <Tooltip content={t('settings.page.backTooltip')} shortcut={closeShortcut}>
                <Button
                    className="[-webkit-app-region:no-drag]"
                    size="sm"
                    variant="ghost"
                    onClick={() => closeSettings({ restoreFocus: true })}
                >
                    <ArrowLeft size={14} />
                    {t('settings.page.back')}
                </Button>
            </Tooltip>
            <h1 className="m-0 shrink-0 text-[13px] font-semibold">{t('settings.page.heading')}</h1>
            {children}
        </div>
    );
}

function SettingsWorkbenchView(controller: SettingsPageController) {
    const { commitSource, sourceErrors, state, tab, updateSource, view } = controller;
    const { t } = useTranslation();
    const canImportTheme = useIsLocalOnlyAvailable();
    const { categories } = useSettingsRegistry();
    const [navigationState, setNavigationState] = useState<SettingsNavigationState>();
    const systemScheme = useSystemColorScheme();
    const settings = state.settings.value;
    const effectiveTheme =
        settings && state.theme.value
            ? resolveEffectiveTheme(state.theme.value, settings, systemScheme)
            : undefined;

    /**
     * Turning the pair off keeps what is on screen: the preset the system appearance resolved to becomes the single
     * saved theme, so the switch changes who decides the theme, not the theme itself.
     */
    const setFollowSystemAppearance = (isFollowing: boolean): void => {
        if (!isFollowing && effectiveTheme) controller.selectBuiltinTheme(effectiveTheme.id);
        controller.updateSettingsField('workbench.theme.followSystem', isFollowing);
    };

    const sourceView = state.theme.value && (
        <ConfigSourceView
            key={tab}
            error={sourceErrors[tab]}
            kind={tab}
            source={state[tab].source}
            theme={effectiveTheme ?? state.theme.value}
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
                appearance={{
                    ...readThemeAppearance(settings),
                    effectiveTheme: effectiveTheme ?? state.theme.value,
                    systemScheme,
                    onPreferredThemeChange: (scheme, id) =>
                        setPreferredTheme(controller.updateSettingsField, scheme, id),
                    onFollowSystemChange: setFollowSystemAppearance,
                }}
            />
        );

    return (
        // `data-settings-page`: the page has no dialog role, so this attribute is the scope E2E queries within
        // (`openSettingsPage` in `e2e/support/settings.ts`) and the boundary `settings.close` reads to decide whether
        // `Escape` belongs to the page.
        //
        // The page keeps a minimum width and scrolls sideways below it, so a narrow window never squeezes the 168px
        // navigation's content into a sliver where zh-CN labels wrap one character per line.
        <div className="h-full overflow-x-auto overflow-y-hidden">
            <div
                data-settings-page
                className="grid h-full min-w-[30rem] grid-rows-[auto_minmax(0,1fr)] overflow-hidden"
            >
                {/* A background step over the `bg-background` content, not a hairline (see `renderer-design-contract.test.ts`). */}
                <SettingsPageTitleBar>
                    <p className="m-0 min-w-0 flex-1 truncate text-[11px] leading-[1.45] text-muted">
                        {t('settings.page.intro')}
                    </p>
                    <ToggleGroup
                        aria-label={t('settings.page.viewToggle')}
                        className="[-webkit-app-region:no-drag]"
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
                </SettingsPageTitleBar>
                <div className="grid min-h-0 grid-cols-[168px_minmax(0,1fr)] overflow-hidden">
                    <SettingsNavigation
                        activeAnchor={navigationState?.activeAnchor}
                        categories={categories}
                        counts={navigationState?.counts}
                        searching={navigationState?.searching}
                        filtered={navigationState?.filtered}
                        section={tab}
                        onNavigate={controller.navigateToAnchor}
                        onSectionChange={controller.changeTab}
                    />
                    <div className="grid min-h-0 overflow-hidden">
                        <SurfaceErrorBoundary resetKey={`${view}:${tab}`} scope="settings">
                            {content}
                        </SurfaceErrorBoundary>
                    </div>
                </div>
            </div>
        </div>
    );
}

/**
 * The Settings surface: a window-level page over the Workbench (`SettingsPageHost`), so a wide window can show a whole
 * section without scrolling the container itself: only a section's own content scrolls.
 *
 * Deliberately NOT registered with `useModalRegistration` (issue caxri#1289): `useDialogStore.isModalOpen()` gates
 * every keyboard shortcut in `use-command-shortcuts.ts` before a command reaches `runCommand`, so a modal Settings
 * would swallow `Escape`, `Cmd+W`, and the Session-switch gestures that are supposed to leave it.
 */
export function SettingsWorkbenchPage() {
    const controller = useSettingsPageController();
    return <SettingsWorkbenchView {...controller} />;
}
