import { useState } from 'react';

import type { SystemColorScheme, ThemeImportWarning, ThemeTokens } from '@caxri/protocol';
import {
    builtinThemes,
    defaultThemeIdForScheme,
    findMatchingBuiltinTheme,
    themeSlotOptions,
} from '@caxri/protocol';
import { Import, X } from 'lucide-react';

import { Alert } from '../../components/ui/alert';
import { Button } from '../../components/ui/button';
import { Field, FieldLabel } from '../../components/ui/field';
import {
    Select,
    SelectContent,
    SelectGroup,
    SelectItem,
    SelectLabel,
    SelectTrigger,
    SelectValue,
} from '../../components/ui/select';
import { Tooltip } from '../../components/ui/tooltip';
import { useTranslation } from '../../i18n';
import { cn } from '../../lib/utilities';
import { useImportedThemes } from '../../stores/selectors';
import { ImportedThemesSection } from './imported-themes-section';
import { SHORT_CONTROL_WIDTH_CLASS_NAME } from './setting-row-layout';
import {
    cardSliceClassName,
    SETTINGS_COLUMN_CLASS_NAME,
    SETTINGS_GROUP_HEADING_CLASS_NAME,
    SETTINGS_SOLO_CARD_CLASS_NAME,
} from './settings-card';
import type { SettingsCardPosition } from './settings-search';
import type { ThemeImportResult } from './theme-import-error';
import { themeImportWarningText } from './theme-import-warning-copy';
import {
    dismissThemeImportWarning,
    readThemeImportWarningDismissals,
    themeImportWarningDismissGeneration,
} from './theme-import-warnings';
import { ThemePreview } from './theme-preview';
import { humanizeThemeTokenLabel } from './theme-token-labels';

interface ThemeFormProperties {
    theme: ThemeTokens;
    warnings: readonly ThemeImportWarning[];
    importResult?: ThemeImportResult;
    onColorChange: (section: 'colors' | 'terminal' | 'editor', key: string, value: string) => void;
    onDismissImportResult: () => void;
    /**
     * Omitted in an SSH Host window: the import reads a file picked on this Mac, which the SSH Host's Server cannot
     * see.
     */
    onImport?: () => void;
    onSelectTheme: (id: string) => void;
    /**
     * "Follow system appearance" state. While `isFollowingSystem`, `theme` is what `theme.json` holds, not what is
     * painted, so the form shows the notice and the effective theme's preview instead of the editor.
     */
    appearance: {
        isFollowingSystem: boolean;
        effectiveTheme: ThemeTokens;
        /**
         * The system appearance resolved right now; decides which of the two pickers is marked active.
         */
        systemScheme: SystemColorScheme;
        lightThemeId: string;
        darkThemeId: string;
        onPreferredThemeChange: (scheme: SystemColorScheme, id: string) => void;
        onFollowSystemChange: (isFollowing: boolean) => void;
    };
}

/**
 * Full-width structured editor and live preview for `theme.json`.
 */
