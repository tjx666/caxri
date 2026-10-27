import { botAgentSchema } from '@caxri/protocol';

import { ShortcutBadge } from '../../components/shortcut-badge';
import {
    Command,
    CommandEmpty,
    CommandGroup,
    CommandInput,
    CommandItem,
    CommandList,
} from '../../components/ui/command';
import { Dialog, DialogTitle, PickerDialogContent } from '../../components/ui/dialog';
import { useTranslation } from '../../i18n';
import { useCommandShortcut } from '../../lib/keybindings';
import { useCaxriQuery } from '../../queries/client';
import { useTerminal } from '../../stores/selectors';
import { sessionTitleForDisplay } from '../session/session-title';
import { canRestartResumeAgent } from '../terminal/agent-restart-commands';
import { useBotBoardUiStore } from './bot-board-store';
import { useCaxriBotStore } from './bot-client';
import { revealBotSession } from './bot-commands';
import { setBotPaletteOpen, useBotDialogsStore } from './bot-dialogs-store';
import { useBotInboxUiStore } from './bot-inbox-store';
import type { BotPaletteCommand } from './bot-palette';
import { botPaletteCommands, botPaletteGroups, runBotPaletteAction } from './bot-palette';

const metaClassName = 'inline-flex flex-none items-center gap-2 text-[11px] text-muted';

/**
 * The Caxri Bot window's own Command Palette (`Cmd+Shift+P`), on the Workbench palette's picker shell and row layout:
 * the title bar keeps the controls used all the time, and everything else is a search away. Base UI renders nothing
 * while it is closed, so the body's reads run only while it is open.
 */
export function BotCommandPalette() {
    const isOpen = useBotDialogsStore((state) => state.isPaletteOpen);
    return (
        <Dialog open={isOpen} onOpenChange={setBotPaletteOpen}>
            <PickerDialogContent>
                <BotPaletteBody />
            </PickerDialogContent>
        </Dialog>
    );
}

function BotPaletteBody() {
    const { t } = useTranslation();
    const terminalId = useCaxriBotStore((state) => state.identity?.terminalId);
    const terminal = useTerminal(terminalId ?? '');
    const agent = botAgentSchema.safeParse(terminal?.provider).data;
    const boardScope = useBotBoardUiStore((state) => state.scope);
    const isBoardVisible = useBotBoardUiStore((state) => state.isVisible);
    const isInboxVisible = useBotInboxUiStore((state) => state.isVisible);
    const board = useCaxriQuery('bot.board', undefined).data;
    const commands = botPaletteCommands(
        {
            agent,
            boardScope,
            isBoardVisible,
            isInboxVisible,
            canRestartAgent: canRestartResumeAgent(terminal),
            terminalId,
        },
        t,
    );
    return (
        <>
            <DialogTitle className="sr-only">{t('palette.title')}</DialogTitle>
            <Command label={t('palette.title')} className="bot-palette w-full">
                <CommandInput autoFocus placeholder={t('caxriBot.palette.placeholder')} />
                <CommandList>
                    <CommandEmpty>{t('caxriBot.palette.empty')}</CommandEmpty>
                    {botPaletteGroups.map((group) => (
                        <CommandGroup key={group} heading={t(`caxriBot.palette.group.${group}`)}>
                            {commands
                                .filter((command) => command.group === group)
                                .map((command) => (
                                    <BotPaletteRow
                                        key={command.id}
                                        command={command}
                                        onSelect={() => runBotPaletteAction(command.action, agent)}
                                    />
                                ))}
                        </CommandGroup>
                    ))}
                    {board && board.rows.length > 0 && (
                        <CommandGroup heading={t('palette.group.sessions')}>
                            {board.rows.map((row) => {
                                const title = sessionTitleForDisplay(row.sessionTitle, t);
                                return (
                                    <CommandItem
                                        key={row.sessionId}
                                        // The id keeps two same-named Sessions apart; `cmdk` tracks rows by value.
                                        value={`Session ${title} ${row.projectTitle} ${row.sessionId}`}
                                        onSelect={() => {
                                            setBotPaletteOpen(false);
                                            revealBotSession(row.sessionId);
                                        }}
                                    >
                                        <span className="min-w-0 truncate">{title}</span>
                                        <small className={metaClassName}>{row.projectTitle}</small>
                                    </CommandItem>
                                );
                            })}
                        </CommandGroup>
                    )}
                </CommandList>
            </Command>
        </>
    );
}

function BotPaletteRow({
    command,
    onSelect,
}: {
    command: BotPaletteCommand;
    onSelect: () => void;
}) {
    const shortcut = useCommandShortcut(command.shortcut);
    return (
        <CommandItem
            value={`${command.title} ${command.keywords} ${command.id}`}
            onSelect={onSelect}
        >
            <span className="min-w-0 truncate">{command.title}</span>
            {shortcut && (
                <small className={metaClassName}>
                    <ShortcutBadge
                        compact
                        keyClassName="group-data-[selected=true]:bg-[var(--selection)]"
                        shortcut={shortcut}
                    />
                </small>
            )}
        </CommandItem>
    );
}
