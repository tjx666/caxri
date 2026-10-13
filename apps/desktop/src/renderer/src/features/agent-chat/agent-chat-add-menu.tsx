import { useRef } from 'react';

import type { LucideIcon } from 'lucide-react';
import { Goal, Lightbulb, MessageCircle, Paperclip, Plus } from 'lucide-react';

import { ShortcutBadge } from '../../components/shortcut-badge';
import { Button } from '../../components/ui/button';
import {
    Menu,
    MenuCheckboxItem,
    MenuContent,
    MenuGroup,
    MenuGroupLabel,
    MenuItem,
    MenuTrigger,
} from '../../components/ui/menu';
import { Spinner } from '../../components/ui/spinner';
import { Tooltip } from '../../components/ui/tooltip';
import { useTranslation } from '../../i18n';
import { useCommandShortcut } from '../../lib/keybindings';
import type { SessionReferenceCandidate } from '../session/session-reference';
import { sessionTitleForDisplay } from '../session/session-title';
import { agentChatAttachLabel } from './agent-chat-presentation';

const ROW_CLASS_NAME = 'h-auto min-h-8 gap-2.5 py-1.5 text-[13px]';

/**
 * A row's name over its description in the `meta` size, as the permission menu sets its rows, so a long description
 * gets its own line instead of being cut off beside the name.
 */
function RowText({ description, label }: { description: string; label: string }) {
    return (
        <span className="flex min-w-0 flex-1 flex-col">
            <span className="truncate">{label}</span>
            <span className="truncate text-[11px] leading-4 text-muted">{description}</span>
        </span>
    );
}

/**
 * The composer's leading `+`, after the Codex app's: one menu of what the next message can carry. Under Add, Files and
 * folders opens the native macOS open panel through Main (`onPickPaths`), which takes several files and folders at
 * once: images attach and everything else, folders included, is cited by path. Chromium's file input cannot pick a
 * folder together with files, so it remains only in an SSH Host window, as Files, whose Agent cannot read this Mac's
 * paths anyway but can still take a picked image (each picked `File` carries its bytes, so that pick takes a drop's
 * route); Goal, only while the provider reports a goal command, puts the composer in Goal mode; Plan mode toggles the
 * provider's plan mode. Under Sessions, the most recently opened Sessions with an Agent conversation can be cited the
 * way the `@` list cites them. Every row is a capability this Chat already has; the menu only gathers them.
 */
