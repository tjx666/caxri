import type {
    EnumSettingSpec,
    SettingCategoryId,
    SettingKey,
    SettingSpec,
    settingsSpec,
    StringSettingSpec,
} from '@caxri/protocol';

import type { Translate } from '../../i18n';
import { isTranslationKey } from '../../i18n';

/**
 * Display-time translation of the protocol settings catalog. The catalog keeps its English text (it feeds search, the
 * CLI, and validation messages); the Renderer looks up the active locale's text through keys derived from the stable
 * setting key. Title, description, null label, placeholder, and category keys are template literals over closed unions
 * derived from the catalog, so a new setting fails type checking until `settings-catalog.ts` translates it.
 */
type CatalogSpec = (typeof settingsSpec)[number];

type DescribedSettingKey = Extract<CatalogSpec, { description: string }>['key'];
type NullLabeledSettingKey = Extract<CatalogSpec, { nullLabel: string }>['key'];
type PlaceholderSettingKey = Extract<CatalogSpec, { placeholder: string }>['key'];

export function settingTitle(t: Translate, key: SettingKey): string {
    return t(`settings.${key}.title`);
}

export function settingDescription(t: Translate, spec: SettingSpec): string | undefined {
    return spec.description === undefined
        ? undefined
        : t(`settings.${spec.key as DescribedSettingKey}.description`);
}

export function settingCategoryTitle(t: Translate, id: SettingCategoryId): string {
    return t(`settings.category.${id}`);
}

export function settingNullLabel(t: Translate, spec: EnumSettingSpec): string | undefined {
    return spec.nullLabel === undefined
        ? undefined
        : t(`settings.${spec.key as NullLabeledSettingKey}.nullLabel`);
}

/**
 * Placeholders that are literal values rather than prose (a command name, a font name) stay as written.
 */
export function settingPlaceholder(t: Translate, spec: StringSettingSpec): string | undefined {
    if (spec.placeholder === undefined) return undefined;
    const key = spec.key as PlaceholderSettingKey;
    return key === 'terminal.fontFamily' || key === 'workbench.externalEditor'
        ? spec.placeholder
        : t(`settings.${key}.placeholder`);
}

/**
 * Option values are not a closed union per setting (the default-Agent options are derived from the provider catalog),
 * so an option without a translation keeps its catalog label. That is deliberate for vendor names and for languages,
 * which are named in themselves.
 */
export function settingOptionLabel(t: Translate, spec: EnumSettingSpec, value: string): string {
    const key = `settings.${spec.key}.option.${value}`;
    if (isTranslationKey(key)) return t(key);
    return spec.options.find((option) => option.value === value)?.label ?? value;
}

/**
 * Units are a free string in the protocol type; every unit the catalog uses has a `settings.unit.*` entry, and any
 * other unit renders as written.
 */
export function settingUnitLabel(t: Translate, unit: string): string {
    const key = `settings.unit.${unit}`;
    return isTranslationKey(key) ? t(key) : unit;
}
