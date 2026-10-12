import { useState } from 'react';

import type { AgentChatPermissionMode, AgentChatSnapshot, AgentProvider } from '@caxri/protocol';
import { agentChatPermissionModes } from '@caxri/protocol';
import { ChevronDown, ShieldAlert, ShieldCheck } from 'lucide-react';

import {
    Menu,
    MenuCheckboxItem,
    MenuContent,
    MenuGroup,
    MenuGroupLabel,
    MenuRadioGroup,
    MenuRadioItem,
    MenuSeparator,
    MenuTrigger,
} from '../../components/ui/menu';
import { Spinner } from '../../components/ui/spinner';
import { useTranslation } from '../../i18n';
import { useProjectById, useSessionById, useTerminal } from '../../stores/selectors';
import { saveAgentChatProjectDefault } from './agent-chat-commands';
import type { AgentChatProjectDefaultItem } from './agent-chat-permissions';
import {
    AGENT_CHAT_CUSTOM_PERMISSION,
    agentChatPermissionModeHint,
    agentChatPermissionModeName,
    agentChatPermissionView,
} from './agent-chat-permissions';
import { useAgentChatPermissionSelection } from './hooks/use-agent-chat-permission-selection';

const TRIGGER_CLASS_NAME =
    'flex h-7 min-w-0 shrink cursor-pointer items-center gap-1 rounded-md border-0 bg-transparent px-1.5 text-[12px] leading-4 text-muted transition-colors duration-(--motion-overlay-enter) ease-(--motion-ease-enter) hover:bg-elevated hover:text-foreground focus-visible:outline focus-visible:outline-accent data-popup-open:bg-elevated data-popup-open:text-foreground';

/**
 * The Chat's permission level and plan mode, and the menu that switches them, beside the model picker. Only the levels
 * the provider runs natively are offered, and the Plan mode row appears only for a provider that has one. Full access
 * carries a `--warning` shield so the riskiest level reads differently at a glance. Like the model picker, a choice
 * shows at once with a spinner until the snapshot confirms it, and reverts with a toast when it fails; picking a level
 * closes the menu. A provider that applies a switch only with the next turn (Codex) says so while a turn runs: the menu
 * notes it, and the trigger adds `from next turn` until that turn ends. Launch settings no level matches read as a
 * checked "Custom" row. "Use as Project default" saves the current choice for the Project's new Chats of this provider,
 * shows as a checked "Project default" once saved, and stays visible but disabled, with the reason, while the level is
 * Custom; see `docs/agent-chat.md`. The Agent Commander window omits it, because Main's Commander policy refuses
 * Project writes.
 */
export function AgentChatPermissionMenu({
    canSaveProjectDefault,
    snapshot: reported,
    terminalId,
}: {
    /**
     * Whether the host can save a Project default (`AgentChatHostCapabilities`).
     */
    canSaveProjectDefault: boolean;
    snapshot: Pick<AgentChatSnapshot, 'activeTurnId' | 'permissionMode' | 'planMode'> | undefined;
    terminalId: string;
}) {
    const { t } = useTranslation();
    const [isOpen, setOpen] = useState(false);
    const terminal = useTerminal(terminalId);
    const project = useProjectById(useSessionById(terminal?.sessionId)?.projectId);
    const provider = terminal && terminal.kind !== 'shell' ? terminal.kind : undefined;
    const { configure, isDeferred, isNextTurnOnly, isPending, snapshot } =
        useAgentChatPermissionSelection(reported, provider, terminalId);
    // A snapshot from before the Chat reported its permission has neither key.
    if (!snapshot || !provider || !('permissionMode' in snapshot || 'planMode' in snapshot))
        return null;
    const view = agentChatPermissionView(snapshot, provider, project?.chatDefaults, {
        isDeferred,
    });
    const Icon = view.isFullAccess ? ShieldAlert : ShieldCheck;
    const { projectDefault } = view;
    return (
        <Menu open={isOpen} onOpenChange={setOpen}>
            <MenuTrigger aria-label={view.ariaLabel} className={TRIGGER_CLASS_NAME}>
                <Icon className={`size-3.5 shrink-0 ${view.isFullAccess ? 'text-warning' : ''}`} />
                <span className="truncate">{view.label}</span>
                {snapshot.planMode && (
                    <span className="shrink-0 text-foreground">
                        {t('agentChat.permission.plan')}
                    </span>
                )}
                {view.pendingCaption && (
                    <span className="truncate text-[11px] text-muted">{view.pendingCaption}</span>
                )}
                {isPending ? (
                    <Spinner
                        aria-label={t('agentChat.model.switching')}
                        className="size-3 shrink-0"
                    />
                ) : (
                    <ChevronDown className="size-3 shrink-0" />
                )}
            </MenuTrigger>
            {/* The trigger sits at the composer's leading edge, so the menu opens aligned to its start. */}
            <MenuContent align="start" className="max-w-80 min-w-60" side="top">
                <AgentChatPermissionMenuItems
                    isNextTurnOnly={isNextTurnOnly}
                    planMode={snapshot.planMode}
                    permissionMode={snapshot.permissionMode}
                    provider={provider}
                    onLevelChange={(permissionMode) => {
                        configure({ permissionMode });
                        setOpen(false);
                    }}
                    onPlanModeChange={(isOn) => configure({ planMode: isOn })}
                />
                {canSaveProjectDefault && project && (
                    <>
                        <MenuSeparator />
                        <ProjectDefaultItem
                            item={view.projectDefaultItem}
                            onSave={() => {
                                if (projectDefault)
                                    saveAgentChatProjectDefault(
                                        project.id,
                                        provider,
                                        projectDefault,
                                    );
                            }}
                        />
                    </>
                )}
            </MenuContent>
        </Menu>
    );
}

