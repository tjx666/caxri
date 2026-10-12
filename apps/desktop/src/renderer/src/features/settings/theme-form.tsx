import { useState } from 'react';

import type { ThemeImportWarning, ThemeTokens } from '@caxri/protocol';
import { builtinThemes, findMatchingBuiltinTheme } from '@caxri/protocol';
import { Import, X } from 'lucide-react';

import { Alert } from '../../components/ui/alert';
import { Button } from '../../components/ui/button';
import { Field, FieldLabel } from '../../components/ui/field';
import {
    Select,
    SelectContent,
    SelectItem,
    SelectTrigger,
    SelectValue,
} from '../../components/ui/select';
import { Tooltip } from '../../components/ui/tooltip';
import { useTranslation } from '../../i18n';
import { SHORT_CONTROL_WIDTH_CLASS_NAME } from './setting-row-layout';
import type { ThemeImportResult } from './theme-import-error';
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
    onImport: () => void;
    onSelectBuiltin: (id: string) => void;
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
    onSelectBuiltin,
}: ThemeFormProperties) {
    const { t } = useTranslation();
    const selectedTheme = findMatchingBuiltinTheme(theme);
    return (
        <div className="flex h-full min-h-0 flex-col overflow-hidden">
            <div className="theme-editor structured-editor min-h-0 flex-1 overflow-auto p-3">
                {/*
                 * Every answer about an import renders here, directly under the button that asked for it. They used to
                 * sit after three fieldsets and some thirty swatch rows, which put them below the fold on arrival: a
                 * warning nobody scrolled to is the same as no warning at all. A failure keeps `Alert`'s assertive
                 * `role="alert"`: a theme that was rejected is exactly the case worth interrupting for, while a
                 * success downgrades to `status` so a screen reader finishes the sentence it was on.
                 */}
                {importResult && (
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
                )}
                <ThemeImportWarnings key={theme.id} themeId={theme.id} warnings={warnings} />
                {/* Import Theme lives on the preset row rather than its own toolbar above it (issue caxri#1289):
                    both pick "which theme" — a preset by selecting, an import by supplying one — so they read as one
                    decision instead of two unrelated controls competing for the same space above the swatch grid. */}
                <Field orientation="horizontal" className="mb-3">
                    <span className="flex min-w-0 items-center gap-3">
                        <FieldLabel htmlFor="theme-preset">
                            {t('settings.themeEditor.preset')}
                        </FieldLabel>
                        <Select
                            value={selectedTheme?.id ?? null}
                            onValueChange={(value) => {
                                if (value) onSelectBuiltin(value);
                            }}
                        >
                            <SelectTrigger
                                id="theme-preset"
                                aria-label={t('settings.themeEditor.preset')}
                                className={`${SHORT_CONTROL_WIDTH_CLASS_NAME} flex-none bg-background`}
                            >
                                <SelectValue>
                                    {selectedTheme?.name ??
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
                            </SelectContent>
                        </Select>
                    </span>
                    <Button size="sm" variant="secondary" onClick={onImport}>
                        <Import size={13} /> {t('settings.themeEditor.importTheme')}
                    </Button>
                </Field>
                <ThemePreview theme={theme} />
                {(['colors', 'terminal', 'editor'] as const).map((section) => (
                    <fieldset key={section} className="my-3 min-w-0 border-0 p-0">
                        <legend className="mb-2 text-[11px] font-semibold text-foreground uppercase">
                            {t(`settings.themeEditor.section.${section}`)}
                        </legend>
                        {/* A vertical row per token (issue caxri#1289) put ~30 swatches in one tall column with
                            most of each row's width empty. A grid tiles the same swatch-plus-label cells across the
                            tab's full width instead, so the section reads in a fraction of the scrolling. */}
                        <div className="grid grid-cols-[repeat(auto-fill,minmax(200px,1fr))] gap-2">
                            {Object.entries(theme[section]).map(([key, value]) => (
                                <div
                                    key={key}
                                    className="flex min-w-0 items-center gap-2 rounded px-1 py-1 hover:bg-[color-mix(in_srgb,var(--elevated)_45%,transparent)]"
                                >
                                    <input
                                        id={`theme-${section}-${key}`}
                                        aria-label={t(
                                            `settings.themeEditor.colorLabel.${section}`,
                                            {
                                                token: humanizeThemeTokenLabel(t, key),
                                            },
                                        )}
                                        title={key}
                                        type="color"
                                        className="size-6 shrink-0 rounded border border-border bg-transparent p-0"
                                        value={value.slice(0, 7)}
                                        onChange={(event) =>
                                            onColorChange(section, key, event.target.value)
                                        }
                                    />
                                    <span className="min-w-0 flex-1">
                                        <label
                                            htmlFor={`theme-${section}-${key}`}
                                            title={key}
                                            className="block truncate text-[11px] text-foreground"
                                        >
                                            {humanizeThemeTokenLabel(t, key)}
                                        </label>
                                        <code className="block truncate text-[10px] text-muted">
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
                        <span>{warning.message}</span>
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
