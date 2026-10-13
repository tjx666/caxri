import type { Ref } from 'react';

import { formatShortcut } from '@caxri/protocol';
import { Search, X } from 'lucide-react';

import { Button } from '../../components/ui/button';
import { Input, InputGroup } from '../../components/ui/input';
import { Tooltip } from '../../components/ui/tooltip';
import { useTranslation } from '../../i18n';
import { isImeComposing } from '../../lib/ime';

/**
 * The shortcut the table binds to this field (see `CsvPreview`), shown in the placeholder so the field teaches it.
 */
const FILTER_SHORTCUT = 'cmd+f';

/**
 * The row filter above the table. Escape clears a non-empty filter; Escape on an empty one hands focus back to the
 * table (`onExit`), the way leaving an editor's find field returns to the text. `inputRef` lets the table focus it on
 * `Cmd+F`.
 */
export function CsvTableFilter({
    inputRef,
    value,
    onChange,
    onExit,
}: {
    inputRef: Ref<HTMLInputElement>;
    value: string;
    onChange: (value: string) => void;
    onExit: () => void;
}) {
    const { t } = useTranslation();
    return (
        <InputGroup appearance="workbench" className="max-w-72" size="dense">
            <Search aria-hidden="true" className="flex-none text-muted" size={13} />
            <Input
                ref={inputRef}
                appearance="embedded"
                aria-keyshortcuts="Meta+F"
                aria-label={t('preview.table.filter')}
                placeholder={`${t('preview.table.filter')} (${formatShortcut(FILTER_SHORTCUT)})`}
                size="dense"
                value={value}
                onChange={(event) => onChange(event.currentTarget.value)}
                onKeyDown={(event) => {
                    if (event.key !== 'Escape' || isImeComposing(event)) return;
                    event.preventDefault();
                    if (value) onChange('');
                    else onExit();
                }}
            />
            {value && (
                <Tooltip content={t('preview.table.clearFilter')}>
                    <Button
                        aria-label={t('preview.table.clearFilter')}
                        className="size-5 flex-none rounded-md text-muted enabled:hover:text-foreground"
                        size="icon"
                        variant="ghost"
                        onClick={() => onChange('')}
                    >
                        <X aria-hidden="true" size={12} />
                    </Button>
                </Tooltip>
            )}
        </InputGroup>
    );
}
