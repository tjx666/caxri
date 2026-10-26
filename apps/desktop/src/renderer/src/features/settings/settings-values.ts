import type { AppSettings, ArgvConfig, ArgvConfigChanges } from '@caxri/protocol';
import {
    defaultAgentProviderSettings,
    defaultAppSettings,
    hasDefaultProviderAutonomy,
    hasProviderAutonomy,
    withProviderAutonomy,
} from '@caxri/protocol';
import { isEqual } from 'es-toolkit';

import type { SettingRowBinding, SettingRowDescriptor } from './settings-registry';

/**
 * The read side every Settings row shares. `argvConfig` stays optional because the Main-owned boot config loads
 * asynchronously after the dialog opens.
 */
export interface SettingsValueContext {
    settings: AppSettings;
    argvConfig?: ArgvConfig;
}

/**
 * Whether a row's control accepts input: false while the switch it depends on (`enabledBy`) is off.
 */
export function isRowEnabled(
    row: Pick<SettingRowDescriptor, 'enabledBy'>,
    settings: AppSettings,
): boolean {
    return row.enabledBy === undefined || settings[row.enabledBy] === true;
}

/**
 * Whether a row currently diverges from its shipped default: drives the modified indicator and the reset affordance,
 * mirroring VS Code's modified-setting gutter.
 */
export function isRowModified(binding: SettingRowBinding, context: SettingsValueContext): boolean {
    const { settings, argvConfig } = context;
    switch (binding.type) {
        case 'setting':
            return !isEqual(settings[binding.key], defaultAppSettings[binding.key]);
        case 'provider-toggle':
            return (
                settings['agents.providers'][binding.provider][binding.field].enabled !==
                defaultAgentProviderSettings[binding.provider][binding.field].enabled
            );
        case 'provider-autonomy':
            // Derived from the launch arguments, so only the autonomy tokens count as modified: adding an unrelated
            // argument by hand marks the arguments row, never this one.
            return (
                hasProviderAutonomy(
                    settings['agents.providers'][binding.provider].launch.args,
                    binding.provider,
                ) !== hasDefaultProviderAutonomy(binding.provider)
            );
        case 'provider-launch':
            return !isEqual(
                settings['agents.providers'][binding.provider].launch[binding.field],
                defaultAgentProviderSettings[binding.provider].launch[binding.field],
            );
        case 'provider-recovery':
            return !isEqual(
                settings['agents.providers'][binding.provider].recovery,
                defaultAgentProviderSettings[binding.provider].recovery,
            );
        case 'provider-actions':
            return !isEqual(
                settings['agents.providers'][binding.provider].actions,
                defaultAgentProviderSettings[binding.provider].actions,
            );
        case 'trusted-domains':
            return settings['security.trustedDomains'].length > 0;
        case 'trusted-folders':
            return settings['security.trustedFolders'].length > 0;
        case 'terminal-reference-links':
            return settings['terminal.referenceLinks'].length > 0;
        case 'ignored-checks':
            return settings['projectStatus.ignoredChecks'].length > 0;
        case 'long-running-commands':
            return !isEqual(
                settings['agents.longRunningShellCommands'],
                defaultAppSettings['agents.longRunningShellCommands'],
            );
        case 'files-exclude':
            return !isEqual(settings[binding.key], defaultAppSettings[binding.key]);
        case 'delegation-depth':
            // Only the depth belongs to this row; hand-written presets and caller bindings are edited in the source
            // view and must not light up a row that cannot show them.
            return (
                settings['agents.delegation'].maxDepth !==
                defaultAppSettings['agents.delegation'].maxDepth
            );
        case 'remote-debugging':
            return argvConfig !== undefined && !argvConfig.remoteDebugging;
        case 'hardware-acceleration':
            return argvConfig !== undefined && !argvConfig.hardwareAcceleration;
        case 'archived-sessions':
        case 'mobile-access':
        case 'claude-windows':
        case 'provider-skill-health':
            return false;
    }
}

/**
 * Rows that only navigate or report health have nothing to reset.
 */
export function isRowResettable(binding: SettingRowBinding): boolean {
    return ![
        'archived-sessions',
        'mobile-access',
        'claude-windows',
        'provider-skill-health',
    ].includes(binding.type);
}

/**
 * How to undo a row back to its shipped default; routes to the matching write channel.
 */
export type RowResetAction =
    | {
          kind: 'field';
          key: keyof AppSettings;
          value: AppSettings[keyof AppSettings];
          /**
           * Set when the row owns one field of a complex setting, so the reset writes that field's own JSONC path and
           * leaves the rest of the key (comments included) untouched.
           */
          member?: string;
      }
    | { kind: 'argv'; changes: ArgvConfigChanges };

