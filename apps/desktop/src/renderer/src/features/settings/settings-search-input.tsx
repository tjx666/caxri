import type { Ref } from 'react';

import { Search, X } from 'lucide-react';

import { Button } from '../../components/ui/button';
import { Input, InputGroup } from '../../components/ui/input';
import { Tooltip } from '../../components/ui/tooltip';
import { isImeComposing } from '../../lib/ime';

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
                data-settings-search=""
                placeholder={placeholder}
                size="dense"
                value={value}
                onChange={(event) => onChange(event.target.value)}
                onKeyDown={(event) => {
                    if (!value || event.key !== 'Escape' || isImeComposing(event)) return;
                    // Clear first; with an empty field Escape keeps its usual meaning (closing the surface).
                    event.preventDefault();
                    event.stopPropagation();
                    onChange('');
                }}
            />
            {value && (
                <Tooltip content={clearTooltip}>
                    <Button
                        aria-label={clearLabel}
                        className="shrink-0 text-muted hover:text-foreground"
                        size="icon"
                        variant="ghost"
                        onClick={() => onChange('')}
                    >
                        <X size={13} />
                    </Button>
                </Tooltip>
            )}
        </InputGroup>
    );
}
