import type { ReactNode } from 'react';

import type {
    AgentHookHealthMap,
    AgentSkillHealth,
    AppSettings,
    ArgvConfigChanges,
} from '@caxri/protocol';
import { agentProviderCatalog, settingsSpecByKey } from '@caxri/protocol';
import { Archive, RotateCcw } from 'lucide-react';

import { Button } from '../../components/ui/button';
import {
    Field,
    FieldContent,
    FieldDescription,
    FieldLabel,
    FieldTitle,
} from '../../components/ui/field';
import { Input } from '../../components/ui/input';
import { Switch } from '../../components/ui/switch';
import { Textarea } from '../../components/ui/textarea';
import { Tooltip } from '../../components/ui/tooltip';
import { AgentIdentityIcon } from '../../icons/agents/agent-identity-icon';
import { setArchivedSessionsOpen, setSettingsOpen } from '../../stores/dialogs';
import { AgentActionSettingsEditor } from './agent-action-settings-editor';
import { EnumControl } from './enum-control';
import { FilesExcludeEditor } from './files-exclude-editor';
import { IntegerControl } from './integer-control';
import { automaticNamingHealthLabel, hookHealthLabel } from './provider-health';
import { MobileAccessForm } from './mobile-access-form';
import { ProviderRecoveryEditor } from './provider-recovery-editor';
import { ProviderSkillHealth } from './provider-skill-health';
import type { SettingRowDescriptor } from './settings-registry';
import type { SettingsValueContext } from './settings-values';
import { isRowModified, isRowResettable, withProviderField } from './settings-values';
import { StringControl } from './string-control';
import { TerminalReferenceLinksForm } from './terminal-reference-links-form';
import { TrustedDomainsForm } from './trusted-domains-form';

