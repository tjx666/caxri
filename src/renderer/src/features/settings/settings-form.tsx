import { agentProviderCatalog, agentProviderIds } from '@shared/agents';
import type {
    AgentHookHealthMap,
    AgentSkillHealth,
    AppSettings,
    ArgvConfig,
    ArgvConfigChanges,
} from '@shared/types';
import { Archive } from 'lucide-react';

import { Button } from '../../components/ui/button';
import {
    Field,
    FieldContent,
    FieldDescription,
    FieldLabel,
    FieldTitle,
} from '../../components/ui/field';
import { Input } from '../../components/ui/input';
import {
    Select,
    SelectContent,
    SelectItem,
    SelectTrigger,
    SelectValue,
} from '../../components/ui/select';
import { Switch } from '../../components/ui/switch';
import { AgentIdentityIcon } from '../../icons/agents/agent-identity-icon';
import { setArchivedSessionsOpen, setSettingsOpen } from '../../stores/dialogs';
import { AgentProviderSettings } from './agent-provider-settings';
import { bytesToMebibytes, mebibytesToBytes } from './config-edit';
import { TrustedDomainsForm } from './trusted-domains-form';

interface SettingsFormProperties {
    agentHookHealth?: AgentHookHealthMap;
    agentSkillHealth?: AgentSkillHealth;
    /**
     * Main-owned boot configuration (`argv.jsonc`); undefined until its `argv.get` fetch resolves.
     */
    argvConfig?: ArgvConfig;
    trustedDomainsFocusRequestId?: number;
    settings: AppSettings;
    onArgvConfigChange: (changes: ArgvConfigChanges) => void;
    onFieldChange: <K extends keyof AppSettings>(key: K, value: AppSettings[K]) => void;
}

function defaultAgentLabel(agent: AppSettings['session.defaultAgent']): string {
    if (agent === 'shell') return 'Shell';
    if (agent && Object.hasOwn(agentProviderCatalog, agent))
        return agentProviderCatalog[agent].displayName;
    return 'Ask each time';
}

const NEW_WORKTREE_BEHAVIOR_LABELS: Record<AppSettings['workbench.newWorktreeBehavior'], string> = {
    ask: 'Ask',
    continueWhenAuthorized: 'Continue when authorized',
    ignore: 'Ignore',
};

/**
 * Full-width structured editor for `settings.jsonc`.
 */
