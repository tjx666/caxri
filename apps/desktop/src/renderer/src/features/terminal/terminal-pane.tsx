import { useCallback, useEffect, useMemo, useReducer, useState } from 'react';

import type { ProcessState, TerminalFailureReason } from '@caxri/protocol';
import { agentProviderCatalog, defaultAppSettings } from '@caxri/protocol';
import {
    CircleCheck,
    CircleX,
    MessageSquarePlus,
    RotateCcw,
    Settings2,
    Smartphone,
    TriangleAlert,
    Unplug,
} from 'lucide-react';

import { CommandTooltip } from '../../components/command-tooltip';
import { Button } from '../../components/ui/button';
import {
    ContextMenu,
    ContextMenuContent,
    ContextMenuItem,
    ContextMenuSeparator,
    ContextMenuTrigger,
} from '../../components/ui/context-menu';
import { Spinner } from '../../components/ui/spinner';
import { Tooltip } from '../../components/ui/tooltip';
import { useCommandShortcut } from '../../lib/keybindings';
import { isAgentProcessRunning } from '../../lib/terminal-agent-runtime';
import { cn } from '../../lib/utilities';
import { useCaxriQuery } from '../../queries/client';
import { openSettings } from '../../stores/dialogs';
import { useSessionById, useSettings, useTerminal, useTheme } from '../../stores/selectors';
import { useWorkbenchStore } from '../../stores/workbench';
import { useTerminalLinkPicker } from './hooks/use-terminal-link-picker';
import { useTerminalPaneRuntime } from './hooks/use-terminal-pane-runtime';
import {
    activateTerminal,
    clearActiveTerminal,
    copyActiveTerminalSelection,
    findInActiveTerminal,
    hasActiveTerminalSelection,
    registerTerminalFocusHandler,
    restartTerminal,
    startNewAgentSession,
} from './terminal-commands';
import { getTerminalExitPresentation } from './terminal-exit-presentation';
import { terminalFontFamily } from './terminal-fonts';
import { openTerminalLinkPicker } from './terminal-link-actions';
import { TerminalLinkPicker } from './terminal-link-picker';
import type { TerminalSearchOptions } from './terminal-search';
import {
    initialTerminalSearchState,
    registerTerminalSearchHandler,
    terminalSearchReducer,
} from './terminal-search';
import { TerminalSearchBar } from './terminal-search-bar';

interface TerminalPaneProperties {
    active: boolean;
    ariaLabel: string;
    /**
     * Whether the Workbench holding this pane is the one on screen. False for a Session kept alive in the background,
     * whose Terminals stay mounted but give up their GPU context.
     */
    isPaneVisible: boolean;
    terminalId: string;
}

/**
 * No horizontal padding on purpose. `.xterm` already reserves a 20px left gutter for shell-integration command
 * decorations (see `styles.css`), and a pane padding stacked on top of it pushed the first glyph 28px from the pane
 * edge — visibly further in than the right side, at every window width. The gutter is the terminal's left inset; the
 * pane adds none of its own. The right inset stays where it is: `terminalSizeWithScrollbarGutter` reserves the final
 * text column so the last glyph keeps clear of the overlaid scrollbar, which `e2e/terminal-layout.e2e.ts` asserts.
 */
const terminalPaneClassName =
    'terminal-pane relative flex h-full w-full min-h-0 min-w-0 flex-col pt-2 bg-background';

const terminalRecoveryToneClassName = {
    danger: 'text-danger',
    neutral: 'text-muted',
} as const;

const terminalRecoveryMessageClassName =
    'terminal-recovery-message inline-flex items-center gap-2 overflow-hidden whitespace-nowrap text-ellipsis';

