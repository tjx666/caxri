import { useState } from 'react';

import type { AppSettings, SystemColorScheme, ThemeTokens } from '@caxri/protocol';
import { builtinThemes, defaultThemeIdForScheme, themeColorScheme } from '@caxri/protocol';
import { Trash2, X } from 'lucide-react';

import { Alert } from '../../components/ui/alert';
import { Button } from '../../components/ui/button';
import { Tooltip } from '../../components/ui/tooltip';
import { useTranslation } from '../../i18n';
import { caxri } from '../../lib/caxri';
import { useImportedThemes } from '../../stores/selectors';
import type { ImportedThemeUsageInput, ImportedThemeUse } from './imported-theme-usage';
import { importedThemeUses } from './imported-theme-usage';
import { removeImportedTheme } from './settings-client';
import { reportSettingsError } from './settings-error-report';

const USE_LABEL_KEYS = {
    current: 'settings.themeEditor.imported.currentTheme',
    light: 'settings.themeEditor.preferred.light',
    dark: 'settings.themeEditor.preferred.dark',
} as const satisfies Record<ImportedThemeUse, string>;

type ThemeSlots = Pick<AppSettings, 'workbench.theme.dark' | 'workbench.theme.light'>;

/**
 * The slots that name `id`, which the Server sends back to their default preset when that theme is removed.
 */
function slotsNaming(slots: ThemeSlots, id: string): SystemColorScheme[] {
    return (['light', 'dark'] as const).filter(
        (scheme) => slots[`workbench.theme.${scheme}`] === id,
    );
}

/**
 * Every theme Import Theme saved, each with Remove. Removing one that a light or dark slot names sends that slot back
 * to its default preset, and the notice says so once, since the window may repaint in a theme the user did not pick.
 */
export function ImportedThemesSection({ usage }: { usage: ImportedThemeUsageInput }) {
    const { t } = useTranslation();
    const slots: ThemeSlots = {
        'workbench.theme.light': usage.lightThemeId,
        'workbench.theme.dark': usage.darkThemeId,
    };
    const importedThemes = useImportedThemes();
    const [notice, setNotice] = useState<readonly string[]>();
    if (!notice && importedThemes.length === 0) return null;

    const presetName = (scheme: SystemColorScheme): string =>
        builtinThemes.find(({ id }) => id === defaultThemeIdForScheme(scheme))?.name ??
        defaultThemeIdForScheme(scheme);

    /**
     * A theme that paints right now is confirmed first, because the window may repaint in a theme the user did not
     * pick.
     */
    const confirmRemoval = (
        theme: ThemeTokens,
        uses: readonly ImportedThemeUse[],
    ): Promise<boolean> =>
        caxri.window.showConfirm({
            title: t('settings.themeEditor.imported.confirmTitle', { theme: theme.name }),
            message: [
                ...uses.map((use) =>
                    use === 'current'
                        ? t('settings.themeEditor.imported.confirmCurrent', { theme: theme.name })
                        : t('settings.themeEditor.imported.confirmSlot', {
                              slot: t(`settings.themeEditor.preferred.${use}`),
                              theme: presetName(use),
                          }),
                ),
                t('settings.themeEditor.imported.confirmReimport'),
            ].join(t('settings.themeEditor.imported.sentenceJoiner')),
            confirmLabel: t('settings.themeEditor.imported.remove'),
        });

    const remove = async (theme: ThemeTokens): Promise<void> => {
        const uses = importedThemeUses(theme.id, usage);
        if (uses.length > 0 && !(await confirmRemoval(theme, uses))) return;
        const released = slotsNaming(slots, theme.id);
        try {
            await removeImportedTheme(theme.id);
        } catch (error) {
            reportSettingsError(error, t('settings.themeEditor.imported.title'));
            return;
        }
        const fallbacks = released.map((scheme) =>
            t('settings.themeEditor.imported.slotReset', {
                slot: t(`settings.themeEditor.preferred.${scheme}`),
                theme: presetName(scheme),
            }),
        );
        // One sentence per line: joining them with a space would leave a stray gap after a Chinese full stop.
        setNotice([
            t('settings.themeEditor.imported.removed', { theme: theme.name }),
            ...fallbacks,
        ]);
    };

    return (
        <fieldset className="my-3 min-w-0 border-0 p-0">
            <legend className="mb-2 text-[11px] font-semibold text-foreground uppercase">
                {t('settings.themeEditor.imported.title')}
            </legend>
            {notice && (
                <Alert
                    variant="info"
                    role="status"
                    className="mb-2 flex items-start justify-between gap-2"
                >
                    <span className="flex flex-col">
                        {notice.map((sentence) => (
                            <span key={sentence}>{sentence}</span>
                        ))}
                    </span>
                    <Tooltip content={t('common.dismiss')}>
                        <Button
                            size="icon"
                            variant="ghost"
                            className="size-6 shrink-0"
                            aria-label={t('common.dismiss')}
                            onClick={() => setNotice(undefined)}
                        >
                            <X aria-hidden="true" size={12} />
                        </Button>
                    </Tooltip>
                </Alert>
            )}
            <ul className="m-0 list-none p-0">
                {importedThemes.map((theme) => {
                    const uses = importedThemeUses(theme.id, usage);
                    return (
                        <li
                            key={theme.id}
                            className="flex min-w-0 items-center gap-2 rounded px-1 py-1 hover:bg-state-hover-quiet"
                        >
                            <span className="min-w-0 flex-1 truncate text-[11px] text-foreground">
                                {theme.name}
                            </span>
                            <span className="shrink-0 text-[11px] text-muted">
                                {t(
                                    `settings.themeEditor.imported.scheme.${themeColorScheme(theme)}`,
                                )}
                            </span>
                            {uses.length > 0 && (
                                <span className="shrink-0 text-[11px] text-muted">
                                    {uses
                                        .map((use) => t(USE_LABEL_KEYS[use]))
                                        .join(t('settings.themeEditor.imported.badgeJoiner'))}
                                </span>
                            )}
                            <Tooltip content={t('settings.themeEditor.imported.remove')}>
                                <Button
                                    size="icon"
                                    variant="ghost"
                                    className="size-6 shrink-0"
                                    aria-label={t('settings.themeEditor.imported.removeNamed', {
                                        theme: theme.name,
                                    })}
                                    onClick={() => {
                                        void remove(theme);
                                    }}
                                >
                                    <Trash2 aria-hidden="true" size={12} />
                                </Button>
                            </Tooltip>
                        </li>
                    );
                })}
            </ul>
        </fieldset>
    );
}
