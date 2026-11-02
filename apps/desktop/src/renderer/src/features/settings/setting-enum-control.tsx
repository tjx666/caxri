import type { SystemColorScheme } from '@caxri/protocol';
import { themeSlotOptions } from '@caxri/protocol';

import { useImportedThemes } from '../../stores/selectors';
import type { EnumControlProperties } from './enum-control';
import { EnumControl } from './enum-control';

const themeSlotSchemes: Partial<Record<string, SystemColorScheme>> = {
    'workbench.theme.light': 'light',
    'workbench.theme.dark': 'dark',
};

/**
 * The General tab's dropdown for an enum setting. The Light theme and Dark theme rows offer `themeSlotOptions` instead
 * of the spec's built-in list, so an imported theme is pickable there exactly as in the Theme tab.
 */
export function SettingEnumControl(properties: EnumControlProperties) {
    const importedThemes = useImportedThemes();
    const scheme = themeSlotSchemes[properties.spec.key];
    if (!scheme) return <EnumControl {...properties} />;
    const options = themeSlotOptions(scheme, importedThemes).map(({ id, name }) => ({
        value: id,
        label: name,
    }));
    return <EnumControl {...properties} spec={{ ...properties.spec, options }} />;
}
