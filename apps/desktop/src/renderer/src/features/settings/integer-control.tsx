import { useState } from 'react';

import type { IntegerSettingSpec } from '@caxri/protocol';

import { Input } from '../../components/ui/input';
import { formatIntegerSettingValue, parseIntegerSettingInput } from './integer-control-values';
import { SHORT_CONTROL_WIDTH_CLASS_NAME } from './setting-row-layout';

interface IntegerControlProperties {
    id: string;
    label: string;
    spec: IntegerSettingSpec;
    value: number;
    onChange: (value: number) => void;
    /**
     * Set while the setting this value depends on is off (see `SettingRowDescriptor.enabledBy`).
     */
    disabled?: boolean;
}

interface IntegerDraft {
    /**
     * Stored value this text was last in agreement with. A different incoming `value` means the setting moved from
     * outside the field: a reset, the raw source editor, or an edit to the file, so the text follows it.
     */
    committed: number;
    text: string;
}

/**
 * Number field with the unit rendered inside the field (DESIGN.md: byte values appear as human units with a unit-aware
 * input). `display.scale` converts between the stored integer and the edited unit, e.g. bytes on disk, mebibytes on
 * screen.
 *
 * A rejected entry stays visible in the field as an error instead of being written: the row's "modified" bar and the
 * reset action are derived from the stored value, so nothing may reach the write channel that the settings schema will
 * refuse (DESIGN.md principle 9: a failed write must not be presented as a successful one).
 */
export function IntegerControl({
    disabled,
    id,
    label,
    spec,
    value,
    onChange,
}: IntegerControlProperties) {
    const scale = spec.display?.scale ?? 1;
    const [draftState, setDraftState] = useState<IntegerDraft>(() => ({
        committed: value,
        text: formatIntegerSettingValue(value, spec),
    }));
    const draft =
        draftState.committed === value
            ? draftState
            : { committed: value, text: formatIntegerSettingValue(value, spec) };
    const result = parseIntegerSettingInput(draft.text, spec);
    const isInvalid = result.status === 'invalid';
    const errorId = `${id}-error`;
    return (
        <span className={`flex ${SHORT_CONTROL_WIDTH_CLASS_NAME} flex-none flex-col`}>
            <span className="relative block">
                <Input
                    id={id}
                    aria-describedby={isInvalid ? errorId : undefined}
                    aria-invalid={isInvalid}
                    aria-label={label}
                    className="bg-background pr-12"
                    disabled={disabled}
                    max={spec.max / scale}
                    min={spec.min / scale}
                    step={spec.display?.step ?? 1}
                    type="number"
                    value={draft.text}
                    onBlur={() => {
                        // Half-typed text has nothing worth keeping on screen, and leaving the field blank while the
                        // file still holds a value is the divergence this control exists to prevent. A rejected entry
                        // stays put instead, so its error can explain why it was not taken.
                        if (result.status === 'incomplete')
                            setDraftState({
                                committed: value,
                                text: formatIntegerSettingValue(value, spec),
                            });
                    }}
                    onChange={(event) => {
                        const text = event.target.value;
                        const next = parseIntegerSettingInput(text, spec);
                        setDraftState({
                            committed: next.status === 'valid' ? next.value : draft.committed,
                            text,
                        });
                        if (next.status === 'valid') onChange(next.value);
                    }}
                />
                {spec.display?.unit && (
                    <span className="pointer-events-none absolute top-1/2 right-2 -translate-y-1/2 text-[11px] text-muted">
                        {spec.display.unit}
                    </span>
                )}
            </span>
            {/* The live region is always mounted so a screen reader observes the message arriving rather than a whole
                region appearing, and `empty:mt-0` keeps a valid row exactly as tall as it was before. Polite, not
                `role="alert"`: this validates on every keystroke, and an assertive region would interrupt a screen
                reader mid-word on each one. `aria-describedby` already binds the message to the field. */}
            <span
                aria-live="polite"
                className="mt-1 text-[11px] text-danger empty:mt-0"
                id={errorId}
            >
                {isInvalid ? result.error : ''}
            </span>
        </span>
    );
}
