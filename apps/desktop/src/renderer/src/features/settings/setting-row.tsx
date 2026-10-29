import type { ReactNode } from 'react';

import type {
    AgentHookHealthMap,
    AgentSkillHealth,
    AppSettings,
    ArgvConfigChanges,
    IntegerSettingSpec,
} from '@caxri/protocol';
import {
    agentProviderCatalog,
    DEFAULT_DELEGATION_DEPTH,
    hasProviderAutonomy,
    MAX_DELEGATION_DEPTH,
    MIN_DELEGATION_DEPTH,
    settingsSpecByKey,
} from '@caxri/protocol';

import { FieldDescription } from '../../components/ui/field';
import { Input } from '../../components/ui/input';
import { Switch } from '../../components/ui/switch';
import type { Translate } from '../../i18n';
import { useTranslation } from '../../i18n';
import { AgentIdentityIcon } from '../../icons/agents/agent-identity-icon';
import { WorkingFigure } from '../agent-chat/loading';
import { TranslucentSidebarStatus } from '../primary-sidebar/translucent-sidebar-status';
import { AgentActionSettingsEditor } from './agent-action-settings-editor';
import { AgentSecretsForm } from './agent-secrets/agent-secrets-form';
import { ArchivedSessionsEntry } from './archived-sessions-entry';
import { ClaudeWindowsForm } from './claude-windows/claude-windows-form';
import { EnumControl } from './enum-control';
import { EnvironmentMonitorSettingControl } from './environment-monitor-setting-control';
import { FilesExcludeEditor } from './files-exclude-editor';
import { IgnoredChecksForm } from './ignored-checks-form';
import { IntegerControl } from './integer-control';
import { LaunchArgumentsField } from './launch-arguments-field';
import { LongRunningCommandsForm } from './long-running-commands-form';
import { MobileAccessForm } from './mobile-access-form';
import { NotificationHelperStatus } from './notification-helper-status';
import { hookHealthCaption, hookHealthTone, isHookAdapterAvailable } from './provider-health';
import { ProviderRecoveryEditor } from './provider-recovery-editor';
import { ProviderSkillHealth } from './provider-skill-health';
import { SettingRowChrome } from './setting-row-chrome';
import { isFullWidthRow } from './setting-row-layout';
import { settingTitle } from './setting-spec-text';
import type { SettingRowDescriptor } from './settings-registry';
import type { SettingsValueContext } from './settings-values';
import {
    isRowEnabled,
    isRowModified,
    isRowResettable,
    withProviderAutonomyField,
    withProviderField,
} from './settings-values';
import { StringControl } from './string-control';
import { TerminalReferenceLinksForm } from './terminal-reference-links-form';
import { TrustedDomainsForm } from './trusted-domains-form';
import { TrustedFoldersForm } from './trusted-folders-form';

interface SettingRowHandlers {
    onFieldChange: <K extends keyof AppSettings>(
        key: K,
        value: AppSettings[K],
        member?: string,
    ) => void;
    onArgvConfigChange: (changes: ArgvConfigChanges) => void;
    onResetRow: (row: SettingRowDescriptor) => void;
}

export interface SettingRowProperties {
    row: SettingRowDescriptor;
    context: SettingsValueContext;
    agentHookHealth?: AgentHookHealthMap;
    agentSkillHealth?: AgentSkillHealth;
    trustedDomainsFocusRequestId?: number;
    handlers: SettingRowHandlers;
}

/**
 * `agents.delegation` is one complex value, so its depth has no entry in `settingsSpecByKey` to render from. The bounds
 * come from the schema that validates the write, not from numbers retyped here, so the control can never offer a value
 * the write would reject.
 */
const DELEGATION_DEPTH_SPEC: IntegerSettingSpec = {
    kind: 'integer',
    key: 'agents.delegation',
    title: 'Delegation depth',
    category: 'agents',
    min: MIN_DELEGATION_DEPTH,
    max: MAX_DELEGATION_DEPTH,
    default: DEFAULT_DELEGATION_DEPTH,
};

/**
 * Per-option adornments for enum rows whose names alone do not say what you get. The working indicator's dropdown items
 * play the same figure the Chat shows, so you can compare them before choosing (issue caxri#2254); Reduce Motion stills
 * them through `loading.css`, as in the Chat. The closed trigger shows only the name, so Settings does not loop an
 * animation beside a value you are not choosing.
 */
function optionIconRenderer(
    key: keyof AppSettings,
): ((value: string | null, placement: 'item' | 'trigger') => ReactNode) | undefined {
    if (key === 'session.defaultAgent')
        return (value) => <AgentIdentityIcon identity={value} size={14} />;
    if (key === 'agentChat.workingIndicator')
        return (value, placement) =>
            placement === 'item' && value !== null ? (
                <span
                    aria-hidden="true"
                    className="flex h-5 w-7 shrink-0 items-center justify-center text-muted"
                >
                    <WorkingFigure
                        indicator={value as AppSettings['agentChat.workingIndicator']}
                        turnId={undefined}
                    />
                </span>
            ) : undefined;
    return undefined;
}

