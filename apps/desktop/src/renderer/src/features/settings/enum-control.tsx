import type { ReactNode } from 'react';

import type { EnumSettingSpec } from '@caxri/protocol';

import {
    Select,
    SelectContent,
    SelectItem,
    SelectTrigger,
    SelectValue,
} from '../../components/ui/select';
import { useTranslation } from '../../i18n';
import { SHORT_CONTROL_WIDTH_CLASS_NAME } from './setting-row-layout';
import { settingNullLabel, settingOptionLabel } from './setting-spec-text';

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
     * Optional per-option adornment (e.g. Agent identity icons for the default-agent setting). `placement` tells the
     * closed trigger from an open list item, so a looping preview can stay in the list instead of animating beside the
     * selected value for as long as Settings is open.
     */
    renderOptionIcon?: (value: string | null, placement: 'item' | 'trigger') => ReactNode;
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
    const { t } = useTranslation();
    const selected = value ?? NULL_OPTION;
    const nullLabel = settingNullLabel(t, spec);
    const labelFor = (option: string): string =>
        option === NULL_OPTION ? (nullLabel ?? '') : settingOptionLabel(t, spec, option);
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
                        {renderOptionIcon?.(value, 'trigger')}
                        {labelFor(selected)}
                    </span>
                </SelectValue>
            </SelectTrigger>
            <SelectContent>
                {nullLabel !== undefined && (
                    <SelectItem value={NULL_OPTION}>
                        <span className="flex items-center gap-2">
                            {renderOptionIcon?.(null, 'item')}
                            {nullLabel}
                        </span>
                    </SelectItem>
                )}
                {spec.options.map((option) => (
                    <SelectItem key={option.value} value={option.value}>
                        <span className="flex items-center gap-2">
                            {renderOptionIcon?.(option.value, 'item')}
                            {settingOptionLabel(t, spec, option.value)}
                        </span>
                    </SelectItem>
                ))}
            </SelectContent>
        </Select>
    );
}
