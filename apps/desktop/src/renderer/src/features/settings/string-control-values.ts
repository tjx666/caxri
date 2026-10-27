import type { StringSettingSpec } from '@caxri/protocol';

/**
 * The value a multiline field stores for the text typed into it. Text equal to the spec's `preset` is stored as `null`,
 * so a field edited back to the preset keeps following newer presets; otherwise the text stays verbatim, the empty
 * string included, since emptying a preset-backed field is a choice of its own.
 */
export function multilineStringValue(spec: StringSettingSpec, text: string): string | null {
    if (spec.preset !== undefined) return text === spec.preset ? null : text;
    return text === '' && spec.nullable ? null : text;
}
