import type { ReactNode } from 'react';

import type { EnumSettingSpec } from '@caxri/protocol';

import {
    Select,
    SelectContent,
    SelectItem,
    SelectTrigger,
    SelectValue,
} from '../../components/ui/select';
import { SHORT_CONTROL_WIDTH_CLASS_NAME } from './setting-row-layout';

/**
 * Sentinel `SelectItem` value standing in for `null` on nullable enum settings: Base UI Select items need a non-null
 * value, and `settings.jsonc` stores the absence as `null`.
 */
const NULL_OPTION = '__null__';

interface EnumControlProperties {
    id: string;
    label: string;
    spec: EnumSettingSpec;
    value: string | null;
    /**
     * Optional per-option adornment (e.g. Agent identity icons for the default-agent setting).
     */
    renderOptionIcon?: (value: string | null) => ReactNode;
    onChange: (value: string | null) => void;
}

/**
 * Dropdown editor for enum settings, including the optional null ("unset") choice.
 */
export function EnumControl({
    id,
    label,
    spec,
    value,
    renderOptionIcon,
    onChange,
}: EnumControlProperties) {
    const selected = value ?? NULL_OPTION;
    const labelFor = (option: string): string =>
        option === NULL_OPTION
            ? (spec.nullLabel ?? '')
            : (spec.options.find((entry) => entry.value === option)?.label ?? option);
    return (
        <Select
            value={selected}
            onValueChange={(next) => onChange(next === NULL_OPTION || next === null ? null : next)}
        >
            <SelectTrigger
                id={id}
                aria-label={label}
                className={`${SHORT_CONTROL_WIDTH_CLASS_NAME} flex-none bg-background`}
            >
                <SelectValue>
                    <span className="flex items-center gap-2">
                        {renderOptionIcon?.(value)}
                        {labelFor(selected)}
                    </span>
                </SelectValue>
            </SelectTrigger>
            <SelectContent>
                {spec.nullLabel !== undefined && (
                    <SelectItem value={NULL_OPTION}>
                        <span className="flex items-center gap-2">
                            {renderOptionIcon?.(null)}
                            {spec.nullLabel}
                        </span>
                    </SelectItem>
                )}
                {spec.options.map((option) => (
                    <SelectItem key={option.value} value={option.value}>
                        <span className="flex items-center gap-2">
                            {renderOptionIcon?.(option.value)}
                            {option.label}
                        </span>
                    </SelectItem>
                ))}
            </SelectContent>
        </Select>
    );
}
