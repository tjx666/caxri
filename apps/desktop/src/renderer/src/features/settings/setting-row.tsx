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
    MAX_DELEGATION_DEPTH,
    MIN_DELEGATION_DEPTH,
    settingsSpecByKey,
} from '@caxri/protocol';
import { Archive, Info, RotateCcw } from 'lucide-react';

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
import { Tooltip } from '../../components/ui/tooltip';
import { AgentIdentityIcon } from '../../icons/agents/agent-identity-icon';
import { setArchivedSessionsOpen } from '../../stores/dialogs';
import { AgentActionSettingsEditor } from './agent-action-settings-editor';
import { EnumControl } from './enum-control';
import { FilesExcludeEditor } from './files-exclude-editor';
import { IgnoredChecksForm } from './ignored-checks-form';
import { IntegerControl } from './integer-control';
import { LaunchArgumentsField } from './launch-arguments-field';
import { MobileAccessForm } from './mobile-access-form';
import { hasProviderAutonomy, withProviderAutonomy } from './provider-autonomy';
import { hookHealthLabel, hookHealthTone, isHookAdapterAvailable } from './provider-health';
import { ProviderRecoveryEditor } from './provider-recovery-editor';
import { ProviderSkillHealth } from './provider-skill-health';
import { isFullWidthRow } from './setting-row-layout';
import type { SettingRowDescriptor } from './settings-registry';
import type { SettingsValueContext } from './settings-values';
import { isRowModified, isRowResettable, withProviderField } from './settings-values';
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
    /**
     * A full-width row's own on/off switch, kept at the row's right end like every other toggle in Settings while its
     * expanded fields stay below. Without this the switch fell under the description and left-aligned, so one screen
     * showed the same control in two places.
     */
    toggle?: ReactNode;
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
    toggle,
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
                            aria-label={`Reset ${row.accessibleTitle} to default`}
                            className="size-5 min-h-0 p-0 text-muted opacity-0 group-focus-within/setting:opacity-100 group-hover/setting:opacity-100 hover:text-foreground"
                            size="icon"
                            variant="ghost"
                            onClick={onReset}
                        >
                            <RotateCcw size={12} />
                        </Button>
                    </Tooltip>
                )}
                {row.detail && (
                    <Tooltip content={row.detail}>
                        <Button
                            aria-label={`More about ${row.accessibleTitle}`}
                            className="size-5 min-h-0 p-0 text-muted hover:text-foreground"
                            size="icon"
                            variant="ghost"
                        >
                            <Info size={12} />
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
                    {toggle ? (
                        <div className="flex min-h-9 w-full items-start gap-4">
                            {labelBlock}
                            {toggle}
                        </div>
                    ) : (
                        labelBlock
                    )}
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

function rowControl(properties: SettingRowProperties): {
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
            if (spec.kind === 'boolean')
                return {
                    labelFor: controlId,
                    control: (
                        <Switch
                            id={controlId}
                            aria-label={row.accessibleTitle}
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
            if (spec.kind === 'string') {
                /**
                 * `updates.skippedVersion` is state the app wrote for you (from "Skip this version" in the update
                 * notice), not a value worth typing by hand — a free-text field invited exactly that, mixing a fact
                 * about app state into a list of controls you deliberately configure (issue caxri#1289). Read-only text
                 * says what is currently skipped; the row's existing hover-Reset action, armed by `isRowModified`
                 * treating any non-null value as modified, is the one way back — the same undo every other row already
                 * offers, so this needs no dedicated binding or "Clear" button of its own.
                 */
                if (binding.key === 'updates.skippedVersion') {
                    const skipped = settings[binding.key];
                    return {
                        control: (
                            <FieldDescription role="status">
                                {skipped
                                    ? `Currently skipping ${skipped}.`
                                    : 'No version currently skipped.'}
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
            // Complex specs always carry a dedicated binding; a 'setting' binding never reaches here.
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
                        {hookHealthLabel(isEnabled, agentHookHealth?.[binding.provider])}
                    </FieldDescription>
                ) : !supported ? (
                    <FieldDescription>Unavailable for {providerName}.</FieldDescription>
                ) : undefined;
            const label = `${providerName} ${
                binding.field === 'hooks' ? 'lifecycle hooks' : 'peer messaging'
            }`;
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
                        aria-label={`Let ${providerName} act without asking each time`}
                        checked={hasProviderAutonomy(launch.args, binding.provider)}
                        className="mt-0.5"
                        onCheckedChange={(checked) =>
                            onFieldChange(
                                'agents.providers',
                                withProviderField(settings, binding.provider, {
                                    launch: {
                                        ...launch,
                                        args: withProviderAutonomy(
                                            launch.args,
                                            binding.provider,
                                            checked,
                                        ),
                                    },
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
                    <LaunchArgumentsField
                        id={controlId}
                        label={`${providerName} initial arguments`}
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
                        aria-label={`${agentProviderCatalog[binding.provider].displayName} network error recovery`}
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
                        Actions and skills are unavailable for{' '}
                        {agentProviderCatalog[binding.provider].displayName}.
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
                        label={
                            binding.key === 'git.diffExclude'
                                ? 'Excluded Git diff files'
                                : 'Excluded files'
                        }
                        placeholder={binding.key === 'git.diffExclude' ? '**/*.test.*' : undefined}
                        value={settings[binding.key]}
                        onChange={(value) => onFieldChange(binding.key, value)}
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
                            // The manager is its own dialog, floating over the Settings tab like any other modal
                            // opened over a document — there is no modal layer to close first any more.
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
                 * after the restart that applied it there is nowhere else in the product that names it — so the row
                 * states it in the warning tone, in the same words the notice used.
                 */
                status:
                    argvConfig?.hardwareAcceleration === false ? (
                        <FieldDescription role="status" tone="warning">
                            Caxri starts with software rendering until this is turned back on.
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
    const { control, status, toggle, labelFor } = rowControl(properties);
    return (
        <RowChrome
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