interface SettingRowHandlers {
    onFieldChange: <K extends keyof AppSettings>(key: K, value: AppSettings[K]) => void;
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
 * Bindings whose editor spans the full row width instead of sitting right of the label.
 */
function isFullWidthRow(row: SettingRowDescriptor): boolean {
    if (row.binding.type === 'setting') return settingsSpecByKey[row.binding.key].kind === 'string';
    return [
        'files-exclude',
        'mobile-access',
        'provider-actions',
        'provider-launch',
        'provider-recovery',
        'provider-skill-health',
        'terminal-reference-links',
        'trusted-domains',
    ].includes(row.binding.type);
}

interface RowChromeProperties {
    row: SettingRowDescriptor;
    modified: boolean;
    resettable: boolean;
    onReset: () => void;
    /**
     * Rendered right of the label block (horizontal rows) or under it (full-width rows).
     */
    control: ReactNode;
    /**
     * Optional live status caption under the description (hook health).
     */
    status?: ReactNode;
    fullWidth: boolean;
    labelFor?: string;
}

function RowChrome({
    row,
    modified,
    resettable,
    onReset,
    control,
    status,
    fullWidth,
    labelFor,
}: RowChromeProperties) {
    const labelBlock = (
        <FieldContent>
            <span className="flex items-center gap-1.5">
                {labelFor ? (
                    <FieldLabel htmlFor={labelFor}>{row.title}</FieldLabel>
                ) : (
                    <FieldTitle>{row.title}</FieldTitle>
                )}
                {modified && resettable && (
                    <Tooltip content="Reset to default">
                        <Button
                            aria-label={`Reset ${row.title} to default`}
                            className="size-5 min-h-0 p-0 text-muted opacity-0 group-focus-within/setting:opacity-100 group-hover/setting:opacity-100 hover:text-foreground"
                            size="icon"
                            variant="ghost"
                            onClick={onReset}
                        >
                            <RotateCcw size={12} />
                        </Button>
                    </Tooltip>
                )}
            </span>
            {row.description && (
                <FieldDescription className="max-w-xl">{row.description}</FieldDescription>
            )}
            {status}
        </FieldContent>
    );
    return (
        <div
            data-setting-row={row.id}
            className="group/setting relative rounded-md px-3 py-2 hover:bg-[color-mix(in_srgb,var(--elevated)_45%,transparent)]"
        >
            {modified && (
                <span
                    aria-hidden="true"
                    className="absolute inset-y-2 left-0 w-[3px] rounded-full bg-[color-mix(in_srgb,var(--accent)_60%,transparent)]"
                />
            )}
            {fullWidth ? (
                <Field className="gap-2">
                    {labelBlock}
                    {control}
                </Field>
            ) : (
                <Field orientation="horizontal" className="min-h-9 items-start gap-4">
                    {labelBlock}
                    {control}
                </Field>
            )}
        </div>
    );
}

function rowControl(properties: SettingRowProperties): {
    control: ReactNode;
    status?: ReactNode;
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
            if (spec.kind === 'boolean')
                return {
                    labelFor: controlId,
                    control: (
                        <Switch
                            id={controlId}
                            aria-label={row.title}
                            checked={settings[binding.key] as boolean}
                            className="mt-0.5"
                            onCheckedChange={(checked) => onFieldChange(binding.key, checked)}
                        />
                    ),
                };
            if (spec.kind === 'integer')
                return {
                    labelFor: controlId,
                    control: (
                        <IntegerControl
                            id={controlId}
                            label={row.title}
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
                            label={row.title}
                            spec={spec}
                            value={settings[binding.key] as string | null}
                            renderOptionIcon={
                                binding.key === 'session.defaultAgent'
                                    ? (value) => <AgentIdentityIcon identity={value} size={14} />
                                    : undefined
                            }
                            onChange={(value) =>
                                onFieldChange(binding.key, value as AppSettings[typeof binding.key])
                            }
                        />
                    ),
                };
            if (spec.kind === 'string')
                return {
                    labelFor: controlId,
                    control: (
                        <StringControl
                            id={controlId}
                            label={row.title}
                            spec={spec}
                            value={settings[binding.key] as string | null}
                            onChange={(value) =>
                                onFieldChange(binding.key, value as AppSettings[typeof binding.key])
                            }
                        />
                    ),
                };
            // Complex specs always carry a dedicated binding; a 'setting' binding never reaches here.
            return { control: undefined };
        }
        case 'provider-toggle': {
            const providerName = agentProviderCatalog[binding.provider].displayName;
            const providerSettings = settings['agents.providers'][binding.provider];
            const isEnabled = providerSettings[binding.field].enabled;
            const status =
                binding.field === 'hooks' ? (
                    <FieldDescription role="status">
                        {hookHealthLabel(isEnabled, agentHookHealth?.[binding.provider])}
                    </FieldDescription>
                ) : binding.field === 'naming' ? (
                    <FieldDescription role="status">
                        {automaticNamingHealthLabel(
                            isEnabled,
                            providerSettings.hooks.enabled,
                            agentHookHealth?.[binding.provider],
                        )}
                    </FieldDescription>
                ) : undefined;
            const label = `${providerName} ${
                binding.field === 'hooks'
                    ? 'lifecycle hooks'
                    : binding.field === 'naming'
                      ? 'automatic Session naming'
                      : binding.field === 'pasteSummary'
                        ? 'long paste summaries'
                        : 'peer messaging'
            }`;
            return {
                labelFor: controlId,
                status,
                control: (
                    <Switch
                        id={controlId}
                        aria-label={label}
                        checked={isEnabled}
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
        case 'provider-launch': {
            const providerName = agentProviderCatalog[binding.provider].displayName;
            const launch = settings['agents.providers'][binding.provider].launch;
            if (binding.field === 'executable')
                return {
                    labelFor: controlId,
                    control: (
                        <Input
                            id={controlId}
                            aria-label={`${providerName} executable`}
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
                    <Textarea
                        id={controlId}
                        aria-label={`${providerName} initial arguments`}
                        className="bg-background text-foreground"
                        value={launch.args.join('\n')}
                        onChange={(event) =>
                            onFieldChange(
                                'agents.providers',
                                withProviderField(settings, binding.provider, {
                                    launch: {
                                        ...launch,
                                        args: event.target.value
                                            .split('\n')
                                            .filter((argument) => argument.length > 0),
                                    },
                                }),
                            )
                        }
                    />
                ),
            };
        }
        case 'provider-recovery': {
            const recovery = settings['agents.providers'][binding.provider].recovery;
            return {
                labelFor: controlId,
                control: (
                    <ProviderRecoveryEditor
                        id={controlId}
                        provider={binding.provider}
                        value={recovery}
                        onChange={(value) =>
                            onFieldChange(
                                'agents.providers',
                                withProviderField(settings, binding.provider, { recovery: value }),
                            )
                        }
                    />
                ),
            };
        }
        case 'provider-actions':
            return {
                control: (
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
                        value={settings['files.exclude']}
                        onChange={(value) => onFieldChange('files.exclude', value)}
                    />
                ),
            };
        case 'archived-sessions':
            return {
                control: (
                    <Button
                        className="archived-sessions-entry w-44 flex-none"
                        variant="secondary"
                        onClick={() => {
                            /**
                             * The manager is its own dialog; closing Settings first keeps a single modal layer instead
                             * of stacking two dismiss targets.
                             */
                            setSettingsOpen(false);
                            setArchivedSessionsOpen(true);
                        }}
                    >
                        <Archive aria-hidden="true" size={14} />
                        Manage…
                    </Button>
                ),
            };
        case 'mobile-access':
            return { control: <MobileAccessForm /> };
        case 'remote-debugging':
            return {
                labelFor: controlId,
                control: (
                    <Switch
                        id={controlId}
                        aria-label={row.title}
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
                control: (
                    <Switch
                        id={controlId}
                        aria-label={row.title}
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
    const { control, status, labelFor } = rowControl(properties);
    return (
        <RowChrome
            control={control}
            fullWidth={isFullWidthRow(row)}
            labelFor={labelFor}
            modified={isRowModified(row.binding, context)}
            resettable={isRowResettable(row.binding)}
            row={row}
            status={status}
            onReset={() => handlers.onResetRow(row)}
        />
    );
}
