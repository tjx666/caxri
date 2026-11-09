import { useState } from 'react';

import { FieldDescription } from '../../../components/ui/field';
import { Input } from '../../../components/ui/input';
import {
    Select,
    SelectContent,
    SelectItem,
    SelectTrigger,
    SelectValue,
} from '../../../components/ui/select';
import { isImeComposing } from '../../../lib/ime';
import { SHORT_CONTROL_WIDTH_CLASS_NAME } from '../setting-row-layout';

/**
 * Base UI Select items need a non-null value; this one stands for leaving the key to the Agent.
 */
const UNSET_OPTION = '__unset__';

export interface ChatDefaultFieldOption {
    value: string;
    label: string;
}

/**
 * One key of an Agent's global model default: a select over what the Agent lists, with a first option that leaves the
 * key to the Agent, or a text field while nothing is listed yet. An override line under it says when a launch argument
 * or environment variable decides the key instead.
 */
export function ChatDefaultField({
    disabled,
    id,
    label,
    onChange,
    options,
    override,
    unsetLabel,
    value,
}: {
    disabled: boolean;
    id: string;
    label: string;
    onChange: (value: string | null) => void;
    /**
     * `undefined` while the Agent lists nothing to choose from, so the field takes free text.
     */
    options: readonly ChatDefaultFieldOption[] | undefined;
    override: string | undefined;
    unsetLabel: string;
    value: string | undefined;
}) {
    return (
        <div className="grid content-start gap-1">
            <label className="text-[12px] text-foreground" htmlFor={id}>
                {label}
            </label>
            {options ? (
                <Select
                    disabled={disabled}
                    value={value ?? UNSET_OPTION}
                    onValueChange={(next) => {
                        if (next === null) return;
                        if (next !== (value ?? UNSET_OPTION))
                            onChange(next === UNSET_OPTION ? null : next);
                    }}
                >
                    <SelectTrigger
                        aria-label={label}
                        className={`${SHORT_CONTROL_WIDTH_CLASS_NAME} bg-background`}
                        id={id}
                    >
                        <SelectValue>
                            {options.find((option) => option.value === value)?.label ?? unsetLabel}
                        </SelectValue>
                    </SelectTrigger>
                    <SelectContent>
                        <SelectItem value={UNSET_OPTION}>{unsetLabel}</SelectItem>
                        {options.map((option) => (
                            <SelectItem key={option.value} value={option.value}>
                                {option.label}
                            </SelectItem>
                        ))}
                    </SelectContent>
                </Select>
            ) : (
                <ChatDefaultTextInput
                    disabled={disabled}
                    id={id}
                    label={label}
                    placeholder={unsetLabel}
                    value={value}
                    onCommit={onChange}
                />
            )}
            {override && (
                <FieldDescription role="note" tone="warning">
                    {override}
                </FieldDescription>
            )}
        </div>
    );
}

/**
 * The free-text form of a key: it saves on blur or Enter, and an empty field leaves the key to the Agent.
 */
function ChatDefaultTextInput({
    disabled,
    id,
    label,
    onCommit,
    placeholder,
    value,
}: {
    disabled: boolean;
    id: string;
    label: string;
    onCommit: (value: string | null) => void;
    placeholder: string;
    value: string | undefined;
}) {
    const canonical = value ?? '';
    const [draft, setDraft] = useState({ canonical, text: canonical });
    const text = draft.canonical === canonical ? draft.text : canonical;
    const commit = (): void => {
        const next = text.trim();
        if (next === canonical) return;
        onCommit(next === '' ? null : next);
    };
    return (
        <Input
            aria-label={label}
            className={`${SHORT_CONTROL_WIDTH_CLASS_NAME} bg-background`}
            disabled={disabled}
            id={id}
            placeholder={placeholder}
            value={text}
            onBlur={commit}
            onChange={(event) => setDraft({ canonical, text: event.target.value })}
            onKeyDown={(event) => {
                if (event.key === 'Enter' && !isImeComposing(event)) event.currentTarget.blur();
            }}
        />
    );
}
