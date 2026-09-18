import { useState } from 'react';

import { formatLaunchArguments, parseLaunchArguments } from '@caxri/utils';

import { Textarea } from '../../components/ui/textarea';

interface LaunchArgumentsFieldProperties {
    id: string;
    label: string;
    args: readonly string[];
    onChange: (arguments_: string[]) => void;
}

/**
 * Keeps the visible command-line text while the field is focused so typing a space before a flag value cannot be
 * rewritten out from under the caret. Blur reconstructs flag/value pairs onto one line.
 */
export function LaunchArgumentsField({
    id,
    label,
    args,
    onChange,
}: LaunchArgumentsFieldProperties) {
    const formatted = formatLaunchArguments(args);
    const [draft, setDraft] = useState<string>();
    return (
        <Textarea
            id={id}
            aria-label={label}
            className="bg-background text-foreground"
            value={draft ?? formatted}
            onFocus={() => setDraft(formatted)}
            onChange={(event) => {
                setDraft(event.target.value);
                onChange(parseLaunchArguments(event.target.value));
            }}
            onBlur={() => setDraft(undefined)}
        />
    );
}
