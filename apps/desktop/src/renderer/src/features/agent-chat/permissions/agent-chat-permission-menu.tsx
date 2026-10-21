import type { AgentChatPermissionMode, AgentProvider } from '@caxri/protocol';
import {
    agentChatPermissionModeDescription,
    agentChatPermissionModeLabel,
    agentChatPermissionModes,
} from '@caxri/protocol';
import type { LucideIcon } from 'lucide-react';
import {
    BotMessageSquare,
    Eye,
    FilePen,
    Hand,
    ShieldAlert,
    ShieldCheck,
    SlidersHorizontal,
} from 'lucide-react';

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
} from '../../../components/ui/menu';
import { Spinner } from '../../../components/ui/spinner';
import { Tooltip } from '../../../components/ui/tooltip';
import { useTranslation } from '../../../i18n';
import { useCommandShortcut } from '../../../lib/keybindings';
import { cn } from '../../../lib/utilities';
import { useProjectById, useSessionById, useTerminal } from '../../../stores/selectors';
import { setAgentChatProjectDefault } from '../agent-chat-commands';
import { useAgentChatComposerMenu } from '../hooks/use-agent-chat-composer-command';
import type { AgentChatProjectDefaultItem } from './agent-chat-permissions';
import { AGENT_CHAT_CUSTOM_PERMISSION, agentChatPermissionView } from './agent-chat-permissions';
import type { useAgentChatPermissionSelection } from './use-agent-chat-permission-selection';

/**
 * Each level's glyph, as the Codex app leads every approval row with one, so what the Agent may do reads at a glance.
 * Full access keeps the trigger's warning shield.
 */
const LEVEL_ICONS: Record<AgentChatPermissionMode, LucideIcon> = {
    acceptEdits: FilePen,
    ask: Hand,
    auto: BotMessageSquare,
    fullAccess: ShieldAlert,
    readOnly: Eye,
};

const TRIGGER_CLASS_NAME =
    'flex h-7 min-w-0 shrink cursor-pointer items-center gap-1 rounded-md border-0 bg-transparent px-1.5 text-[12px] leading-4 text-muted transition-colors hover:bg-elevated hover:text-foreground focus-visible:outline focus-visible:outline-accent data-popup-open:bg-elevated data-popup-open:text-foreground';

/**
 * The Chat's permission level and the menu that switches it, beside `+`, which owns plan mode. Only the levels the
 * provider runs natively are offered. Like the Codex app, the trigger carries no disclosure chevron. Full access keeps
 * the muted trigger color and differs only by its alert shield: users who run it every day found a permanently yellow
 * trigger noisy, and the menu still marks it in `--warning`. Like the model picker, a choice shows at once with a
 * spinner until the snapshot confirms it, and reverts with a toast when it fails; picking a level closes the menu. A
 * provider that applies a switch only with the next turn (Codex) says so while a turn runs: the menu notes it, and the
 * trigger adds `from next turn` until that turn ends. Launch settings no level matches read as a checked "Custom" row.
 * "Use as Project default" saves the current choice for the Project's new Chats of this provider, shows as a checked
 * "Project default" once saved (and unchecking it clears the default), and stays visible but disabled, with the reason,
 * while the level is Custom; see `docs/agent-chat.md`. While the Project has a saved default the Chat's choice differs
 * from, "Clear Project default" removes it so new Chats follow the launch settings again. The Agent Commander window
 * omits both rows, because Main's Commander policy refuses Project writes. `agentChat.changePermissionMode` opens it
 * from the keyboard, and its tooltip names that shortcut.
 */