function TerminalRecoveryActions({
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
     * `terminal.restart` owns the shortcut; the tooltip title follows the visible Resume or Restart action.
     */
    const restartShortcut = useCommandShortcut('terminal.restart');
    // Automatic restore owns the Terminal until it settles into a state requiring user action.
    if (processState === 'interrupted' || processState === 'suspended') return null;
    const isNeedsSettings = processState === 'failed' && failureReason === 'executable_not_found';
    const restartDescription =
        !isNeedsSettings && resumesAgentSession ? 'Resume Agent Session' : 'Restart Terminal';
    return (
        <>
            {isNeedsSettings && (
                <CommandTooltip commandId="settings.open">
                    <Button
                        aria-label="Open Settings"
                        className="terminal-recovery-action min-h-6 flex-none px-2 text-inherit"
                        size="sm"
                        variant="ghost"
                        onClick={() => openSettings()}
                    >
                        <Settings2 size={12} /> Open Settings
                    </Button>
                </CommandTooltip>
            )}
            <Tooltip content={restartDescription} shortcut={restartShortcut}>
                <Button
                    aria-label={restartDescription}
                    className="terminal-recovery-action min-h-6 flex-none px-2 text-inherit"
                    size="sm"
                    variant="ghost"
                    onClick={() => restartTerminal(terminalId)}
                >
                    <RotateCcw size={12} />{' '}
                    {!isNeedsSettings && resumesAgentSession ? 'Resume' : 'Restart'}
                </Button>
            </Tooltip>
            {resumesAgentSession && !isNeedsSettings && (
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
        </>
    );
}

function TerminalRecoveryBar({
    failureDetail,
    failureReason,
    processState,
    resumesAgentSession,
    terminalId,
}: {
    failureDetail: string | undefined;
    failureReason: TerminalFailureReason | undefined;
    processState: ProcessState;
    resumesAgentSession: boolean;
    terminalId: string;
}) {
    const exitPresentation = getTerminalExitPresentation(
        processState,
        failureReason,
        failureDetail,
    );
    if (!exitPresentation) return null;
    const ExitIcon =
        exitPresentation.icon === 'completed'
            ? CircleCheck
            : exitPresentation.icon === 'failed'
              ? TriangleAlert
              : exitPresentation.icon === 'detached'
                ? Unplug
                : exitPresentation.icon === 'pending'
                  ? undefined
                  : CircleX;
    return (
        <div
            aria-live="polite"
            className={cn(
                `terminal-recovery terminal-recovery-${exitPresentation.tone}`,
                'flex min-w-0 flex-none basis-7 items-center justify-between gap-3 border-t border-border pt-0 pr-1 pb-0 pl-2 text-[11px]',
                'bg-[color-mix(in_srgb,var(--surface)_65%,var(--background))]',
                terminalRecoveryToneClassName[exitPresentation.tone],
            )}
            data-terminal-exit-state={processState}
            role="status"
        >
            <Tooltip content={exitPresentation.label}>
                <span className={terminalRecoveryMessageClassName}>
                    {exitPresentation.icon === 'pending' ? (
                        <Spinner size={14} />
                    ) : (
                        ExitIcon && <ExitIcon size={14} />
                    )}
                    {exitPresentation.label}
                </span>
            </Tooltip>
            <TerminalRecoveryActions
                failureReason={failureReason}
                processState={processState}
                resumesAgentSession={resumesAgentSession}
                terminalId={terminalId}
            />
        </div>
    );
}

/**
 * Presents one Terminal while the runtime hook owns its imperative xterm lifecycle. Inputs are selected from stores
 * here so a snapshot refresh does not rerender every pane in a split layout.
 */
export function TerminalPane({
    active,
    ariaLabel,
    isPaneVisible,
    terminalId,
}: TerminalPaneProperties) {
    const terminal = useTerminal(terminalId);
    // The Terminal's own Session, not the selected one: a kept-alive Workbench renders Terminals that belong to a
    // Session the user has switched away from, and they must keep resolving paths against their own Project root.
    const session = useSessionById(terminal?.sessionId);
    const theme = useTheme();
    const settings = useSettings() ?? defaultAppSettings;
    const attachEpoch = useWorkbenchStore((state) => state.attachEpoch);
    const fontFamily = terminalFontFamily(settings['terminal.fontFamily']);
    const fontSize = settings['terminal.fontSize'];
    const scrollback = settings['terminal.scrollback'];
    const isCopyOnSelect = settings['terminal.copyOnSelect'];
    const gpuAcceleration = settings['terminal.gpuAcceleration'];
    const isOsc52ClipboardWrite = settings['terminal.osc52ClipboardWrite'];
    const wordSeparators = settings['terminal.wordSeparators'];
    const referenceLinks = settings['terminal.referenceLinks'];
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
    const longPasteThreshold = settings['terminal.longPasteThreshold'];
    const canAcceptAgentInput = isAgentProcessRunning(terminal?.lastAgentProcessState);
    const terminalTheme = theme?.terminal;

    const [searchState, dispatchSearch] = useReducer(
        terminalSearchReducer,
        initialTerminalSearchState,
    );
    const {
        containerRef,
        endSearch,
        find,
        focusTerminal,
        getFocusElement,
        longPastePending,
        mobileSizeOwnership,
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
        isPaneVisible,
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
        () => registerTerminalFocusHandler(terminalId, focusTerminal, getFocusElement),
        [focusTerminal, getFocusElement, terminalId],
    );

    useEffect(
        () => registerTerminalSearchHandler(terminalId, () => dispatchSearch({ type: 'open' })),
        [terminalId],
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
            // The pane's own padding around the xterm grid is not focusable, so a click that lands a few pixels off
            // the grid would silently drop focus to `document.body` while the Terminal still looks active. Keep the
            // click from moving focus and hand it to the Terminal instead, as clicking the grid itself would.
            onMouseDown={(event) => {
                if (event.target !== event.currentTarget) return;
                event.preventDefault();
                focusTerminal();
            }}
            style={{ backgroundColor: terminalTheme?.background ?? 'var(--background)' }}
        >
            {mobileSizeOwnership && (
                <div
                    aria-live="polite"
                    className="flex min-h-7 flex-none items-center gap-2 border-b border-border bg-surface px-2 text-[11px] text-muted"
                    role="status"
                >
                    <Smartphone aria-hidden="true" size={12} />
                    <span>Phone controls Terminal size</span>
                    <span className="ml-auto font-mono tabular-nums">
                        {mobileSizeOwnership.cols} × {mobileSizeOwnership.rows}
                    </span>
                </div>
            )}
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
                    <Tooltip
                        content="Select text in the Terminal to copy it"
                        disabled={contextMenuHasSelection}
                    >
                        <span className="block">
                            <ContextMenuItem
                                disabled={!contextMenuHasSelection}
                                onClick={() => copyActiveTerminalSelection(terminalId)}
                            >
                                Copy
                            </ContextMenuItem>
                        </span>
                    </Tooltip>
                    <Tooltip content="Terminal is not running" disabled={isRunning}>
                        <span className="block">
                            <ContextMenuItem
                                disabled={!isRunning}
                                onClick={() => pasteFromClipboard()}
                            >
                                Paste
                            </ContextMenuItem>
                        </span>
                    </Tooltip>
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
                    className="flex min-h-7 flex-none items-center gap-2 border-t border-border bg-surface px-2 text-[11px] text-muted"
                    role="status"
                >
                    <Spinner size={14} /> Saving pasted text…
                </div>
            )}
            <TerminalRecoveryBar
                failureDetail={terminal?.failureDetail}
                failureReason={terminal?.failureReason}
                processState={processState}
                resumesAgentSession={isResumesAgentSession}
                terminalId={terminalId}
            />
        </div>
    );
}