export function SettingsForm({
    agentHookHealth,
    agentSkillHealth,
    argvConfig,
    trustedDomainsFocusRequestId,
    settings,
    onArgvConfigChange,
    onFieldChange,
}: SettingsFormProperties) {
    const maxFileMebibytes = bytesToMebibytes(settings['files.maxFileBytes']);

    return (
        <div className="min-h-0 overflow-hidden">
            <div className="structured-editor h-full min-h-0 overflow-auto p-4">
                <Field orientation="horizontal" className="mb-3 min-h-9 gap-4">
                    <FieldContent>
                        <FieldLabel htmlFor="default-agent">
                            Default agent for new sessions
                        </FieldLabel>
                    </FieldContent>
                    <Select
                        value={settings['session.defaultAgent'] ?? 'ask'}
                        onValueChange={(value) =>
                            onFieldChange(
                                'session.defaultAgent',
                                (value === 'ask'
                                    ? null
                                    : value) as AppSettings['session.defaultAgent'],
                            )
                        }
                    >
                        <SelectTrigger
                            id="default-agent"
                            aria-label="Default agent for new sessions"
                            className="w-44 flex-none bg-background"
                        >
                            <SelectValue>
                                <span className="flex items-center gap-2">
                                    <AgentIdentityIcon
                                        identity={settings['session.defaultAgent']}
                                        size={14}
                                    />
                                    {defaultAgentLabel(settings['session.defaultAgent'])}
                                </span>
                            </SelectValue>
                        </SelectTrigger>
                        <SelectContent>
                            <SelectItem value="ask">
                                <span className="flex items-center gap-2">
                                    <AgentIdentityIcon identity={null} size={14} /> Ask each time
                                </span>
                            </SelectItem>
                            {agentProviderIds.map((provider) => (
                                <SelectItem key={provider} value={provider}>
                                    <span className="flex items-center gap-2">
                                        <AgentIdentityIcon identity={provider} size={14} />
                                        {agentProviderCatalog[provider].displayName}
                                    </span>
                                </SelectItem>
                            ))}
                            <SelectItem value="shell">
                                <span className="flex items-center gap-2">
                                    <AgentIdentityIcon identity="shell" size={14} /> Shell
                                </span>
                            </SelectItem>
                        </SelectContent>
                    </Select>
                </Field>
                <Field orientation="horizontal" className="mb-3 min-h-9 gap-4">
                    <FieldContent>
                        <FieldLabel htmlFor="new-worktree-behavior">
                            New worktree behavior
                        </FieldLabel>
                        <FieldDescription>
                            First access to a worktree always requires directory authorization
                        </FieldDescription>
                    </FieldContent>
                    <Select
                        value={settings['workbench.newWorktreeBehavior']}
                        onValueChange={(value) =>
                            onFieldChange(
                                'workbench.newWorktreeBehavior',
                                value as AppSettings['workbench.newWorktreeBehavior'],
                            )
                        }
                    >
                        <SelectTrigger
                            id="new-worktree-behavior"
                            aria-label="New worktree behavior"
                            className="w-52 flex-none bg-background"
                        >
                            <SelectValue>
                                {
                                    NEW_WORKTREE_BEHAVIOR_LABELS[
                                        settings['workbench.newWorktreeBehavior']
                                    ]
                                }
                            </SelectValue>
                        </SelectTrigger>
                        <SelectContent>
                            <SelectItem value="ask">Ask</SelectItem>
                            <SelectItem value="continueWhenAuthorized">
                                Continue when authorized
                            </SelectItem>
                            <SelectItem value="ignore">Ignore</SelectItem>
                        </SelectContent>
                    </Select>
                </Field>
                <Field orientation="horizontal" className="mb-3 min-h-9 gap-4">
                    <FieldContent>
                        <FieldTitle>Archived Sessions</FieldTitle>
                        <FieldDescription>
                            Restore or permanently delete archived Sessions
                        </FieldDescription>
                    </FieldContent>
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
                </Field>
                <Field orientation="horizontal" className="mb-3 min-h-9 gap-4">
                    <FieldContent>
                        <FieldLabel htmlFor="terminal-font-size">Terminal font size</FieldLabel>
                    </FieldContent>
                    <span className="relative w-40 flex-none">
                        <Input
                            id="terminal-font-size"
                            className="bg-background pr-8"
                            type="number"
                            min={9}
                            max={32}
                            value={settings['terminal.fontSize']}
                            onChange={(event) =>
                                onFieldChange('terminal.fontSize', Number(event.target.value))
                            }
                        />
                        <span className="pointer-events-none absolute top-1/2 right-2 -translate-y-1/2 text-[11px] text-muted">
                            px
                        </span>
                    </span>
                </Field>
                <Field orientation="horizontal" className="mb-3 min-h-9 gap-4">
                    <FieldContent>
                        <FieldLabel htmlFor="terminal-gpu-acceleration">
                            Terminal GPU acceleration
                        </FieldLabel>
                        <FieldDescription>
                            WebGL falls back to DOM rendering without restarting the Terminal
                        </FieldDescription>
                    </FieldContent>
                    <Select
                        value={settings['terminal.gpuAcceleration']}
                        onValueChange={(value) =>
                            onFieldChange(
                                'terminal.gpuAcceleration',
                                value as AppSettings['terminal.gpuAcceleration'],
                            )
                        }
                    >
                        <SelectTrigger
                            id="terminal-gpu-acceleration"
                            aria-label="Terminal GPU acceleration"
                            className="w-40 flex-none bg-background"
                        >
                            <SelectValue />
                        </SelectTrigger>
                        <SelectContent>
                            <SelectItem value="auto">Auto</SelectItem>
                            <SelectItem value="on">On</SelectItem>
                            <SelectItem value="off">Off</SelectItem>
                        </SelectContent>
                    </Select>
                </Field>
                <Field orientation="horizontal" className="mb-3 min-h-9 gap-4">
                    <FieldContent>
                        <FieldLabel htmlFor="terminal-scrollback">
                            Terminal scrollback lines
                        </FieldLabel>
                    </FieldContent>
                    <span className="relative w-40 flex-none">
                        <Input
                            id="terminal-scrollback"
                            className="bg-background pr-12"
                            type="number"
                            min={100}
                            max={10000}
                            value={settings['terminal.scrollback']}
                            onChange={(event) =>
                                onFieldChange('terminal.scrollback', Number(event.target.value))
                            }
                        />
                        <span className="pointer-events-none absolute top-1/2 right-2 -translate-y-1/2 text-[11px] text-muted">
                            lines
                        </span>
                    </span>
                </Field>
                <Field orientation="horizontal" className="mb-3 min-h-9 gap-4">
                    <FieldContent>
                        <FieldLabel htmlFor="terminal-copy-on-select">Copy on select</FieldLabel>
                        <FieldDescription>
                            Automatically copy Terminal selections to the clipboard
                        </FieldDescription>
                    </FieldContent>
                    <Switch
                        id="terminal-copy-on-select"
                        aria-label="Copy on select"
                        checked={settings['terminal.copyOnSelect']}
                        onCheckedChange={(checked) =>
                            onFieldChange('terminal.copyOnSelect', checked)
                        }
                    />
                </Field>
                <Field orientation="horizontal" className="mb-3 min-h-9 gap-4">
                    <FieldContent>
                        <FieldLabel htmlFor="terminal-osc52-clipboard-write">
                            Allow OSC 52 clipboard writes
                        </FieldLabel>
                        <FieldDescription>
                            Remote programs may request bounded writes; clipboard reads stay blocked
                        </FieldDescription>
                    </FieldContent>
                    <Switch
                        id="terminal-osc52-clipboard-write"
                        aria-label="Allow OSC 52 clipboard writes"
                        checked={settings['terminal.osc52ClipboardWrite']}
                        onCheckedChange={(checked) =>
                            onFieldChange('terminal.osc52ClipboardWrite', checked)
                        }
                    />
                </Field>
                <Field orientation="horizontal" className="mb-3 min-h-9 gap-4">
                    <FieldContent>
                        <FieldLabel htmlFor="remote-debugging-cdp">Remote debugging (CDP)</FieldLabel>
                        <FieldDescription>
                            Expose Chrome DevTools Protocol on 127.0.0.1:9223 for agent tooling;
                            takes effect after restarting Caxri
                        </FieldDescription>
                    </FieldContent>
                    <Switch
                        id="remote-debugging-cdp"
                        aria-label="Remote debugging (CDP)"
                        checked={argvConfig?.remoteDebugging ?? true}
                        disabled={!argvConfig}
                        onCheckedChange={(checked) =>
                            onArgvConfigChange({ remoteDebugging: checked })
                        }
                    />
                </Field>
                <Field className="mb-4">
                    <FieldLabel htmlFor="terminal-default-working-directory">
                        New Terminal working directory
                    </FieldLabel>
                    <FieldDescription>Leave empty to use the Project root</FieldDescription>
                    <Input
                        id="terminal-default-working-directory"
                        className="bg-background"
                        placeholder="Project root"
                        value={settings['terminal.defaultWorkingDirectory'] ?? ''}
                        onChange={(event) =>
                            onFieldChange(
                                'terminal.defaultWorkingDirectory',
                                event.target.value || null,
                            )
                        }
                    />
                </Field>
                <TrustedDomainsForm
                    focusRequestId={trustedDomainsFocusRequestId}
                    rules={settings['security.trustedDomains']}
                    onChange={(rules) => onFieldChange('security.trustedDomains', rules)}
                />
                <Field orientation="horizontal" className="mb-3 min-h-9 gap-4">
                    <FieldContent>
                        <FieldLabel htmlFor="max-editable-file-size">
                            Maximum editable file size
                        </FieldLabel>
                    </FieldContent>
                    <span className="relative w-40 flex-none">
                        <Input
                            id="max-editable-file-size"
                            className="bg-background pr-8"
                            type="number"
                            min={0.001}
                            max={16}
                            step={0.5}
                            value={maxFileMebibytes}
                            onChange={(event) =>
                                onFieldChange(
                                    'files.maxFileBytes',
                                    mebibytesToBytes(Number(event.target.value)),
                                )
                            }
                        />
                        <span className="pointer-events-none absolute top-1/2 right-2 -translate-y-1/2 text-[11px] text-muted">
                            MB
                        </span>
                    </span>
                </Field>
                {agentProviderIds.map((provider) => (
                    <AgentProviderSettings
                        key={provider}
                        agentHookHealth={agentHookHealth}
                        agentSkillHealth={agentSkillHealth}
                        provider={provider}
                        providerSettings={settings['agents.providers'][provider]}
                        onChange={(providerSettings) =>
                            onFieldChange('agents.providers', {
                                ...settings['agents.providers'],
                                [provider]: providerSettings,
                            })
                        }
                    />
                ))}
            </div>
        </div>
    );
}
