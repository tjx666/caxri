import type { ThemeTokens } from '@caxri/protocol';
import { builtinThemes, findMatchingBuiltinTheme } from '@caxri/protocol';
import { Import } from 'lucide-react';

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
import { ThemePreview } from './theme-preview';
import { humanizeThemeTokenLabel } from './theme-token-labels';

interface ThemeFormProperties {
    theme: ThemeTokens;
    onColorChange: (section: 'colors' | 'terminal' | 'editor', key: string, value: string) => void;
    onImport: () => void;
    onSelectBuiltin: (id: string) => void;
}

/**
 * Full-width structured editor and live preview for `theme.json`.
 */
export function ThemeForm({
    theme,
    onColorChange,
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
                {theme.warnings.map((warning) => (
                    <Alert key={warning} variant="warning" className="text-[11px]">
                        {warning}
                    </Alert>
                ))}
            </div>
        </div>
    );
}