export function rowResetAction(
    binding: SettingRowBinding,
    settings: AppSettings,
): RowResetAction | undefined {
    switch (binding.type) {
        case 'setting':
            return {
                kind: 'field',
                key: binding.key,
                value: structuredClone(defaultAppSettings[binding.key]),
            };
        case 'provider-toggle':
            return {
                kind: 'field',
                key: 'agents.providers',
                value: withProviderField(settings, binding.provider, {
                    [binding.field]: {
                        enabled:
                            defaultAgentProviderSettings[binding.provider][binding.field].enabled,
                    },
                }),
            };
        case 'provider-autonomy':
            // Restores only the default answer to "does it ask first"; every other launch argument the user added
            // survives the reset.
            return {
                kind: 'field',
                key: 'agents.providers',
                value: withProviderAutonomyField(
                    settings,
                    binding.provider,
                    hasDefaultProviderAutonomy(binding.provider),
                ),
            };
        case 'provider-launch':
            return {
                kind: 'field',
                key: 'agents.providers',
                value: withProviderField(settings, binding.provider, {
                    launch: {
                        ...settings['agents.providers'][binding.provider].launch,
                        [binding.field]: structuredClone(
                            defaultAgentProviderSettings[binding.provider].launch[binding.field],
                        ),
                    },
                }),
            };
        case 'provider-recovery':
            return {
                kind: 'field',
                key: 'agents.providers',
                value: withProviderField(settings, binding.provider, {
                    recovery: structuredClone(
                        defaultAgentProviderSettings[binding.provider].recovery,
                    ),
                }),
            };
        case 'provider-actions':
            return {
                kind: 'field',
                key: 'agents.providers',
                value: withProviderField(settings, binding.provider, {
                    actions: structuredClone(
                        defaultAgentProviderSettings[binding.provider].actions,
                    ),
                }),
            };
        case 'trusted-domains':
            return { kind: 'field', key: 'security.trustedDomains', value: [] };
        case 'trusted-folders':
            return { kind: 'field', key: 'security.trustedFolders', value: [] };
        case 'terminal-reference-links':
            return { kind: 'field', key: 'terminal.referenceLinks', value: [] };
        case 'ignored-checks':
            return { kind: 'field', key: 'projectStatus.ignoredChecks', value: [] };
        case 'long-running-commands':
            return {
                kind: 'field',
                key: 'agents.longRunningShellCommands',
                value: [...defaultAppSettings['agents.longRunningShellCommands']],
            };
        case 'files-exclude':
            return {
                kind: 'field',
                key: binding.key,
                value: structuredClone(defaultAppSettings[binding.key]),
            };
        case 'delegation-depth':
            // Restores only the depth; the presets and caller bindings the user wrote survive the reset.
            return {
                kind: 'field',
                key: 'agents.delegation',
                member: 'maxDepth',
                value: {
                    ...settings['agents.delegation'],
                    maxDepth: defaultAppSettings['agents.delegation'].maxDepth,
                },
            };
        case 'remote-debugging':
            return { kind: 'argv', changes: { remoteDebugging: true } };
        case 'hardware-acceleration':
            return { kind: 'argv', changes: { hardwareAcceleration: true } };
        case 'archived-sessions':
        case 'mobile-access':
        case 'claude-windows':
        case 'provider-skill-health':
            return undefined;
    }
}

/**
 * Returns a full `agents.providers` value with one provider field replaced, preserving the wholesale-object write shape
 * `settings.update` expects for the providers record.
 */
export function withProviderField(
    settings: AppSettings,
    provider: keyof AppSettings['agents.providers'],
    patch: Partial<AppSettings['agents.providers'][keyof AppSettings['agents.providers']]>,
): AppSettings['agents.providers'] {
    return {
        ...settings['agents.providers'],
        [provider]: { ...settings['agents.providers'][provider], ...patch },
    };
}

/**
 * Returns a full `agents.providers` value with `provider`'s autonomy tokens turned on or off in its launch arguments,
 * every other argument left in place.
 */
export function withProviderAutonomyField(
    settings: AppSettings,
    provider: keyof AppSettings['agents.providers'],
    isEnabled: boolean,
): AppSettings['agents.providers'] {
    const launch = settings['agents.providers'][provider].launch;
    return withProviderField(settings, provider, {
        launch: { ...launch, args: withProviderAutonomy(launch.args, provider, isEnabled) },
    });
}
