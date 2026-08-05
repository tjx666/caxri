import { Suspense, lazy } from 'react';

import type { Keybinding, KeybindingConflict, ThemeTokens } from '@shared/types';

import { Input } from '../../components/ui/input';

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
        <div className="settings-body">
            <div className="structured-editor bindings-editor">
                {keybindings.map((binding, index) => (
                    <div key={`${binding.command}-${index}`} className="binding-row">
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
                    <div className="config-error">
                        {conflicts
                            .map((conflict) => `${conflict.key}: ${conflict.commands.join(', ')}`)
                            .join('\n')}
                    </div>
                )}
            </div>
            <Suspense fallback={<div className="configuration-editor-loading" />}>
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
