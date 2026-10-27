import type { StringSettingSpec } from '@caxri/protocol';

import { Input } from '../../components/ui/input';
import { Textarea } from '../../components/ui/textarea';
import { useTranslation } from '../../i18n';
import { isMonospaceStringSetting } from './monospace-string-fields';
import { settingPlaceholder } from './setting-spec-text';
import { multilineStringValue } from './string-control-values';

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
 * font cannot shape (box-drawing, curly quotes) still resolve. A `multiline` spec is prose edited in a resizable text
 * area, kept verbatim so its line breaks survive; its `preset` shows while the value is `null`, and text equal to the
 * preset is stored as `null` so it keeps following Caxri's preset.
 */
export function StringControl({ id, label, spec, value, onChange }: StringControlProperties) {
    const { t } = useTranslation();
    if (spec.multiline)
        return (
            <Textarea
                id={id}
                aria-label={label}
                className="field-sizing-content max-h-96 min-h-32 bg-background"
                placeholder={settingPlaceholder(t, spec)}
                value={value ?? spec.preset ?? ''}
                onChange={(event) => onChange(multilineStringValue(spec, event.target.value))}
            />
        );
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
