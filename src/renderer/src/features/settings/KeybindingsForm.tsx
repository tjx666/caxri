import { Suspense, lazy } from 'react';

import type { Keybinding, KeybindingConflict, ThemeTokens } from '@shared/types';

import { Input } from '../../components/ui/input';
import { configurationEditorLoadingClassName } from '../../lib/utils';

const ConfigurationEditor = lazy(() => import('./ConfigurationEditor'));

interface KeybindingsFormProps {
    keybindings: Keybinding[];
    conflicts: KeybindingConflict[];
    source: string;
    theme: ThemeTokens;
    onFieldChange: (index: number, field: 'key' | 'command', value: string) => void;
    onSourceChange: (source: string) => void;
}

/** The `keybindings` tab: one row per binding on the left, the raw keybindings.jsonc source on the right. */
export function KeybindingsForm({
    keybindings,
    conflicts,
    source,
    theme,
    onFieldChange,
    onSourceChange,
}: KeybindingsFormProps) {
    return (
        <div className="grid min-h-0 grid-cols-[minmax(250px,0.85fr)_minmax(310px,1.15fr)] overflow-hidden">
            <div className="structured-editor min-h-0 overflow-auto border-r border-border p-3">
                {keybindings.map((binding, index) => (
                    <div
                        key={`${binding.command}-${index}`}
                        className="mb-1 grid grid-cols-[112px_1fr] gap-1"
                    >
                        <Input
                            aria-label={`Shortcut for ${binding.command}`}
                            value={binding.key}
                            onChange={(event) => onFieldChange(index, 'key', event.target.value)}
                        />
                        <Input
                            aria-label="Command"
                            value={binding.command}
                            onChange={(event) =>
                                onFieldChange(index, 'command', event.target.value)
                            }
                        />
                    </div>
                ))}
                {conflicts.length > 0 && (
                    <div className="whitespace-pre-wrap rounded border border-danger p-2 text-[11px] text-danger">
                        {conflicts
                            .map((conflict) => `${conflict.key}: ${conflict.commands.join(', ')}`)
                            .join('\n')}
                    </div>
                )}
            </div>
            <Suspense fallback={<div className={configurationEditorLoadingClassName} />}>
                <ConfigurationEditor
                    ariaLabel="keybindings.jsonc source"
                    path="/caxri/keybindings.jsonc"
                    theme={theme}
                    value={source}
                    onChange={onSourceChange}
                />
            </Suspense>
        </div>
    );
}
