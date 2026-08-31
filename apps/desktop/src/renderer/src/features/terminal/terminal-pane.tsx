import { useCallback, useEffect, useMemo, useReducer, useState } from 'react';

import type { ProcessState, TerminalFailureReason } from '@caxri/protocol';
import { agentProviderCatalog } from '@caxri/protocol';
import { CircleCheck, CircleX, MessageSquarePlus, RotateCcw, TriangleAlert } from 'lucide-react';

import { Button } from '../../components/ui/button';
import {
    ContextMenu,
    ContextMenuContent,
    ContextMenuItem,
    ContextMenuSeparator,
    ContextMenuTrigger,
} from '../../components/ui/context-menu';
import { Spinner } from '../../components/ui/spinner';
import { CommandTooltip, Tooltip } from '../../components/ui/tooltip';
import { useCommandShortcut } from '../../lib/keybindings';
import { cn } from '../../lib/utilities';
import { useCaxriQuery } from '../../queries/client';
import { useSelectedSession, useSettings, useTerminal, useTheme } from '../../stores/selectors';
import { useWorkbenchStore } from '../../stores/workbench';
import {
    activateTerminal,
    clearActiveTerminal,
    copyActiveTerminalSelection,
    findInActiveTerminal,
    hasActiveTerminalSelection,
    registerTerminalFocusHandler,
    restartTerminal,
    startNewAgentSession,
} from './terminal-actions';
import { isAgentProcessRunning } from './terminal-agent-runtime';
import { getTerminalExitPresentation } from './terminal-exit-presentation';
import { terminalFontFamily } from './terminal-fonts';
import { openTerminalLinkPicker } from './terminal-link-actions';
import { TerminalLinkPicker } from './terminal-link-picker';
import { TERMINAL_DEFAULT_WORD_SEPARATORS } from './terminal-links';
import type { TerminalSearchOptions } from './terminal-search';
import {
    initialTerminalSearchState,
    registerTerminalSearchHandler,
    terminalSearchReducer,
} from './terminal-search';
import { TerminalSearchBar } from './terminal-search-bar';
import { useTerminalLinkPicker } from './use-terminal-link-picker';
import { useTerminalPaneRuntime } from './use-terminal-pane-runtime';

interface TerminalPaneProperties {
    active: boolean;
    ariaLabel: string;
    terminalId: string;
}

const terminalPaneClassName =
    'terminal-pane relative flex h-full w-full min-h-0 min-w-0 flex-col pt-2 pl-2 bg-background';

const terminalRecoveryToneClassName = {
    danger: 'text-danger',
    neutral: 'text-muted',
} as const;

const terminalRecoveryMessageClassName =
    'terminal-recovery-message inline-flex items-center gap-2 overflow-hidden whitespace-nowrap text-ellipsis';

function TerminalRecoveryBar({
    failureReason,
    processState,
    resumesAgentSession,
    terminalId,
}: {
    failureReason: TerminalFailureReason | undefined;
    processState: ProcessState;
    resumesAgentSession: boolean;
    terminalId: string;
}) {
    /**
     * `terminal.restart` drives both labels below; only the visible word ("Resume" vs "Restart") changes, so the
     * tooltip text is composed locally instead of reusing `CommandTooltip`'s fixed catalog title, which used to show
     * "Restart Terminal" while hovering a button labeled Resume.
     */
    const restartShortcut = useCommandShortcut('terminal.restart');
    const exitPresentation = getTerminalExitPresentation(processState, failureReason);
    if (!exitPresentation) return null;
    const ExitIcon =
        exitPresentation.icon === 'completed'
            ? CircleCheck
            : exitPresentation.icon === 'failed'
              ? TriangleAlert
              : exitPresentation.icon === 'pending'
                ? undefined
                : CircleX;
    /**
     * An automatic restore is already in flight for `interrupted`; racing it with a manual click can hand two restart
     * requests to the same Terminal, so the actions stand down until it settles into a state
     * (`failed`/`dead`/`stopped`) that actually needs a user decision.
     */
    const isAwaitingAutomaticRestore = processState === 'interrupted';
    return (
        <div
            aria-live="polite"
            className={cn(
                `terminal-recovery terminal-recovery-${exitPresentation.tone}`,
                '-ml-2 flex min-w-0 flex-none basis-7 items-center justify-between gap-3 border-t border-border pt-0 pr-1 pb-0 pl-2 text-[11px]',
                'bg-[color-mix(in_srgb,var(--surface)_65%,var(--background))]',
                terminalRecoveryToneClassName[exitPresentation.tone],
            )}
            data-terminal-exit-state={processState}
            role="status"
        >
            <span className={terminalRecoveryMessageClassName} title={exitPresentation.label}>
                {exitPresentation.icon === 'pending' ? (
                    <Spinner size={14} />
                ) : (
                    ExitIcon && <ExitIcon size={14} />
                )}
                {exitPresentation.label}
            </span>
            {!isAwaitingAutomaticRestore && (
                <Tooltip
                    content={resumesAgentSession ? 'Resume Agent Session' : 'Restart Terminal'}
                    shortcut={restartShortcut}
                >
                    <Button
                        aria-label={
                            resumesAgentSession ? 'Resume Agent Session' : 'Restart Terminal'
                        }
                        className="terminal-recovery-action min-h-6 flex-none px-2 text-inherit"
                        size="sm"
                        variant="ghost"
                        onClick={() => restartTerminal(terminalId)}
                    >
                        <RotateCcw size={12} /> {resumesAgentSession ? 'Resume' : 'Restart'}
                    </Button>
                </Tooltip>
            )}
            {!isAwaitingAutomaticRestore && resumesAgentSession && (
                <CommandTooltip commandId="terminal.startNewAgentSession">
                    <Button
                        aria-label="Start New Agent Session"
                        className="terminal-recovery-action min-h-6 flex-none px-2 text-inherit"
                        size="sm"
                        variant="ghost"
                        onClick={() => startNewAgentSession(terminalId)}
                    >
                        <MessageSquarePlus size={12} /> New session
                    </Button>
                </CommandTooltip>
            )}
        </div>
    );
}