export function AgentChatPermissionMenu({
    canSaveProjectDefault,
    provider,
    selection,
    terminalId,
}: {
    /**
     * Whether the host can save a Project default (`AgentChatHostCapabilities`).
     */
    canSaveProjectDefault: boolean;
    provider: AgentProvider | undefined;
    /**
     * The selection the composer shares with `+`, which switches plan mode through the same optimistic state.
     */
    selection: ReturnType<typeof useAgentChatPermissionSelection>;
    terminalId: string;
}) {
    const { t } = useTranslation();
    const terminal = useTerminal(terminalId);
    const project = useProjectById(useSessionById(terminal?.sessionId)?.projectId);
    const { configure, isDeferred, isNextTurnOnly, isPending, snapshot } = selection;
    // A snapshot from before the Chat reported its permission has neither key.
    const isShown =
        snapshot !== undefined &&
        provider !== undefined &&
        ('permissionMode' in snapshot || 'planMode' in snapshot);
    const { finalFocus, isOpen, setOpen } = useAgentChatComposerMenu(
        terminalId,
        'changePermissionMode',
        isShown,
    );
    const shortcut = useCommandShortcut('agentChat.changePermissionMode');
    if (!isShown) return null;
    const view = agentChatPermissionView(snapshot, provider, project?.chatDefaults, {
        isDeferred,
    });
    const Icon = view.isFullAccess ? ShieldAlert : ShieldCheck;
    const { projectDefault } = view;
    return (
        <Menu open={isOpen} onOpenChange={setOpen}>
            <Tooltip content={t('agentChat.permission.permissions')} shortcut={shortcut}>
                <MenuTrigger aria-label={view.ariaLabel} className={TRIGGER_CLASS_NAME}>
                    <Icon className="size-3.5 shrink-0" />
                    <span className="truncate">{view.label}</span>
                    {view.pendingCaption && (
                        <span className="truncate text-[11px] text-muted">
                            {view.pendingCaption}
                        </span>
                    )}
                    {isPending && (
                        <Spinner
                            aria-label={t('agentChat.model.switching')}
                            className="size-3 shrink-0"
                        />
                    )}
                </MenuTrigger>
            </Tooltip>
            {/* The trigger sits at the composer's leading edge, so the menu opens aligned to its start. */}
            <MenuContent
                align="start"
                className="max-w-80 min-w-60"
                finalFocus={finalFocus}
                side="top"
            >
                <AgentChatPermissionMenuItems
                    isNextTurnOnly={isNextTurnOnly}
                    permissionMode={snapshot.permissionMode}
                    provider={provider}
                    onLevelChange={(permissionMode) => {
                        configure({ permissionMode });
                        setOpen(false);
                    }}
                />
                {canSaveProjectDefault && project && (
                    <>
                        <MenuSeparator />
                        <ProjectDefaultItem
                            item={view.projectDefaultItem}
                            onClear={() => setAgentChatProjectDefault(project.id, provider, null)}
                            onSave={() => {
                                if (projectDefault)
                                    setAgentChatProjectDefault(
                                        project.id,
                                        provider,
                                        projectDefault,
                                    );
                            }}
                        />
                        {view.showsClearProjectDefault && (
                            <MenuItem
                                className="h-auto min-h-7 py-1"
                                onClick={() =>
                                    setAgentChatProjectDefault(project.id, provider, null)
                                }
                            >
                                {/* Keeps the text in the check column's line, like the rows above. */}
                                <span aria-hidden className="size-3.5 shrink-0" />
                                <span className="flex min-w-0 flex-col">
                                    <span className="truncate">
                                        {t('agentChat.permission.clearProjectDefault')}
                                    </span>
                                    <span className="truncate text-[11px] leading-4 text-muted">
                                        {t('agentChat.permission.clearProjectDefaultDescription')}
                                    </span>
                                </span>
                            </MenuItem>
                        )}
                    </>
                )}
            </MenuContent>
        </Menu>
    );
}

/**
 * "Use as Project default", a checked "Project default" once the Chat matches the saved default (unchecking it clears
 * that default), or the disabled row with its reason while the level is Custom.
 */
function ProjectDefaultItem({
    item,
    onClear,
    onSave,
}: {
    item: AgentChatProjectDefaultItem;
    onClear: () => void;
    onSave: () => void;
}) {
    return (
        <MenuCheckboxItem
            checked={item.isChecked}
            className="h-auto min-h-7 py-1"
            disabled={item.disabledReason !== undefined}
            onCheckedChange={(isChecked: boolean) => (isChecked ? onSave() : onClear())}
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
 * The level radio group, with a checked Custom row while launch settings decide the level.
 */
function AgentChatPermissionMenuItems({
    isNextTurnOnly,
    permissionMode,
    provider,
    onLevelChange,
}: {
    /**
     * A turn runs and the provider applies a switch only from the next turn.
     */
    isNextTurnOnly: boolean;
    permissionMode: AgentChatPermissionMode | undefined;
    provider: AgentProvider;
    onLevelChange: (permissionMode: AgentChatPermissionMode) => void;
}) {
    const { t } = useTranslation();
    return (
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
                        <SlidersHorizontal className="size-4 shrink-0 text-muted" />
                        <span className="flex min-w-0 flex-col">
                            <span className="truncate">{t('agentChat.permission.customRow')}</span>
                            <span className="truncate text-[11px] leading-4 text-muted">
                                {t('agentChat.permission.customRowDescription')}
                            </span>
                        </span>
                    </MenuRadioItem>
                )}
                {agentChatPermissionModes(provider).map((mode) => {
                    const Icon = LEVEL_ICONS[mode];
                    // Chosen Full access reads in the warning color, as the Codex app tints its row.
                    const isWarning = mode === 'fullAccess' && mode === permissionMode;
                    return (
                        <MenuRadioItem
                            key={mode}
                            className={isWarning ? 'text-warning' : undefined}
                            value={mode}
                        >
                            <Icon
                                className={cn(
                                    'size-4 shrink-0',
                                    mode === 'fullAccess' ? 'text-warning' : 'text-muted',
                                )}
                            />
                            <span className="flex min-w-0 flex-col">
                                <span className="truncate">
                                    {agentChatPermissionModeLabel(mode, provider, t)}
                                </span>
                                <span
                                    className={cn(
                                        'truncate text-[11px] leading-4',
                                        !isWarning && 'text-muted',
                                    )}
                                >
                                    {agentChatPermissionModeDescription(provider, mode, t)}
                                </span>
                            </span>
                        </MenuRadioItem>
                    );
                })}
            </MenuRadioGroup>
        </MenuGroup>
    );
}
