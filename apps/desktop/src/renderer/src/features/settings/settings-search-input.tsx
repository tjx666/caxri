import type { Ref } from 'react';

import { Search, X } from 'lucide-react';

import { Input, InputGroup } from '../../components/ui/input';
import { Tooltip } from '../../components/ui/tooltip';

/**
 * Clear-search affordance shared with `ProjectSearch`'s `searchOptionClassName`.
 */
const clearSearchButtonClassName =
    'grid size-6 shrink-0 place-items-center rounded border-0 bg-transparent p-0 text-muted cursor-pointer hover:bg-elevated hover:text-foreground';

interface SettingsSearchInputProperties {
    inputRef: Ref<HTMLInputElement>;
    label: string;
    placeholder: string;
    clearTooltip: string;
    clearLabel: string;
    value: string;
    onChange: (value: string) => void;
}

/**
 * The search field above the settings list and the keyboard shortcut list, with its clear button.
 */
export function SettingsSearchInput({
    inputRef,
    label,
    placeholder,
    clearTooltip,
    clearLabel,
    value,
    onChange,
}: SettingsSearchInputProperties) {
    return (
        <InputGroup appearance="workbench" size="dense">
            <Search aria-hidden="true" className="shrink-0 text-muted" size={14} />
            <Input
                ref={inputRef}
                appearance="embedded"
                aria-label={label}
                placeholder={placeholder}
                size="dense"
                value={value}
                onChange={(event) => onChange(event.target.value)}
            />
            {value && (
                <Tooltip content={clearTooltip}>
                    <button
                        type="button"
                        className={clearSearchButtonClassName}
                        aria-label={clearLabel}
                        onClick={() => onChange('')}
                    >
                        <X size={13} />
                    </button>
                </Tooltip>
            )}
        </InputGroup>
    );
}