/**
 * Presents one Terminal while the runtime hook owns its imperative xterm lifecycle. Inputs are selected from stores
 * here so a snapshot refresh does not rerender every pane in a split layout.
 */
export function TerminalPane({ active, ariaLabel, terminalId }: TerminalPaneProperties) {
    const terminal = useTerminal(terminalId);
    const session = useSelectedSession();
    const theme = useTheme();
    const settings = useSettings();
    const attachEpoch = useWorkbenchStore((state) => state.attachEpoch);
    const fontFamily = terminalFontFamily(settings?.['terminal.fontFamily']);
    const fontSize = settings?.['terminal.fontSize'] ?? 13;
    const scrollback = settings?.['terminal.scrollback'] ?? 1_000;
    const isCopyOnSelect = settings?.['terminal.copyOnSelect'] ?? true;
    const gpuAcceleration = settings?.['terminal.gpuAcceleration'] ?? 'off';
    const isOsc52ClipboardWrite = settings?.['terminal.osc52ClipboardWrite'] ?? false;
    const wordSeparators =
        settings?.['terminal.wordSeparators'] ?? TERMINAL_DEFAULT_WORD_SEPARATORS;
    const referenceLinks = settings?.['terminal.referenceLinks'] ?? [];
    const referenceContext = useCaxriQuery(
        'terminal.referenceContext',
        { terminalId },
        { enabled: Boolean(terminal), staleTime: 30_000 },
    ).data;
    const processState = terminal?.lastProcessState ?? 'starting';
    const provider =
        terminal?.provider ?? (terminal?.kind === 'shell' ? undefined : terminal?.kind);
    const imagePasteInput = provider
        ? agentProviderCatalog[provider].imageInput?.terminalInput
        : undefined;
    const longPasteEnabled = provider
        ? (settings?.['agents.providers'][provider].pasteSummary.enabled ?? true)
        : false;
    const longPasteThreshold = settings?.['terminal.longPasteThreshold'] ?? 1_024;
    const canAcceptAgentInput = isAgentProcessRunning(terminal?.lastAgentProcessState);
    const terminalTheme = theme?.terminal;

    const [searchState, dispatchSearch] = useReducer(
        terminalSearchReducer,
        initialTerminalSearchState,
    );
    const {
        beginSearch,
        containerRef,
        endSearch,
        find,
        focusTerminal,
        longPastePending,
        pasteFromClipboard,
        searchResults,
    } = useTerminalPaneRuntime({
        canAcceptAgentInput,
        active,
        attachEpoch,
        copyOnSelect: isCopyOnSelect,
        dangerColor: theme?.colors.danger,
        fontFamily,
        fontSize,
        gpuAcceleration,
        githubRepositories: referenceContext?.githubRepositories ?? [],
        imagePasteInput,
        longPasteEnabled,
        longPasteThreshold,
        osc52ClipboardWrite: isOsc52ClipboardWrite,
        processState,
        projectRoot: session?.rootPath ?? '',
        referenceLinks,
        scrollback,
        successColor: theme?.colors.success,
        terminalCwd: terminal?.cwd ?? '',
        terminalId,
        terminalTheme,
        wordSeparators,
    });
    const linkPicker = useTerminalLinkPicker(terminalId, focusTerminal);
    const openDetectedLinkShortcut = useCommandShortcut('terminal.openDetectedLink');

    useEffect(
        () => registerTerminalFocusHandler(terminalId, focusTerminal),
        [focusTerminal, terminalId],
    );

    useEffect(
        () =>
            registerTerminalSearchHandler(terminalId, () => {
                beginSearch();
                dispatchSearch({ type: 'open' });
            }),
        [beginSearch, terminalId],
    );

    useEffect(() => {
        dispatchSearch({ type: 'reset' });
        return endSearch;
    }, [endSearch, terminalId]);

    useEffect(() => {
        if (active) return;
        endSearch();
        dispatchSearch({ type: 'close' });
    }, [active, endSearch]);

    const searchOptions: TerminalSearchOptions = useMemo(
        () => ({
            caseSensitive: searchState.caseSensitive,
            regex: searchState.regex,
            wholeWord: searchState.wholeWord,
        }),
        [searchState.caseSensitive, searchState.regex, searchState.wholeWord],
    );

    useEffect(() => {
        if (!searchState.open) return;
        find('next', searchState.query, searchOptions, true);
    }, [find, searchOptions, searchState.open, searchState.query, terminalTheme]);

    const closeSearch = useCallback((): void => {
        endSearch();
        dispatchSearch({ type: 'close' });
        requestAnimationFrame(focusTerminal);
    }, [endSearch, focusTerminal]);

    const isResumesAgentSession = Boolean(terminal?.provider && terminal.agentSessionId);
    const isRunning = processState === 'running';
    /**
     * Recomputed only when the menu opens rather than tracked continuously: xterm selection changes do not otherwise
     * trigger a `TerminalPane` rerender, so reading `hasActiveTerminalSelection` straight in JSX would show whatever
     * was true the last time some other prop changed.
     */
    const [contextMenuHasSelection, setContextMenuHasSelection] = useState(false);

    return (
        <div
            role="region"
            aria-label={ariaLabel}
            className={terminalPaneClassName}
            data-terminal-id={terminalId}
            onFocus={() => activateTerminal(terminalId)}
            style={{ backgroundColor: terminalTheme?.background ?? 'var(--background)' }}
        >
            <ContextMenu
                onOpenChange={(open) => {
                    if (open) setContextMenuHasSelection(hasActiveTerminalSelection(terminalId));
                }}
            >
                <ContextMenuTrigger
                    render={
                        <div
                            ref={containerRef}
                            className="terminal-surface min-h-0 w-full flex-1"
                        />
                    }
                />
                <ContextMenuContent>
                    <ContextMenuItem
                        disabled={!contextMenuHasSelection}
                        title={
                            contextMenuHasSelection
                                ? undefined
                                : 'Select text in the Terminal to copy it'
                        }
                        onClick={() => copyActiveTerminalSelection(terminalId)}
                    >
                        Copy
                    </ContextMenuItem>
                    <ContextMenuItem
                        disabled={!isRunning}
                        title={isRunning ? undefined : 'Terminal is not running'}
                        onClick={() => pasteFromClipboard()}
                    >
                        Paste
                    </ContextMenuItem>
                    <ContextMenuSeparator />
                    <ContextMenuItem onClick={() => clearActiveTerminal(terminalId)}>
                        Clear
                    </ContextMenuItem>
                    <ContextMenuItem onClick={() => findInActiveTerminal(terminalId)}>
                        Find in Terminal
                    </ContextMenuItem>
                    <ContextMenuItem
                        hint={openDetectedLinkShortcut}
                        onClick={() => openTerminalLinkPicker(terminalId)}
                    >
                        Open Detected Link…
                    </ContextMenuItem>
                </ContextMenuContent>
            </ContextMenu>
            {searchState.open && (
                <TerminalSearchBar
                    caseSensitive={searchState.caseSensitive}
                    focusRevision={searchState.focusRevision}
                    query={searchState.query}
                    regex={searchState.regex}
                    results={searchResults}
                    wholeWord={searchState.wholeWord}
                    onClose={closeSearch}
                    onNavigate={(direction) =>
                        find(direction, searchState.query, searchOptions, false)
                    }
                    onQueryChange={(query) => dispatchSearch({ type: 'query', query })}
                    onToggle={(option) => dispatchSearch({ type: 'toggle', option })}
                />
            )}
            <TerminalLinkPicker
                isOpen={linkPicker.isOpen}
                links={linkPicker.links}
                mode={linkPicker.mode}
                status={linkPicker.status}
                isTruncated={linkPicker.isTruncated}
                onOpenChange={linkPicker.onOpenChange}
                onSelect={linkPicker.selectLink}
            />
            {longPastePending && (
                <div
                    aria-live="polite"
                    className="-ml-2 flex min-h-7 flex-none items-center gap-2 border-t border-border bg-surface px-2 text-[11px] text-muted"
                    role="status"
                >
                    <Spinner size={14} /> Summarizing pasted text…
                </div>
            )}
            <TerminalRecoveryBar
                failureReason={terminal?.failureReason}
                processState={processState}
                resumesAgentSession={isResumesAgentSession}
                terminalId={terminalId}
            />
        </div>
    );
}
