import type { StringSettingSpec } from '@shared/config';

import { Input } from '../../components/ui/input';

interface StringControlProperties {
    id: string;
    label: string;
    spec: StringSettingSpec;
    value: string | null;
    onChange: (value: string | null) => void;
}

/**
 * Full-width text field; the empty string is stored as `null` for nullable settings.
 */
export function StringControl({ id, label, spec, value, onChange }: StringControlProperties) {
    return (
        <Input
            id={id}
            aria-label={label}
            className="bg-background"
            placeholder={spec.placeholder}
            value={value ?? ''}
            onChange={(event) =>
                onChange(event.target.value === '' && spec.nullable ? null : event.target.value)
            }
        />
    );
}
