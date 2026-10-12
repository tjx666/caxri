import type { Ref } from 'react';

import { Search, X } from 'lucide-react';

import { Input, InputGroup } from '../../components/ui/input';
import { Tooltip } from '../../components/ui/tooltip';
import { useTranslation } from '../../i18n';
import { isImeComposing } from '../../lib/ime';

/**
 * The row filter above the table. Escape clears a non-empty filter; `inputRef` lets the table focus it on `Cmd+F`.
 */
export function CsvTableFilter({
    inputRef,
    value,
    onChange,
}: {
    inputRef: Ref<HTMLInputElement>;
    value: string;
    onChange: (value: string) => void;
}) {
    const { t } = useTranslation();
    return (
        <InputGroup appearance="workbench" className="max-w-72" size="dense">
            <Search aria-hidden="true" className="flex-none text-muted" size={13} />
            <Input
                ref={inputRef}
                appearance="embedded"
                aria-label={t('preview.table.filter')}
                placeholder={t('preview.table.filter')}
                size="dense"
                value={value}
                onChange={(event) => onChange(event.currentTarget.value)}
                onKeyDown={(event) => {
                    if (!value || event.key !== 'Escape' || isImeComposing(event)) return;
                    event.preventDefault();
                    onChange('');
                }}
            />
            {value && (
                <Tooltip content={t('preview.table.clearFilter')}>
                    <button
                        aria-label={t('preview.table.clearFilter')}
                        className="grid size-5 flex-none cursor-pointer place-items-center rounded text-muted hover:bg-elevated hover:text-foreground"
                        type="button"
                        onClick={() => onChange('')}
                    >
                        <X aria-hidden="true" size={12} />
                    </button>
                </Tooltip>
            )}
        </InputGroup>
    );
}
