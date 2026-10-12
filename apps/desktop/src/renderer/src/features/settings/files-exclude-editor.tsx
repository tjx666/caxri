import { useState } from 'react';

import type { AppSettings } from '@caxri/protocol';
import { Plus, Trash2 } from 'lucide-react';

import { Button } from '../../components/ui/button';
import { Input } from '../../components/ui/input';
import { Switch } from '../../components/ui/switch';
import { Tooltip } from '../../components/ui/tooltip';
import { useTranslation } from '../../i18n';

interface FilesExcludeEditorProperties {
    label: string;
    placeholder?: string;
    value: AppSettings['files.exclude'];
    onChange: (value: AppSettings['files.exclude']) => void;
}

/**
 * Glob-pattern map editor for file visibility: each pattern keeps its enabled flag so a pattern can be paused without
 * losing it, mirroring the VS Code representation of the same setting.
 */
export function FilesExcludeEditor({
    label,
    value,
    onChange,
    placeholder = '**/node_modules',
}: FilesExcludeEditorProperties) {
    const { t } = useTranslation();
    const [draft, setDraft] = useState('');
    const patterns = Object.keys(value);

    const addPattern = (): void => {
        const pattern = draft.trim();
        if (!pattern || Object.hasOwn(value, pattern)) return;
        onChange({ ...value, [pattern]: true });
        setDraft('');
    };

    return (
        <div role="group" aria-label={label} className="flex flex-col gap-1">
            <ul
                aria-label={t('settings.excludeEditor.listLabel')}
                className="m-0 flex list-none flex-col p-0"
            >
                {patterns.map((pattern) => (
                    <li
                        key={pattern}
                        className="group/pattern flex min-h-8 items-center gap-2 rounded px-1"
                    >
                        <Switch
                            aria-label={t('settings.excludeEditor.toggle', { pattern })}
                            checked={value[pattern]}
                            onCheckedChange={(checked) =>
                                onChange({ ...value, [pattern]: checked })
                            }
                        />
                        <code className="min-w-0 flex-1 truncate font-mono text-[12px] text-foreground">
                            {pattern}
                        </code>
                        <Tooltip content={t('settings.excludeEditor.removeTooltip')}>
                            <Button
                                aria-label={t('settings.excludeEditor.remove', { pattern })}
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
                    aria-label={t('settings.excludeEditor.newLabel')}
                    className="bg-background"
                    placeholder={placeholder}
                    size="dense"
                    value={draft}
                    onChange={(event) => setDraft(event.target.value)}
                    onKeyDown={(event) => {
                        if (event.key === 'Enter') addPattern();
                    }}
                />
                <Button
                    aria-label={t('settings.excludeEditor.add')}
                    disabled={!draft.trim()}
                    size="sm"
                    variant="secondary"
                    onClick={addPattern}
                >
                    <Plus size={13} /> {t('common.add')}
                </Button>
            </div>
        </div>
    );
}
