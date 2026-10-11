import { useState } from 'react';

import type { AgentChatPermissionMode, AgentChatSnapshot } from '@caxri/protocol';
import {
    agentChatPermissionModeDescription,
    agentChatPermissionModeLabel,
    agentChatPermissionModes,
} from '@caxri/protocol';
import { ChevronDown, ShieldAlert, ShieldCheck } from 'lucide-react';

import {
    Menu,
    MenuCheckboxItem,
    MenuContent,
    MenuGroup,
    MenuGroupLabel,
    MenuItem,
    MenuRadioGroup,
    MenuRadioItem,
    MenuSeparator,
    MenuTrigger,
} from '../../components/ui/menu';
import { useProjectById, useSessionById, useTerminal } from '../../stores/selectors';
import { configureAgentChatPermission, saveAgentChatProjectDefault } from './agent-chat-commands';
import {
    agentChatPermissionLabel,
    agentChatProjectDefault,
    isAgentChatProjectDefault,
} from './agent-chat-permissions';

const TRIGGER_CLASS_NAME =
    'flex h-7 min-w-0 shrink cursor-pointer items-center gap-1 rounded-md border-0 bg-transparent px-1.5 text-[12px] leading-4 text-muted transition-colors duration-(--motion-overlay-enter) ease-(--motion-ease-enter) hover:bg-elevated hover:text-foreground focus-visible:outline focus-visible:outline-accent data-popup-open:bg-elevated data-popup-open:text-foreground';

/**
 * The Chat's permission level and plan mode, and the menu that switches them, beside the model picker. Only the levels
 * the provider runs natively are offered, and the Plan mode row appears only for a provider that has one. Full access
 * carries a `--warning` shield so the riskiest level reads differently at a glance. "Use as Project default" saves the
 * current choice for the Project's new Chats of this provider; see `docs/agent-chat.md`.
 */
export function AgentChatPermissionMenu({
    snapshot,
    terminalId,
}: {
    snapshot: Pick<AgentChatSnapshot, 'permissionMode' | 'planMode'> | undefined;
    terminalId: string;
}) {
    const [isOpen, setOpen] = useState(false);
    const terminal = useTerminal(terminalId);
    const project = useProjectById(useSessionById(terminal?.sessionId)?.projectId);
    const provider = terminal && terminal.kind !== 'shell' ? terminal.kind : undefined;
    // A snapshot from before the Chat reported its permission has neither key.
    if (!snapshot || !provider || !('permissionMode' in snapshot || 'planMode' in snapshot))
        return null;
    const label = agentChatPermissionLabel(snapshot, provider);
    const isFullAccess = snapshot.permissionMode === 'fullAccess';
    const projectDefault = agentChatProjectDefault(snapshot);
    const isSavedDefault =
        projectDefault !== undefined &&
        isAgentChatProjectDefault(projectDefault, project?.chatDefaults, provider);
    const Icon = isFullAccess ? ShieldAlert : ShieldCheck;
    return (
        <Menu open={isOpen} onOpenChange={setOpen}>
            <MenuTrigger
                aria-label={`Permissions: ${label}${snapshot.planMode ? ', plan mode on' : ''}`}
                className={TRIGGER_CLASS_NAME}
            >
                <Icon className={`size-3.5 shrink-0 ${isFullAccess ? 'text-warning' : ''}`} />
                <span className="truncate">{label}</span>
                {snapshot.planMode && <span className="shrink-0 text-foreground">Plan</span>}
                <ChevronDown className="size-3 shrink-0" />
            </MenuTrigger>
            <MenuContent align="end" className="max-w-80 min-w-60" side="top">
                <MenuGroup>
                    <MenuGroupLabel>Permissions</MenuGroupLabel>
                    <MenuRadioGroup
                        value={snapshot.permissionMode ?? null}
                        onValueChange={(permissionMode: AgentChatPermissionMode) =>
                            configureAgentChatPermission(terminalId, { permissionMode })
                        }
                    >
                        {agentChatPermissionModes(provider).map((mode) => (
                            <MenuRadioItem key={mode} value={mode}>
                                <span className="flex min-w-0 flex-col">
                                    <span className="truncate">
                                        {agentChatPermissionModeLabel(mode, provider)}
                                    </span>
                                    <span className="truncate text-[11px] leading-4 text-muted">
                                        {agentChatPermissionModeDescription(provider, mode)}
                                    </span>
                                </span>
                            </MenuRadioItem>
                        ))}
                    </MenuRadioGroup>
                </MenuGroup>
                {snapshot.planMode !== undefined && (
                    <>
                        <MenuSeparator />
                        <MenuCheckboxItem
                            className="h-auto min-h-7 py-1"
                            checked={snapshot.planMode}
                            onCheckedChange={(isOn: boolean) =>
                                configureAgentChatPermission(terminalId, { planMode: isOn })
                            }
                        >
                            <span className="flex min-w-0 flex-col">
                                <span className="truncate">Plan mode</span>
                                <span className="truncate text-[11px] leading-4 text-muted">
                                    Plans first and changes nothing until you approve
                                </span>
                            </span>
                        </MenuCheckboxItem>
                    </>
                )}
                {project && projectDefault && (
                    <>
                        <MenuSeparator />
                        <MenuItem
                            disabled={isSavedDefault}
                            onClick={() =>
                                saveAgentChatProjectDefault(project.id, provider, projectDefault)
                            }
                        >
                            {isSavedDefault ? 'Project default' : 'Use as Project default'}
                        </MenuItem>
                    </>
                )}
            </MenuContent>
        </Menu>
    );
}
