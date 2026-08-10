import type { Keybinding, KeybindingConflict } from '@shared/types';

import { Input } from '../../components/ui/input';

interface KeybindingsFormProps {
    keybindings: Keybinding[];
    conflicts: KeybindingConflict[];
    onFieldChange: (index: number, field: 'key' | 'command', value: string) => void;
}

/** Full-width structured editor for `keybindings.jsonc`. */
export function KeybindingsForm({ keybindings, conflicts, onFieldChange }: KeybindingsFormProps) {
    return (
        <div className="min-h-0 overflow-hidden">
            <div className="structured-editor h-full min-h-0 overflow-auto p-3">
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
        </div>
    );
}