export function ThemeForm({
    theme,
    warnings,
    importResult,
    onColorChange,
    onDismissImportResult,
    onImport,
    onSelectTheme,
    appearance,
}: ThemeFormProperties) {
    const { t } = useTranslation();
    const importedThemes = useImportedThemes();
    const usage = {
        currentThemeId: theme.id,
        isFollowingSystem: appearance.isFollowingSystem,
        lightThemeId: appearance.lightThemeId,
        darkThemeId: appearance.darkThemeId,
    };
    const importResultAlert = importResult && (
        <Alert
            variant={importResult.kind === 'failed' ? 'danger' : 'info'}
            className="mb-3 flex items-start justify-between gap-2"
            {...(importResult.kind === 'imported' && { role: 'status' })}
        >
            <span>
                {importResult.kind === 'failed'
                    ? importResult.message
                    : t('settings.themeEditor.importSucceeded', {
                          theme: importResult.themeName,
                      })}
            </span>
            <Tooltip content={t('common.dismiss')}>
                <Button
                    size="icon"
                    variant="ghost"
                    className="size-6 shrink-0"
                    aria-label={t('settings.themeEditor.dismissImportResult')}
                    onClick={onDismissImportResult}
                >
                    <X aria-hidden="true" size={12} />
                </Button>
            </Tooltip>
        </Alert>
    );
    const importButton = onImport && (
        <Button size="sm" variant="secondary" className="shrink-0" onClick={onImport}>
            <Import size={13} /> {t('settings.themeEditor.importTheme')}
        </Button>
    );
    if (appearance.isFollowingSystem)
        return (
            <div className="flex h-full min-h-0 flex-col overflow-hidden">
                <div className="theme-editor structured-editor min-h-0 flex-1 overflow-auto px-8 pt-6 pb-16">
                    <div className={SETTINGS_COLUMN_CLASS_NAME}>
                        {importResultAlert}
                        <div className="mb-3 flex items-center justify-between gap-3 text-[12px] text-muted">
                            <span role="status">{t('settings.themeEditor.followingNotice')}</span>
                            <span className="flex shrink-0 items-center gap-2">
                                {importButton}
                                <Button
                                    size="sm"
                                    variant="secondary"
                                    className="shrink-0"
                                    onClick={() => appearance.onFollowSystemChange(false)}
                                >
                                    {t('settings.themeEditor.useSingleTheme')}
                                </Button>
                            </span>
                        </div>
                        <div className="mb-3">
                            {(['light', 'dark'] as const).map((scheme) => (
                                <PreferredThemeField
                                    key={scheme}
                                    card={{ first: scheme === 'light', last: scheme === 'dark' }}
                                    scheme={scheme}
                                    value={
                                        scheme === 'light'
                                            ? appearance.lightThemeId
                                            : appearance.darkThemeId
                                    }
                                    isActive={appearance.systemScheme === scheme}
                                    onChange={(id) => appearance.onPreferredThemeChange(scheme, id)}
                                />
                            ))}
                        </div>
                        <ThemePreview theme={appearance.effectiveTheme} />
                        <ImportedThemesSection usage={usage} />
                    </div>
                </div>
            </div>
        );
    const selectedTheme = findMatchingBuiltinTheme(theme);
    const selectedImportedTheme = selectedTheme
        ? undefined
        : importedThemes.find((candidate) => candidate.id === theme.id);
    return (
        <div className="flex h-full min-h-0 flex-col overflow-hidden">
            <div className="theme-editor structured-editor min-h-0 flex-1 overflow-auto px-8 pt-6 pb-16">
                <div className={SETTINGS_COLUMN_CLASS_NAME}>
                    {/*
                     * Every answer about an import renders here, directly under the button that asked for it. They used to
                     * sit after three fieldsets and some thirty swatch rows, which put them below the fold on arrival: a
                     * warning nobody scrolled to is the same as no warning at all. A failure keeps `Alert`'s assertive
                     * `role="alert"`: a theme that was rejected is exactly the case worth interrupting for, while a
                     * success downgrades to `status` so a screen reader finishes the sentence it was on.
                     */}
                    {importResultAlert}
                    <div className="mb-3 flex items-center justify-between gap-3 text-[12px] text-muted">
                        <span>{t('settings.themeEditor.singleThemeNotice')}</span>
                        <Button
                            size="sm"
                            variant="secondary"
                            className="shrink-0"
                            onClick={() => appearance.onFollowSystemChange(true)}
                        >
                            {t('settings.themeEditor.followSystem')}
                        </Button>
                    </div>
                    <ThemeImportWarnings key={theme.id} themeId={theme.id} warnings={warnings} />
                    {/* Import Theme lives on the preset row rather than its own toolbar above it (issue caxri#1289):
                    both pick "which theme" — a preset by selecting, an import by supplying one — so they read as one
                    decision instead of two unrelated controls competing for the same space above the swatch grid. */}
                    <Field
                        orientation="horizontal"
                        className={cn(SETTINGS_SOLO_CARD_CLASS_NAME, 'mb-3 px-4 py-3')}
                    >
                        <span className="flex min-w-0 items-center gap-3">
                            <FieldLabel htmlFor="theme-preset">
                                {t('settings.themeEditor.preset')}
                            </FieldLabel>
                            <Select
                                value={selectedTheme?.id ?? selectedImportedTheme?.id ?? null}
                                onValueChange={(value) => {
                                    if (value) onSelectTheme(value);
                                }}
                            >
                                <SelectTrigger
                                    id="theme-preset"
                                    aria-label={t('settings.themeEditor.preset')}
                                    className={`${SHORT_CONTROL_WIDTH_CLASS_NAME} flex-none bg-background`}
                                >
                                    <SelectValue>
                                        {selectedTheme?.name ??
                                            selectedImportedTheme?.name ??
                                            (theme.source === 'custom'
                                                ? t('settings.themeEditor.customPreset', {
                                                      theme: theme.name,
                                                  })
                                                : theme.name)}
                                    </SelectValue>
                                </SelectTrigger>
                                <SelectContent>
                                    {builtinThemes.map((candidate) => (
                                        <SelectItem key={candidate.id} value={candidate.id}>
                                            {candidate.name}
                                        </SelectItem>
                                    ))}
                                    {importedThemes.length > 0 && (
                                        <SelectGroup>
                                            <SelectLabel>
                                                {t('settings.themeEditor.presetGroup.imported')}
                                            </SelectLabel>
                                            {importedThemes.map((candidate) => (
                                                <SelectItem key={candidate.id} value={candidate.id}>
                                                    {candidate.name}
                                                </SelectItem>
                                            ))}
                                        </SelectGroup>
                                    )}
                                </SelectContent>
                            </Select>
                        </span>
                        {importButton}
                    </Field>
                    <ThemePreview theme={theme} />
                    <ImportedThemesSection usage={usage} />
                    {(['colors', 'terminal', 'editor'] as const).map((section) => (
                        <fieldset key={section} className="my-3 min-w-0 border-0 p-0">
                            <legend className={SETTINGS_GROUP_HEADING_CLASS_NAME}>
                                {t(`settings.themeEditor.section.${section}`)}
                            </legend>
                            {/* A vertical row per token (issue caxri#1289) put ~30 swatches in one tall column with
                            most of each row's width empty. A grid tiles the same swatch-plus-label cells across the
                            tab's full width instead, so the section reads in a fraction of the scrolling. */}
                            <div
                                className={cn(
                                    SETTINGS_SOLO_CARD_CLASS_NAME,
                                    'grid grid-cols-[repeat(auto-fill,minmax(200px,1fr))] gap-2 p-3',
                                )}
                            >
                                {Object.entries(theme[section]).map(([key, value]) => (
                                    <div
                                        key={key}
                                        className="flex min-w-0 items-center gap-2 rounded px-1 py-1 hover:bg-state-hover-quiet"
                                    >
                                        <Tooltip content={key}>
                                            <input
                                                id={`theme-${section}-${key}`}
                                                aria-label={t(
                                                    `settings.themeEditor.colorLabel.${section}`,
                                                    {
                                                        token: humanizeThemeTokenLabel(t, key),
                                                    },
                                                )}
                                                type="color"
                                                className="size-6 shrink-0 rounded border border-border bg-transparent p-0"
                                                value={value.slice(0, 7)}
                                                onChange={(event) =>
                                                    onColorChange(section, key, event.target.value)
                                                }
                                            />
                                        </Tooltip>
                                        <span className="min-w-0 flex-1">
                                            <Tooltip content={key}>
                                                <label
                                                    htmlFor={`theme-${section}-${key}`}
                                                    className="block truncate text-[12px] text-foreground"
                                                >
                                                    {humanizeThemeTokenLabel(t, key)}
                                                </label>
                                            </Tooltip>
                                            <code className="block truncate text-[11px] text-muted">
                                                {value}
                                            </code>
                                        </span>
                                    </div>
                                ))}
                            </div>
                        </fieldset>
                    ))}
                </div>
            </div>
        </div>
    );
}

