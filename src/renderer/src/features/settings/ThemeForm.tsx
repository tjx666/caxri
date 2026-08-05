import { Import } from 'lucide-react';
import { Suspense, lazy } from 'react';

import type { ThemeTokens } from '@shared/types';

import { Button } from '../../components/ui/button';
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
        <div className="settings-body">
            <div className="structured-editor theme-editor">
                <ThemePreview theme={theme} />
                <div className="theme-name">
                    <strong>{theme.name}</strong>
                    <span>{theme.source}</span>
                </div>
                {(['colors', 'terminal', 'editor'] as const).map((section) => (
                    <fieldset key={section}>
                        <legend>{section[0].toUpperCase() + section.slice(1)}</legend>
                        {Object.entries(theme[section]).map(([key, value]) => (
                            <label key={key}>
                                {key}
                                <span>
                                    <input
                                        type="color"
                                        value={value.slice(0, 7)}
                                        onChange={(event) =>
                                            onColorChange(section, key, event.target.value)
                                        }
                                    />
                                    <code>{value}</code>
                                </span>
                            </label>
                        ))}
                    </fieldset>
                ))}
                {theme.warnings.map((warning) => (
                    <p key={warning} className="config-warning">
                        {warning}
                    </p>
                ))}
                <Button size="sm" variant="secondary" onClick={onImport}>
                    <Import size={13} /> Import Theme
                </Button>
            </div>
            <Suspense fallback={<div className="configuration-editor-loading" />}>
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
