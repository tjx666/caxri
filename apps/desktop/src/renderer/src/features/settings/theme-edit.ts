import type { ThemeTokens } from '@caxri/protocol';

import { applyFormEdit } from './config-edit';

type ThemeColorSection = 'colors' | 'terminal' | 'editor';

interface ThemeEditResult {
    source: string;
    value: ThemeTokens;
}

/**
 * Replaces a theme draft leaf-by-leaf so choosing a preset keeps user-authored JSONC comments around the existing
 * fields while still producing the exact reviewed built-in token set.
 */
export function applyBuiltinTheme(source: string, theme: ThemeTokens): ThemeEditResult {
    let nextSource = source;
    for (const key of ['id', 'name', 'source'] as const)
        nextSource = applyFormEdit(nextSource, [key], theme[key]);
    for (const section of ['colors', 'terminal', 'editor'] as const) {
        const entries = Object.entries(theme[section]);
        for (const [key, value] of entries)
            nextSource = applyFormEdit(nextSource, [section, key], value);
    }
    nextSource = applyFormEdit(nextSource, ['warnings'], theme.warnings);
    return { value: structuredClone(theme), source: nextSource };
}

/**
 * A color edit detaches any exact built-in identity before the debounced theme write begins.
 */
export function applyThemeColorEdit(
    source: string,
    theme: ThemeTokens,
    section: ThemeColorSection,
    key: string,
    value: string,
): ThemeEditResult {
    const currentValue = (theme[section] as Record<string, string | undefined>)[key];
    const nextValue =
        currentValue !== undefined &&
        /^#[\da-f]{6}$/iu.test(value) &&
        /^#[\da-f]{8}$/iu.test(currentValue)
            ? `${value}${currentValue.slice(7)}`
            : value;
    const nextId =
        theme.source === 'builtin' && !theme.id.startsWith('custom-')
            ? `custom-${theme.id}`
            : theme.id;
    let nextSource = applyFormEdit(source, [section, key], nextValue);
    nextSource = applyFormEdit(nextSource, ['source'], 'custom');
    if (nextId !== theme.id) nextSource = applyFormEdit(nextSource, ['id'], nextId);
    return {
        value: {
            ...theme,
            id: nextId,
            source: 'custom',
            [section]: { ...theme[section], [key]: nextValue },
        },
        source: nextSource,
    };
}
