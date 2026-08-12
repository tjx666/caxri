import { CircleCheck, CircleX, MessageSquarePlus, RotateCcw, TriangleAlert } from 'lucide-react';
import { useCallback, useEffect, useMemo, useReducer } from 'react';

import type { ProcessState, TerminalFailureReason } from '@shared/types';

import { Button } from '../../components/ui/button';
import { CommandTooltip } from '../../components/ui/tooltip';
import { cn } from '../../lib/utils';
import { useSelectedSession, useSettings, useTerminal, useTheme } from '../../stores/selectors';
import { useWorkbenchStore } from '../../stores/workbench';
import { activateTerminal, restartTerminal, startNewAgentSession } from './terminal-actions';
import { getTerminalExitPresentation } from './terminal-exit-presentation';
import { TerminalSearchBar } from './TerminalSearchBar';
import {
    initialTerminalSearchState,
    registerTerminalSearchHandler,
    terminalSearchReducer,
    type TerminalSearchOptions,
} from './terminal-search';
import { useTerminalPaneRuntime } from './use-terminal-pane';

interface TerminalPaneProps {
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
    const exitPresentation = getTerminalExitPresentation(processState, failureReason);
    if (!exitPresentation) return null;
    const ExitIcon =
        exitPresentation.icon === 'completed'
            ? CircleCheck
            : exitPresentation.icon === 'failed'
              ? TriangleAlert
              : CircleX;
    return (
        <div
            aria-live="polite"
            className={cn(
                `terminal-recovery terminal-recovery-${exitPresentation.tone}`,
                'flex min-w-0 flex-none basis-7 items-center justify-between gap-3 -ml-2 pt-0 pr-1 pb-0 pl-2 border-t border-border text-[11px]',
                'bg-[color-mix(in_srgb,var(--surface)_65%,var(--background))]',
                terminalRecoveryToneClassName[exitPresentation.tone],
            )}
            data-terminal-exit-state={processState}
            role="status"
        >
            <span className={terminalRecoveryMessageClassName}>
                <ExitIcon size={14} />
                {exitPresentation.label}
            </span>
            <CommandTooltip commandId="terminal.restart">
                <Button
                    aria-label={resumesAgentSession ? 'Resume Agent Session' : 'Restart Terminal'}
                    className="terminal-recovery-action flex-none min-h-6 px-2 text-inherit"
                    size="sm"
                    variant="ghost"
                    onClick={() => restartTerminal(terminalId)}
                >
                    <RotateCcw size={12} /> {resumesAgentSession ? 'Resume' : 'Restart'}
                </Button>
            </CommandTooltip>
            {resumesAgentSession && (
                <CommandTooltip commandId="terminal.startNewAgentSession">
                    <Button
                        aria-label="Start New Agent Session"
                        className="terminal-recovery-action flex-none min-h-6 px-2 text-inherit"
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
 * Presents one Terminal while the runtime hook owns its imperative xterm lifecycle. Inputs are
 * selected from stores here so a snapshot refresh does not rerender every pane in a split layout.
 */
export function TerminalPane({ active, ariaLabel, terminalId }: TerminalPaneProps) {
    const terminal = useTerminal(terminalId);
    const session = useSelectedSession();
    const theme = useTheme();
    const settings = useSettings();
    const attachEpoch = useWorkbenchStore((state) => state.attachEpoch);
    const fontSize = settings?.['terminal.fontSize'] ?? 13;
    const scrollback = settings?.['terminal.scrollback'] ?? 1_000;
    const copyOnSelect = settings?.['terminal.copyOnSelect'] ?? true;
    const gpuAcceleration = settings?.['terminal.gpuAcceleration'] ?? 'off';
    const osc52ClipboardWrite = settings?.['terminal.osc52ClipboardWrite'] ?? false;
    const processState = terminal?.lastProcessState ?? 'starting';
    const isCodex = terminal?.kind === 'codex' || terminal?.provider === 'codex';
    const terminalTheme = theme?.terminal;

    const [searchState, dispatchSearch] = useReducer(
        terminalSearchReducer,
        initialTerminalSearchState,
    );
    const { beginSearch, containerRef, endSearch, find, focusTerminal, searchResults } =
        useTerminalPaneRuntime({
            active,
            attachEpoch,
            copyOnSelect,
            fontSize,
            gpuAcceleration,
            isCodex,
            osc52ClipboardWrite,
            processState,
            projectRoot: session?.rootPath ?? '',
            scrollback,
            terminalCwd: terminal?.cwd ?? '',
            terminalId,
            terminalSessionId: terminal?.sessionId ?? '',
            terminalTheme,
        });

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
        window.requestAnimationFrame(focusTerminal);
    }, [endSearch, focusTerminal]);

    const resumesAgentSession = Boolean(terminal?.provider && terminal.agentSessionId);

    return (
        <div
            role="region"
            aria-label={ariaLabel}
            className={terminalPaneClassName}
            data-terminal-id={terminalId}
            onFocus={() => activateTerminal(terminalId)}
            style={{ backgroundColor: terminalTheme?.background ?? 'var(--background)' }}
        >
            <div ref={containerRef} className="terminal-surface min-h-0 w-full flex-1" />
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
            <TerminalRecoveryBar
                failureReason={terminal?.failureReason}
                processState={processState}
                resumesAgentSession={resumesAgentSession}
                terminalId={terminalId}
            />
        </div>
    );
}
