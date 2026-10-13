import { commanderAgentSchema } from '@caxri/protocol';

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
import { useCommanderBoardUiStore } from './commander-board-store';
import { useAgentCommanderStore } from './commander-client';
import { revealCommanderSession } from './commander-commands';
import { setCommanderPaletteOpen, useCommanderDialogsStore } from './commander-dialogs-store';
import { useCommanderInboxUiStore } from './commander-inbox-store';
import type { CommanderPaletteCommand } from './commander-palette';
import {
    commanderPaletteCommands,
    commanderPaletteGroups,
    runCommanderPaletteAction,
} from './commander-palette';

const metaClassName = 'inline-flex flex-none items-center gap-2 text-[11px] text-muted';

/**
 * The Agent Commander window's own Command Palette (`Cmd+Shift+P`), on the Workbench palette's picker shell and row
 * layout: the title bar keeps the controls used all the time, and everything else is a search away. Base UI renders
 * nothing while it is closed, so the body's reads run only while it is open.
 */
export function CommanderCommandPalette() {
    const isOpen = useCommanderDialogsStore((state) => state.isPaletteOpen);
    return (
        <Dialog open={isOpen} onOpenChange={setCommanderPaletteOpen}>
            <PickerDialogContent>
                <CommanderPaletteBody />
            </PickerDialogContent>
        </Dialog>
    );
}

function CommanderPaletteBody() {
    const { t } = useTranslation();
    const terminalId = useAgentCommanderStore((state) => state.identity?.terminalId);
    const terminal = useTerminal(terminalId ?? '');
    const agent = commanderAgentSchema.safeParse(terminal?.provider).data;
    const boardScope = useCommanderBoardUiStore((state) => state.scope);
    const isBoardVisible = useCommanderBoardUiStore((state) => state.isVisible);
    const isInboxVisible = useCommanderInboxUiStore((state) => state.isVisible);
    const board = useCaxriQuery('commander.board', undefined).data;
    const commands = commanderPaletteCommands(
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
            <Command label={t('palette.title')} className="commander-palette w-full">
                <CommandInput autoFocus placeholder={t('agentCommander.palette.placeholder')} />
                <CommandList>
                    <CommandEmpty>{t('agentCommander.palette.empty')}</CommandEmpty>
                    {commanderPaletteGroups.map((group) => (
                        <CommandGroup
                            key={group}
                            heading={t(`agentCommander.palette.group.${group}`)}
                        >
                            {commands
                                .filter((command) => command.group === group)
                                .map((command) => (
                                    <CommanderPaletteRow
                                        key={command.id}
                                        command={command}
                                        onSelect={() =>
                                            runCommanderPaletteAction(command.action, agent)
                                        }
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
                                            setCommanderPaletteOpen(false);
                                            revealCommanderSession(row.sessionId);
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

function CommanderPaletteRow({
    command,
    onSelect,
}: {
    command: CommanderPaletteCommand;
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