function rowControl(
    t: Translate,
    properties: SettingRowProperties,
): {
    control: ReactNode;
    status?: ReactNode;
    toggle?: ReactNode;
    labelFor?: string;
} {
    const { row, context, agentHookHealth, agentSkillHealth, trustedDomainsFocusRequestId } =
        properties;
    const { onFieldChange, onArgvConfigChange } = properties.handlers;
    const { settings, argvConfig } = context;
    const binding = row.binding;
    const controlId = `setting-${row.id.replaceAll('.', '-')}`;

    switch (binding.type) {
        case 'setting': {
            const spec = settingsSpecByKey[binding.key];
            const isDisabled = !isRowEnabled(row, settings);
            const environmentControl = EnvironmentMonitorSettingControl({
                controlId,
                key: binding.key,
                label: row.accessibleTitle,
                settings,
                onChange: onFieldChange,
            });
            if (environmentControl)
                return {
                    control: environmentControl,
                    labelFor:
                        binding.key === 'environmentMonitor.expectedTimeZone'
                            ? controlId
                            : undefined,
                };
            if (spec.kind === 'boolean')
                return {
                    labelFor: controlId,
                    status:
                        binding.key === 'primarySidebar.translucent' ? (
                            <TranslucentSidebarStatus />
                        ) : binding.key === 'agents.notifications.enabled' ? (
                            <NotificationHelperStatus />
                        ) : undefined,
                    control: (
                        <Switch
                            id={controlId}
                            aria-label={row.accessibleTitle}
                            checked={settings[binding.key] as boolean}
                            className="mt-0.5"
                            disabled={isDisabled}
                            onCheckedChange={(checked) => onFieldChange(binding.key, checked)}
                        />
                    ),
                };
            if (spec.kind === 'integer')
                return {
                    labelFor: controlId,
                    control: (
                        <IntegerControl
                            disabled={isDisabled}
                            id={controlId}
                            label={row.accessibleTitle}
                            spec={spec}
                            value={settings[binding.key] as number}
                            onChange={(value) => onFieldChange(binding.key, value)}
                        />
                    ),
                };
            if (spec.kind === 'enum')
                return {
                    labelFor: controlId,
                    control: (
                        <EnumControl
                            id={controlId}
                            label={row.accessibleTitle}
                            spec={spec}
                            value={settings[binding.key] as string | null}
                            renderOptionIcon={optionIconRenderer(binding.key)}
                            onChange={(value) =>
                                onFieldChange(binding.key, value as AppSettings[typeof binding.key])
                            }
                        />
                    ),
                };
            if (spec.kind === 'string') {
                /**
                 * `updates.skippedVersion` is state the app wrote for you (from "Skip this version" in the update
                 * notice), not a value worth typing by hand: a free-text field invited exactly that, mixing a fact
                 * about app state into a list of controls you deliberately configure (issue caxri#1289). Read-only text
                 * says what is currently skipped; the row's existing hover-Reset action, armed by `isRowModified`
                 * treating any non-null value as modified, is the one way back: the same undo every other row already
                 * offers, so this needs no dedicated binding or "Clear" button of its own.
                 */
                if (binding.key === 'updates.skippedVersion') {
                    const skipped = settings[binding.key];
                    return {
                        control: (
                            <FieldDescription role="status">
                                {skipped
                                    ? t('settings.row.skippedVersion.current', {
                                          version: skipped,
                                      })
                                    : t('settings.row.skippedVersion.none')}
                            </FieldDescription>
                        ),
                    };
                }
                return {
                    labelFor: controlId,
                    control: (
                        <StringControl
                            id={controlId}
                            label={row.accessibleTitle}
                            spec={spec}
                            value={settings[binding.key] as string | null}
                            onChange={(value) =>
                                onFieldChange(binding.key, value as AppSettings[typeof binding.key])
                            }
                        />
                    ),
                };
            }
            // Other complex specs always carry a dedicated binding.
            return { control: undefined };
        }
        case 'provider-toggle': {
            const providerName = agentProviderCatalog[binding.provider].displayName;
            const providerSettings = settings['agents.providers'][binding.provider];
            const supported =
                binding.field === 'hooks' ||
                agentProviderCatalog[binding.provider].capabilities[binding.field];
            const isEnabled = supported && providerSettings[binding.field].enabled;
            // A stored `true` for an adapter this platform cannot run is a preference, not a state. The switch shows
            // what is actually in force; the caption under it says why.
            const isAvailable =
                binding.field !== 'hooks' ||
                isHookAdapterAvailable(agentHookHealth?.[binding.provider]);
            const status =
                binding.field === 'hooks' ? (
                    <FieldDescription
                        role="status"
                        tone={hookHealthTone(isEnabled, agentHookHealth?.[binding.provider])}
                    >
                        {hookHealthCaption(t, isEnabled, agentHookHealth?.[binding.provider])}
                    </FieldDescription>
                ) : !supported ? (
                    <FieldDescription>
                        {t('settings.row.providerMessaging.unavailable', {
                            provider: providerName,
                        })}
                    </FieldDescription>
                ) : undefined;
            const label = t(
                binding.field === 'hooks'
                    ? 'settings.row.providerHooks.label'
                    : 'settings.row.providerMessaging.label',
                { provider: providerName },
            );
            return {
                labelFor: controlId,
                status,
                control: (
                    <Switch
                        id={controlId}
                        aria-label={label}
                        checked={isEnabled && isAvailable}
                        disabled={!supported || !isAvailable}
                        className="mt-0.5"
                        onCheckedChange={(checked) =>
                            onFieldChange(
                                'agents.providers',
                                withProviderField(settings, binding.provider, {
                                    [binding.field]: { enabled: checked },
                                }),
                            )
                        }
                    />
                ),
            };
        }
        case 'provider-autonomy': {
            const providerName = agentProviderCatalog[binding.provider].displayName;
            const launch = settings['agents.providers'][binding.provider].launch;
            return {
                labelFor: controlId,
                control: (
                    <Switch
                        id={controlId}
                        aria-label={t('settings.row.providerAutonomy.label', {
                            provider: providerName,
                        })}
                        checked={hasProviderAutonomy(launch.args, binding.provider)}
                        className="mt-0.5"
                        onCheckedChange={(checked) =>
                            onFieldChange(
                                'agents.providers',
                                withProviderAutonomyField(settings, binding.provider, checked),
                            )
                        }
                    />
                ),
            };
        }
        case 'provider-launch': {
            const providerName = agentProviderCatalog[binding.provider].displayName;
            const launch = settings['agents.providers'][binding.provider].launch;
            if (binding.field === 'executable')
                return {
                    labelFor: controlId,
                    control: (
                        <Input
                            id={controlId}
                            aria-label={t('settings.row.providerExecutable.label', {
                                provider: providerName,
                            })}
                            className="bg-background text-foreground"
                            value={launch.executable}
                            onChange={(event) =>
                                onFieldChange(
                                    'agents.providers',
                                    withProviderField(settings, binding.provider, {
                                        launch: { ...launch, executable: event.target.value },
                                    }),
                                )
                            }
                        />
                    ),
                };
            return {
                labelFor: controlId,
                control: (
                    <LaunchArgumentsField
                        id={controlId}
                        label={t('settings.row.providerArgs.label', { provider: providerName })}
                        args={launch.args}
                        onChange={(arguments_) =>
                            onFieldChange(
                                'agents.providers',
                                withProviderField(settings, binding.provider, {
                                    launch: { ...launch, args: arguments_ },
                                }),
                            )
                        }
                    />
                ),
            };
        }
        case 'provider-recovery': {
            const recovery = settings['agents.providers'][binding.provider].recovery;
            const applyRecovery = (value: typeof recovery): void =>
                onFieldChange(
                    'agents.providers',
                    withProviderField(settings, binding.provider, { recovery: value }),
                );
            return {
                labelFor: controlId,
                toggle: (
                    <Switch
                        id={controlId}
                        aria-label={t('settings.row.providerRecovery.label', {
                            provider: agentProviderCatalog[binding.provider].displayName,
                        })}
                        checked={recovery.enabled}
                        className="mt-0.5"
                        onCheckedChange={(enabled) => applyRecovery({ ...recovery, enabled })}
                    />
                ),
                control: recovery.enabled ? (
                    <ProviderRecoveryEditor
                        id={controlId}
                        provider={binding.provider}
                        value={recovery}
                        onChange={applyRecovery}
                    />
                ) : undefined,
            };
        }
        case 'provider-actions':
            return {
                control: !agentProviderCatalog[binding.provider].capabilities.actions ? (
                    <FieldDescription>
                        {t('settings.row.providerActions.unavailable', {
                            provider: agentProviderCatalog[binding.provider].displayName,
                        })}
                    </FieldDescription>
                ) : (
                    <AgentActionSettingsEditor
                        provider={binding.provider}
                        value={settings['agents.providers'][binding.provider].actions}
                        onChange={(actions) =>
                            onFieldChange(
                                'agents.providers',
                                withProviderField(settings, binding.provider, { actions }),
                            )
                        }
                    />
                ),
            };
        case 'provider-skill-health':
            return {
                control: (
                    <ProviderSkillHealth
                        agentSkillHealth={agentSkillHealth}
                        provider={binding.provider}
                    />
                ),
            };
        case 'trusted-domains':
            return {
                control: (
                    <TrustedDomainsForm
                        focusRequestId={trustedDomainsFocusRequestId}
                        rules={settings['security.trustedDomains']}
                        onChange={(rules) => onFieldChange('security.trustedDomains', rules)}
                    />
                ),
            };
        case 'trusted-folders':
            return {
                control: (
                    <TrustedFoldersForm
                        rules={settings['security.trustedFolders']}
                        onChange={(rules) => onFieldChange('security.trustedFolders', rules)}
                    />
                ),
            };
        case 'ignored-checks':
            return {
                control: (
                    <IgnoredChecksForm
                        rules={settings['projectStatus.ignoredChecks']}
                        onChange={(rules) => onFieldChange('projectStatus.ignoredChecks', rules)}
                    />
                ),
            };
        case 'long-running-commands':
            return {
                control: (
                    <LongRunningCommandsForm
                        rules={settings['agents.longRunningShellCommands']}
                        onChange={(rules) =>
                            onFieldChange('agents.longRunningShellCommands', rules)
                        }
                    />
                ),
            };
        case 'terminal-reference-links':
            return {
                control: (
                    <TerminalReferenceLinksForm
                        rules={settings['terminal.referenceLinks']}
                        onChange={(rules) => onFieldChange('terminal.referenceLinks', rules)}
                    />
                ),
            };
        case 'files-exclude':
            return {
                control: (
                    <FilesExcludeEditor
                        label={settingTitle(t, binding.key)}
                        placeholder={binding.key === 'git.diffExclude' ? '**/*.test.*' : undefined}
                        value={settings[binding.key]}
                        onChange={(value) => onFieldChange(binding.key, value)}
                    />
                ),
            };
        case 'archived-sessions':
            return { control: <ArchivedSessionsEntry /> };
        case 'mobile-access':
            return { control: <MobileAccessForm /> };
        case 'claude-windows':
            return { control: <ClaudeWindowsForm /> };
        case 'agent-secrets':
            return { control: <AgentSecretsForm /> };
        case 'delegation-depth':
            return {
                labelFor: controlId,
                control: (
                    <IntegerControl
                        id={controlId}
                        label={row.accessibleTitle}
                        spec={DELEGATION_DEPTH_SPEC}
                        value={settings['agents.delegation'].maxDepth}
                        onChange={(value) =>
                            onFieldChange(
                                'agents.delegation',
                                { ...settings['agents.delegation'], maxDepth: value },
                                'maxDepth',
                            )
                        }
                    />
                ),
            };
        case 'remote-debugging':
            return {
                labelFor: controlId,
                control: (
                    <Switch
                        id={controlId}
                        aria-label={row.accessibleTitle}
                        checked={argvConfig?.remoteDebugging ?? true}
                        className="mt-0.5"
                        disabled={!argvConfig}
                        onCheckedChange={(checked) =>
                            onArgvConfigChange({ remoteDebugging: checked })
                        }
                    />
                ),
            };
        case 'hardware-acceleration':
            return {
                labelFor: controlId,
                /**
                 * The switch position alone says "off"; it does not say that the consequence is already in force on
                 * every launch. A degradation the user opted into is still a degradation (DESIGN.md principle 9), and
                 * after the restart that applied it there is nowhere else in the product that names it, so the row
                 * states it in the warning tone, in the same words the notice used.
                 */
                status:
                    argvConfig?.hardwareAcceleration === false ? (
                        <FieldDescription role="status" tone="warning">
                            {t('settings.row.hardwareAcceleration.offStatus')}
                        </FieldDescription>
                    ) : undefined,
                control: (
                    <Switch
                        id={controlId}
                        aria-label={row.accessibleTitle}
                        checked={argvConfig?.hardwareAcceleration ?? true}
                        className="mt-0.5"
                        disabled={!argvConfig}
                        onCheckedChange={(checked) =>
                            onArgvConfigChange({ hardwareAcceleration: checked })
                        }
                    />
                ),
            };
    }
}

/**
 * One Settings row: shared chrome (title, description, modified bar, reset) around the control resolved from the row's
 * binding.
 */
export function SettingRow(properties: SettingRowProperties) {
    const { row, context, handlers } = properties;
    const { t } = useTranslation();
    const { control, status, toggle, labelFor } = rowControl(t, properties);
    return (
        <SettingRowChrome
            control={control}
            fullWidth={isFullWidthRow(row)}
            labelFor={labelFor}
            modified={isRowModified(row.binding, context)}
            resettable={isRowResettable(row.binding)}
            row={row}
            status={status}
            toggle={toggle}
            onReset={() => handlers.onResetRow(row)}
        />
    );
}