/**
 * One of the two themes "Follow system appearance" switches between. Lists `themeSlotOptions`: the presets of its own
 * appearance, then the imported themes that read as it, the same options the General tab's Light theme and Dark theme
 * settings offer. Both write the same `workbench.theme.light` and `workbench.theme.dark` keys, so the two surfaces
 * cannot drift. A slot naming a theme that is gone says which preset paints instead.
 */
function PreferredThemeField({
    card,
    scheme,
    value,
    isActive,
    onChange,
}: {
    /**
     * Which slice of the shared card this row draws.
     */
    card: SettingsCardPosition;
    scheme: SystemColorScheme;
    value: string;
    isActive: boolean;
    onChange: (id: string) => void;
}) {
    const { t } = useTranslation();
    const label = t(`settings.themeEditor.preferred.${scheme}`);
    const options = themeSlotOptions(scheme, useImportedThemes());
    const fallbackId = defaultThemeIdForScheme(scheme);
    const selectedName =
        options.find((option) => option.id === value)?.name ??
        t('settings.themeEditor.missingTheme', {
            theme: builtinThemes.find((theme) => theme.id === fallbackId)?.name ?? fallbackId,
        });
    return (
        <Field orientation="horizontal" className={cn(cardSliceClassName(card), 'px-4 py-3')}>
            <span className="flex min-w-0 items-center gap-3">
                <FieldLabel htmlFor={`theme-preferred-${scheme}`} className="w-24 shrink-0">
                    {label}
                </FieldLabel>
                <Select
                    value={value}
                    onValueChange={(next) => {
                        const option = options.find((candidate) => candidate.id === next);
                        if (option) onChange(option.id);
                    }}
                >
                    <SelectTrigger
                        id={`theme-preferred-${scheme}`}
                        aria-label={label}
                        className={`${SHORT_CONTROL_WIDTH_CLASS_NAME} flex-none bg-background`}
                    >
                        <SelectValue>{selectedName}</SelectValue>
                    </SelectTrigger>
                    <SelectContent>
                        {options.map((option) => (
                            <SelectItem key={option.id} value={option.id}>
                                {option.name}
                            </SelectItem>
                        ))}
                    </SelectContent>
                </Select>
                {isActive && (
                    <span className="shrink-0 text-[11px] text-muted">
                        {t('settings.themeEditor.activeNow')}
                    </span>
                )}
            </span>
        </Field>
    );
}

