import type { ThemeTokens } from '@shared/types';
import { Import } from 'lucide-react';

import { Button } from '../../components/ui/button';
import { settingsFieldRowClassName } from '../../lib/utilities';
import { ThemePreview } from './theme-preview';

interface ThemeFormProperties {
    theme: ThemeTokens;
    onColorChange: (section: 'colors' | 'terminal' | 'editor', key: string, value: string) => void;
    onImport: () => void;
}

/**
Full-width structured editor and live preview for `theme.json`.
 */
export function ThemeForm({ theme, onColorChange, onImport }: ThemeFormProperties) {
    return (
        <div className="flex h-full min-h-0 flex-col overflow-hidden">
            <div className="flex items-center justify-between gap-3 p-3 pb-0">
                <strong>{theme.name}</strong>
                <span className="flex items-center gap-2">
                    <span className="text-muted">{theme.source}</span>
                    <Button size="sm" variant="secondary" onClick={onImport}>
                        <Import size={13} /> Import Theme
                    </Button>
                </span>
            </div>
            <div className="theme-editor structured-editor min-h-0 flex-1 overflow-auto p-3">
                <ThemePreview theme={theme} />
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
            </div>
        </div>
    );
}
