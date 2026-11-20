import type { StringSettingSpec } from '@caxri/protocol';

/**
 * The value a multiline field stores for the text typed into it: verbatim, so its line breaks survive, except that an
 * empty nullable field stores `null`.
 */
export function multilineStringValue(spec: StringSettingSpec, text: string): string | null {
    return text === '' && spec.nullable ? null : text;
}
