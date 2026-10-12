import type { StringSettingSpec } from '@caxri/protocol';

import { Input } from '../../components/ui/input';
import { useTranslation } from '../../i18n';
import { isMonospaceStringSetting } from './monospace-string-fields';
import { settingPlaceholder } from './setting-spec-text';

interface StringControlProperties {
    id: string;
    label: string;
    spec: StringSettingSpec;
    value: string | null;
    onChange: (value: string | null) => void;
}

/**
 * Full-width text field; the empty string is stored as `null` for nullable settings. Fields whose value is literal
 * characters rather than prose (see `monospace-string-fields.ts`) render with the monospace stack so glyphs the sans UI
 * font cannot shape (box-drawing, curly quotes) still resolve.
 */
export function StringControl({ id, label, spec, value, onChange }: StringControlProperties) {
    const { t } = useTranslation();
    return (
        <Input
            id={id}
            aria-label={label}
            className={
                isMonospaceStringSetting(spec.key) ? 'bg-background font-mono' : 'bg-background'
            }
            placeholder={settingPlaceholder(t, spec)}
            value={value ?? ''}
            onChange={(event) =>
                onChange(event.target.value === '' && spec.nullable ? null : event.target.value)
            }
        />
    );
}