/**
 * "Use as Project default", a checked "Project default" once the Chat matches the saved default, or the disabled row
 * with its reason while the level is Custom.
 */
function ProjectDefaultItem({
    item,
    onSave,
}: {
    item: AgentChatProjectDefaultItem;
    onSave: () => void;
}) {
    return (
        <MenuCheckboxItem
            checked={item.isChecked}
            className="h-auto min-h-7 py-1"
            disabled={item.disabledReason !== undefined}
            onCheckedChange={(isChecked: boolean) => {
                // Already the default: there is nothing to save, and the row keeps its check.
                if (isChecked) onSave();
            }}
        >
            <span className="flex min-w-0 flex-col">
                <span className="truncate">{item.label}</span>
                {item.disabledReason && (
                    <span className="truncate text-[11px] leading-4 text-muted">
                        {item.disabledReason}
                    </span>
                )}
            </span>
        </MenuCheckboxItem>
    );
}

/**
 * The level radio group, with a checked Custom row while launch settings decide the level, and, for a provider with
 * one, the Plan mode checkbox.
 */
function AgentChatPermissionMenuItems({
    isNextTurnOnly,
    permissionMode,
    planMode,
    provider,
    onLevelChange,
    onPlanModeChange,
}: {
    /**
     * A turn runs and the provider applies a switch only from the next turn.
     */
    isNextTurnOnly: boolean;
    permissionMode: AgentChatPermissionMode | undefined;
    planMode: boolean | undefined;
    provider: AgentProvider;
    onLevelChange: (permissionMode: AgentChatPermissionMode) => void;
    onPlanModeChange: (isOn: boolean) => void;
}) {
    const { t } = useTranslation();
    return (
        <>
            <MenuGroup>
                <MenuGroupLabel>{t('agentChat.permission.permissions')}</MenuGroupLabel>
                {isNextTurnOnly && (
                    <p className="m-0 px-2 pb-1 text-[11px] leading-4 text-muted">
                        {t('agentChat.permission.appliesNextTurn')}
                    </p>
                )}
                <MenuRadioGroup
                    value={permissionMode ?? AGENT_CHAT_CUSTOM_PERMISSION.value}
                    onValueChange={(next: AgentChatPermissionMode | 'custom') => {
                        // Custom only explains the launch settings; there is nothing to switch back to.
                        if (next !== AGENT_CHAT_CUSTOM_PERMISSION.value) onLevelChange(next);
                    }}
                >
                    {permissionMode === undefined && (
                        <MenuRadioItem value={AGENT_CHAT_CUSTOM_PERMISSION.value}>
                            <span className="flex min-w-0 flex-col">
                                <span className="truncate">
                                    {t('agentChat.permission.customRow')}
                                </span>
                                <span className="truncate text-[11px] leading-4 text-muted">
                                    {t('agentChat.permission.customRowDescription')}
                                </span>
                            </span>
                        </MenuRadioItem>
                    )}
                    {agentChatPermissionModes(provider).map((mode) => (
                        <MenuRadioItem key={mode} value={mode}>
                            <span className="flex min-w-0 flex-col">
                                <span className="truncate">
                                    {agentChatPermissionModeName(mode, provider)}
                                </span>
                                <span className="truncate text-[11px] leading-4 text-muted">
                                    {agentChatPermissionModeHint(provider, mode)}
                                </span>
                            </span>
                        </MenuRadioItem>
                    ))}
                </MenuRadioGroup>
            </MenuGroup>
            {planMode !== undefined && (
                <>
                    <MenuSeparator />
                    <MenuCheckboxItem
                        className="h-auto min-h-7 py-1"
                        checked={planMode}
                        onCheckedChange={onPlanModeChange}
                    >
                        <span className="flex min-w-0 flex-col">
                            <span className="truncate">{t('agentChat.permission.planMode')}</span>
                            <span className="truncate text-[11px] leading-4 text-muted">
                                {t('agentChat.permission.planModeDescription')}
                            </span>
                        </span>
                    </MenuCheckboxItem>
                </>
            )}
        </>
    );
}