export function AgentChatAddMenu({
    canAttachImages,
    isBusy,
    onGoal,
    onPick,
    onPickPaths,
    onReferenceSession,
    planMode,
    sessions,
}: {
    /**
     * Whether the provider accepts images (`capabilities.chatImages`), which decides what Files says a pick does.
     */
    canAttachImages: boolean;
    /**
     * Picked images are still being read, a long paste saved, or a Session reference written, so `+` shows progress.
     */
    isBusy: boolean;
    /**
     * Puts the composer in Goal mode; `undefined` when the provider reports no goal command.
     */
    onGoal: (() => void) | undefined;
    onPick: (files: File[]) => void;
    /**
     * Opens the panel for files and folders together, or `undefined` in an SSH Host window, which keeps the file-only
     * picker.
     */
    onPickPaths: (() => void) | undefined;
    onReferenceSession: (candidate: SessionReferenceCandidate) => void;
    /**
     * The provider's plan mode, or `undefined` for a provider without one.
     */
    planMode: { isOn: boolean; onChange: (isOn: boolean) => void } | undefined;
    sessions: readonly SessionReferenceCandidate[];
}) {
    const { t } = useTranslation();
    const inputReference = useRef<HTMLInputElement>(null);
    const planModeShortcut = useCommandShortcut('agentChat.togglePlanMode');
    return (
        <>
            <input
                aria-hidden
                className="hidden"
                multiple
                ref={inputReference}
                tabIndex={-1}
                type="file"
                onChange={(event) => {
                    onPick([...(event.target.files ?? [])]);
                    // Picking the same file again must fire `change` again.
                    event.target.value = '';
                }}
            />
            <Menu>
                <Tooltip content={t('agentChat.add.tooltip')}>
                    <MenuTrigger
                        aria-label={t('agentChat.add.tooltip')}
                        className="flex size-7 shrink-0 cursor-pointer items-center justify-center rounded-full border-0 bg-transparent text-muted transition-colors hover:bg-elevated hover:text-foreground focus-visible:outline focus-visible:outline-accent data-popup-open:bg-elevated data-popup-open:text-foreground"
                    >
                        {isBusy ? <Spinner className="size-3.5" /> : <Plus className="size-4" />}
                    </MenuTrigger>
                </Tooltip>
                <MenuContent align="start" className="w-80 p-1.5" side="top" sideOffset={6}>
                    <MenuGroup>
                        <MenuGroupLabel>{t('agentChat.add.add')}</MenuGroupLabel>
                        <MenuItem
                            className={ROW_CLASS_NAME}
                            onClick={onPickPaths ?? (() => inputReference.current?.click())}
                        >
                            <Paperclip className="size-4 shrink-0 text-muted" />
                            <RowText
                                description={agentChatAttachLabel(
                                    canAttachImages,
                                    Boolean(onPickPaths),
                                    t,
                                )}
                                label={t(
                                    onPickPaths
                                        ? 'agentChat.add.filesAndFolders'
                                        : 'agentChat.add.files',
                                )}
                            />
                        </MenuItem>
                        {onGoal && (
                            <MenuItem className={ROW_CLASS_NAME} onClick={onGoal}>
                                <Goal className="size-4 shrink-0 text-muted" />
                                <RowText
                                    description={t('agentChat.add.goalDescription')}
                                    label={t('agentChat.add.goal')}
                                />
                            </MenuItem>
                        )}
                        {planMode && (
                            <MenuCheckboxItem
                                checked={planMode.isOn}
                                className={ROW_CLASS_NAME}
                                closeOnClick
                                onCheckedChange={planMode.onChange}
                            >
                                <Lightbulb className="size-4 shrink-0 text-muted" />
                                <RowText
                                    description={t('agentChat.permission.planModeDescription')}
                                    label={t('agentChat.permission.planMode')}
                                />
                                {planModeShortcut && (
                                    <ShortcutBadge compact shortcut={planModeShortcut} />
                                )}
                            </MenuCheckboxItem>
                        )}
                    </MenuGroup>
                    {sessions.length > 0 && (
                        <MenuGroup>
                            <MenuGroupLabel className="pt-2">
                                {t('agentChat.slash.sessions')}
                            </MenuGroupLabel>
                            {sessions.map((candidate) => (
                                <MenuItem
                                    key={candidate.sessionId}
                                    className={ROW_CLASS_NAME}
                                    onClick={() => onReferenceSession(candidate)}
                                >
                                    <MessageCircle className="size-4 shrink-0 text-muted" />
                                    <span className="min-w-0 shrink truncate">
                                        {sessionTitleForDisplay(candidate.title, t)}
                                    </span>
                                    {candidate.projectTitle && (
                                        <span className="shrink-0 text-muted">
                                            {candidate.projectTitle}
                                        </span>
                                    )}
                                </MenuItem>
                            ))}
                        </MenuGroup>
                    )}
                </MenuContent>
            </Menu>
        </>
    );
}

/**
 * A composer mode while it is on: Plan mode beside `+`, Goal mode after the permission picker, as the Codex app places
 * them. The mode's glyph and word in the foreground color, as Synara and Superset show the mode in the composer's
 * footer, and a press turns it off. It is a pressed toggle named after the mode ("Plan mode"), so a screen reader hears
 * the mode and its state rather than a command, and its tooltip says what a press does, with the mode's shortcut when
 * it has one. It draws the same pressed fill and `--border` outline as the model picker's mode toggles, never
 * `--accent` (DESIGN.md Principle 2), so it reads as a mode that is on rather than as a plain word in the footer.
 */
export function AgentChatModeChip({
    icon: Icon,
    label,
    name,
    shortcut,
    turnOffLabel,
    onTurnOff,
}: {
    icon: LucideIcon;
    label: string;
    /**
     * The accessible name: the mode itself, such as "Plan mode".
     */
    name: string;
    shortcut?: string;
    turnOffLabel: string;
    onTurnOff: () => void;
}) {
    return (
        <Tooltip content={turnOffLabel} shortcut={shortcut}>
            <Button
                aria-label={name}
                aria-pressed
                className="h-7 gap-1 rounded-full border-border bg-[var(--selection)] px-2 text-[12px] text-foreground"
                size="sm"
                variant="ghost"
                onClick={onTurnOff}
            >
                <Icon className="size-3.5" />
                {label}
            </Button>
        </Tooltip>
    );
}