function ThemeImportWarnings({
    themeId,
    warnings,
}: {
    themeId: string;
    warnings: readonly ThemeImportWarning[];
}) {
    const { t } = useTranslation();
    const generation = themeImportWarningDismissGeneration(themeId);
    const [dismissedState, setDismissedState] = useState(() => ({
        generation,
        warnings: readThemeImportWarningDismissals(themeId),
    }));
    // A second import of the same theme keeps this component mounted; its new generation must reveal warnings again.
    const dismissedWarnings =
        dismissedState.generation === generation
            ? dismissedState.warnings
            : readThemeImportWarningDismissals(themeId);
    return (
        <>
            {warnings.map((warning) =>
                dismissedWarnings.has(warning.id) ? null : (
                    <Alert
                        key={warning.id}
                        variant="warning"
                        className="mb-3 flex items-start justify-between gap-2 text-[11px]"
                    >
                        <span>{themeImportWarningText(warning, t)}</span>
                        <Tooltip content={t('settings.themeEditor.dismissWarning')}>
                            <Button
                                size="icon"
                                variant="ghost"
                                className="size-6 shrink-0"
                                aria-label={t('settings.themeEditor.dismissWarning')}
                                onClick={() => {
                                    dismissThemeImportWarning(themeId, warning.id);
                                    setDismissedState({
                                        generation,
                                        warnings: readThemeImportWarningDismissals(themeId),
                                    });
                                }}
                            >
                                <X aria-hidden="true" size={12} />
                            </Button>
                        </Tooltip>
                    </Alert>
                ),
            )}
        </>
    );
}
