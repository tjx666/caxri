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
    const selectedTheme = findMatchingBuiltinTheme(theme);
    return (
        <div className="flex h-full min-h-0 flex-col overflow-hidden">
            <div className="flex justify-end p-3 pb-0">
                <Button size="sm" variant="secondary" onClick={onImport}>
                    <Import size={13} /> Import Theme
                </Button>
            </div>
            <div className="theme-editor structured-editor min-h-0 flex-1 overflow-auto p-3">
                {/*
                 * Every answer about an import renders here, directly under the button that asked for it. They used to
                 * sit after three fieldsets and some thirty swatch rows, which put them below the fold on arrival: a
                 * warning nobody scrolled to is the same as no warning at all. A failure keeps `Alert`'s assertive
                 * `role="alert"` — a theme that was rejected is exactly the case worth interrupting for — while a
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
                                : `Imported ${importResult.themeName}.`}
                        </span>
                        <Tooltip content="Dismiss">
                            <Button
                                size="icon"
                                variant="ghost"
                                className="size-6 shrink-0"
                                aria-label="Dismiss theme import result"
                                onClick={onDismissImportResult}
                            >
                                <X aria-hidden="true" size={12} />
                            </Button>
                        </Tooltip>
                    </Alert>
                )}
                <ThemeImportWarnings key={theme.id} themeId={theme.id} warnings={warnings} />
                <Field orientation="horizontal" className="mb-3">
                    <FieldLabel htmlFor="theme-preset">Theme preset</FieldLabel>
                    <Select
                        value={selectedTheme?.id ?? null}
                        onValueChange={(value) => {
                            if (value) onSelectBuiltin(value);
                        }}
                    >
                        <SelectTrigger
                            id="theme-preset"
                            aria-label="Theme preset"
                            className="w-52 flex-none bg-background"
                        >
                            <SelectValue>
                                {selectedTheme?.name ??
                                    (theme.source === 'custom'
                                        ? `Custom — ${theme.name}`
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
                </Field>
                <ThemePreview theme={theme} />
                {(['colors', 'terminal', 'editor'] as const).map((section) => (
                    <fieldset key={section} className="my-3 min-w-0 border-0 p-0">
                        <legend className="mb-2 text-[11px] font-semibold text-foreground uppercase">
                            {section[0].toUpperCase() + section.slice(1)}
                        </legend>
                        {Object.entries(theme[section]).map(([key, value]) => (
                            <Field key={key} orientation="horizontal" className="mb-3">
                                <FieldLabel htmlFor={`theme-${section}-${key}`} title={key}>
                                    {humanizeThemeTokenLabel(key)}
                                </FieldLabel>
                                <span className="flex items-center gap-2">
                                    <input
                                        id={`theme-${section}-${key}`}
                                        aria-label={`${section} ${humanizeThemeTokenLabel(key)} color`}
                                        title={key}
                                        type="color"
                                        className="size-7 rounded border border-border bg-transparent p-0"
                                        value={value.slice(0, 7)}
                                        onChange={(event) =>
                                            onColorChange(section, key, event.target.value)
                                        }
                                    />
                                    <code className="w-16 text-[11px] text-foreground">
                                        {value}
                                    </code>
                                </span>
                            </Field>
                        ))}
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
                        <Tooltip content="Dismiss warning">
                            <Button
                                size="icon"
                                variant="ghost"
                                className="size-6 shrink-0"
                                aria-label="Dismiss warning"
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
