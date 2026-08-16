import { useState } from 'react';

import type { AppSettings } from '@shared/types';
import { Plus, Trash2 } from 'lucide-react';

import { Button } from '../../components/ui/button';
import { Input } from '../../components/ui/input';
import { Switch } from '../../components/ui/switch';
import { Tooltip } from '../../components/ui/tooltip';

interface FilesExcludeEditorProperties {
    value: AppSettings['files.exclude'];
    onChange: (value: AppSettings['files.exclude']) => void;
}

/**
 * Glob-pattern map editor for `files.exclude`: each pattern keeps its enabled flag so a pattern can be paused without
 * losing it, mirroring the VS Code representation of the same setting.
 */
export function FilesExcludeEditor({ value, onChange }: FilesExcludeEditorProperties) {
    const [draft, setDraft] = useState('');
    const patterns = Object.keys(value);

    const addPattern = (): void => {
        const pattern = draft.trim();
        if (!pattern || Object.hasOwn(value, pattern)) return;
        onChange({ ...value, [pattern]: true });
        setDraft('');
    };

    return (
        <div className="flex flex-col gap-1">
            <ul aria-label="Excluded file patterns" className="m-0 flex list-none flex-col p-0">
                {patterns.map((pattern) => (
                    <li
                        key={pattern}
                        className="group/pattern flex min-h-8 items-center gap-2 rounded px-1"
                    >
                        <Switch
                            aria-label={`Hide files matching ${pattern}`}
                            checked={value[pattern]}
                            onCheckedChange={(checked) =>
                                onChange({ ...value, [pattern]: checked })
                            }
                        />
                        <code className="min-w-0 flex-1 truncate font-mono text-[12px] text-foreground">
                            {pattern}
                        </code>
                        <Tooltip content="Remove pattern">
                            <Button
                                aria-label={`Remove excluded pattern ${pattern}`}
                                className="opacity-0 group-focus-within/pattern:opacity-100 group-hover/pattern:opacity-100"
                                size="icon"
                                variant="ghost"
                                onClick={() => {
                                    const next = { ...value };
                                    delete next[pattern];
                                    onChange(next);
                                }}
                            >
                                <Trash2 size={13} />
                            </Button>
                        </Tooltip>
                    </li>
                ))}
            </ul>
            <div className="flex items-center gap-2">
                <Input
                    aria-label="New excluded pattern"
                    className="bg-background"
                    placeholder="**/node_modules"
                    size="dense"
                    value={draft}
                    onChange={(event) => setDraft(event.target.value)}
                    onKeyDown={(event) => {
                        if (event.key === 'Enter') addPattern();
                    }}
                />
                <Button
                    aria-label="Add excluded pattern"
                    disabled={!draft.trim()}
                    size="sm"
                    variant="secondary"
                    onClick={addPattern}
                >
                    <Plus size={13} /> Add
                </Button>
            </div>
        </div>
    );
}
