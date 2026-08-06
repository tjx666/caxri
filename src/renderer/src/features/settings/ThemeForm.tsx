import { Import } from 'lucide-react';
import { Suspense, lazy } from 'react';

import type { ThemeTokens } from '@shared/types';

import { Button } from '../../components/ui/button';
import { configurationEditorLoadingClassName, settingsFieldRowClassName } from '../../lib/utils';
import { ThemePreview } from './ThemePreview';

const ConfigurationEditor = lazy(() => import('./ConfigurationEditor'));

interface ThemeFormProps {
    theme: ThemeTokens;
    source: string;
    onColorChange: (section: 'colors' | 'terminal' | 'editor', key: string, value: string) => void;
    onSourceChange: (source: string) => void;
    onImport: () => void;
}

/** The `theme` tab: live preview and color pickers on the left, the raw theme.json source on the right. */
export function ThemeForm({
    theme,
    source,
    onColorChange,
    onSourceChange,
    onImport,
}: ThemeFormProps) {
    return (
        <div className="grid min-h-0 grid-cols-[minmax(250px,0.85fr)_minmax(310px,1.15fr)] overflow-hidden">
            <div className="theme-editor structured-editor min-h-0 overflow-auto border-r border-border p-3">
                <ThemePreview theme={theme} />
                <div className="mb-4 flex justify-between">
                    <strong>{theme.name}</strong>
                    <span className="text-muted">{theme.source}</span>
                </div>
                {(['colors', 'terminal', 'editor'] as const).map((section) => (
                    <fieldset key={section} className="my-3 min-w-0 border-0 p-0">
                        <legend className="mb-2 text-[11px] font-semibold text-foreground uppercase">
                            {section[0].toUpperCase() + section.slice(1)}
                        </legend>
                        {Object.entries(theme[section]).map(([key, value]) => (
                            <label key={key} className={settingsFieldRowClassName}>
                                {key}
                                <span className="flex items-center gap-2">
                                    <input
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
                            </label>
                        ))}
                    </fieldset>
                ))}
                {theme.warnings.map((warning) => (
                    <p
                        key={warning}
                        className="rounded border border-warning p-2 text-[11px] whitespace-pre-wrap text-warning"
                    >
                        {warning}
                    </p>
                ))}
                <Button size="sm" variant="secondary" onClick={onImport}>
                    <Import size={13} /> Import Theme
                </Button>
            </div>
            <Suspense fallback={<div className={configurationEditorLoadingClassName} />}>
                <ConfigurationEditor
                    ariaLabel="theme.json source"
                    path="/caxri/theme.json"
                    theme={theme}
                    value={source}
                    onChange={onSourceChange}
                />
            </Suspense>
        </div>
    );
}
