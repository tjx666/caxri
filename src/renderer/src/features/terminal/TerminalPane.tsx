import { FitAddon } from '@xterm/addon-fit';
import { SearchAddon } from '@xterm/addon-search';
import { Terminal } from '@xterm/xterm';
import { CircleCheck, CircleX, MessageSquarePlus, RotateCcw, TriangleAlert } from 'lucide-react';
import { useEffect, useRef, useState } from 'react';

import { editorModelPath } from '@shared/editor-state';
import { errorMessage } from '@shared/ipc';
import type { ProcessState } from '@shared/types';

import { Button } from '../../components/ui/button';
import { CommandTooltip } from '../../components/ui/tooltip';
import { caxri } from '../../lib/caxri';
import { cn } from '../../lib/utils';
import { useSelectedSession, useSettings, useTerminal, useTheme } from '../../stores/selectors';
import { pushToast } from '../../stores/toasts';
import { useWorkbenchStore } from '../../stores/workbench';
import { openFile } from '../editor/document-actions';
import { revealEditorLocation } from '../editor/editor-reveal';
import {
    activateTerminal,
    registerTerminalClearHandler,
    restartTerminal,
    startNewAgentSession,
} from './terminal-actions';
import { getTerminalExitPresentation } from './terminal-exit-presentation';
import { loadTerminalFonts, TERMINAL_FONT_FAMILY } from './terminal-fonts';
import {
    CODEX_IMAGE_PASTE_INPUT,
    clipboardContainsImage,
    terminalKeyboardInput,
} from './terminal-keyboard';
import { TerminalReplayBuffer } from './terminal-replay';
import { TerminalSelectionClipboard } from './terminal-selection-clipboard';
import { registerTerminalLinks } from './terminal-links';
import {
    terminalSizeChanged,
    terminalSizeWithScrollbarGutter,
    type TerminalSize,
} from './terminal-size';

interface TerminalPaneProps {
    active: boolean;
    ariaLabel: string;
    terminalId: string;
}

const onError = (message: string): void => pushToast('error', message);

const terminalPaneClassName =
    'terminal-pane relative flex h-full w-full min-h-0 min-w-0 flex-col pt-2 pl-2 bg-background';

const terminalRecoveryToneClassName = {
    danger: 'text-danger',
    neutral: 'text-muted',
} as const;

const terminalRecoveryMessageClassName =
    'terminal-recovery-message inline-flex items-center gap-2 overflow-hidden whitespace-nowrap text-ellipsis';

function TerminalRecoveryBar({
    processState,
    resumesAgentSession,
    terminalId,
}: {
    processState: ProcessState;
    resumesAgentSession: boolean;
    terminalId: string;
}) {
    const exitPresentation = getTerminalExitPresentation(processState);
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
 * Owns one xterm instance for the lifetime of its Terminal. Everything the imperative xterm callbacks
 * need is mirrored into `latestRef`, so the expensive open/attach effect never re-runs for a theme,
 * font, or process-state change. Presentation inputs are selected from the stores rather than passed
 * down, which keeps a snapshot refresh from rerendering every pane in a split layout.
 */
export function TerminalPane({ active, ariaLabel, terminalId }: TerminalPaneProps) {
    const terminal = useTerminal(terminalId);
    const session = useSelectedSession();
    const theme = useTheme();
    const settings = useSettings();
    const attachEpoch = useWorkbenchStore((state) => state.attachEpoch);
    const fontSize = settings?.['terminal.fontSize'] ?? 13;
    const scrollback = settings?.['terminal.scrollback'] ?? 1_000;
    const processState = terminal?.lastProcessState ?? 'starting';
    const isCodex = terminal?.kind === 'codex' || terminal?.provider === 'codex';
    const terminalTheme = theme?.terminal;

    const containerRef = useRef<HTMLDivElement>(null);
    const xtermRef = useRef<Terminal | undefined>(undefined);
    const [fontsReady, setFontsReady] = useState(false);
    const attachedEpochRef = useRef(attachEpoch);
    const latestRef = useRef({
        active,
        fontSize,
        isCodex,
        processState,
        projectRoot: session?.rootPath ?? '',
        scrollback,
        terminalCwd: terminal?.cwd ?? '',
        terminalSessionId: terminal?.sessionId ?? '',
        terminalTheme,
    });

    useEffect(() => {
        latestRef.current = {
            active,
            fontSize,
            isCodex,
            processState,
            projectRoot: session?.rootPath ?? '',
            scrollback,
            terminalCwd: terminal?.cwd ?? '',
            terminalSessionId: terminal?.sessionId ?? '',
            terminalTheme,
        };
    }, [
        active,
        fontSize,
        isCodex,
        processState,
        scrollback,
        session?.rootPath,
        terminal?.cwd,
        terminal?.sessionId,
        terminalTheme,
    ]);

    useEffect(() => {
        let canceled = false;
        void loadTerminalFonts()
            .catch((error: unknown) => {
                onError(errorMessage(error, 'Bundled terminal fonts failed to load'));
            })
            .finally(() => {
                /** A corrupt font must degrade to the system monospace stack instead of blocking the PTY. */
                if (!canceled) setFontsReady(true);
            });
        return () => {
            canceled = true;
        };
    }, []);

    useEffect(() => {
        const container = containerRef.current;
        if (!fontsReady || !container) return;
        const latest = latestRef.current;
        const xterm = new Terminal({
            allowProposedApi: false,
            convertEol: false,
            cursorBlink: true,
            disableStdin: latest.processState !== 'running',
            fontFamily: TERMINAL_FONT_FAMILY,
            fontSize: latest.fontSize,
            scrollback: latest.scrollback,
            theme: latest.terminalTheme,
        });
        const fit = new FitAddon();
        const search = new SearchAddon();
        xterm.loadAddon(fit);
        xterm.loadAddon(search);
        xterm.open(container);
        const unregisterLinks = registerTerminalLinks(xterm, {
            get cwd() {
                return latestRef.current.terminalCwd;
            },
            get projectRoot() {
                return latestRef.current.projectRoot;
            },
            openFile(path, location) {
                void openFile(path).then((resolvedPath) => {
                    if (!resolvedPath || !location) return;
                    revealEditorLocation(
                        editorModelPath(latestRef.current.terminalSessionId, resolvedPath),
                        location,
                    );
                });
            },
            openUrl(url) {
                window.open(url, '_blank', 'noopener,noreferrer');
            },
        });
        xterm.attachCustomKeyEventHandler((event) => {
            const input = terminalKeyboardInput(event, latestRef.current.isCodex);
            if (!input) return true;
            event.preventDefault();
            event.stopPropagation();
            xterm.input(input);
            return false;
        });
        const handlePaste = (event: ClipboardEvent): void => {
            if (
                !latestRef.current.isCodex ||
                !event.clipboardData ||
                !clipboardContainsImage(event.clipboardData)
            )
                return;
            /** Codex owns image encoding and temp-file lifecycle; it only needs its Ctrl+V binding. */
            event.preventDefault();
            event.stopImmediatePropagation();
            xterm.input(CODEX_IMAGE_PASTE_INPUT);
        };
        container.addEventListener('paste', handlePaste, true);
        xtermRef.current = xterm;
        const replay = new TerminalReplayBuffer(
            (value) => new Promise<void>((resolve) => xterm.write(value, resolve)),
        );
        let disposed = false;
        let lastSentSize: TerminalSize | undefined;

        const fitToPane = (): TerminalSize | undefined => {
            const size = terminalSizeWithScrollbarGutter(fit.proposeDimensions());
            if (!size) return undefined;
            if (terminalSizeChanged({ cols: xterm.cols, rows: xterm.rows }, size))
                xterm.resize(size.cols, size.rows);
            return size;
        };

        const fitAndResize = (): void => {
            try {
                const size = fitToPane();
                if (!size || latestRef.current.processState !== 'running') return;
                if (!terminalSizeChanged(lastSentSize, size)) return;
                lastSentSize = size;
                void caxri.request('terminal.resize', { terminalId, ...size }).catch(() => {
                    /** Runtime restarts can reject a resize; allow the next layout observation to retry it. */
                    if (lastSentSize?.cols === size.cols && lastSentSize.rows === size.rows)
                        lastSentSize = undefined;
                });
            } catch {
                // The pane may be between layout and disposal during a Session switch.
            }
        };

        const dataDisposable = xterm.onData((data) => {
            if (latestRef.current.processState !== 'running') return;
            void caxri.request('terminal.input', { terminalId, data }).catch((error: unknown) => {
                onError(errorMessage(error, 'Terminal input failed'));
            });
        });
        let clipboardFailureReported = false;
        const selectionClipboard = new TerminalSelectionClipboard(
            (value) => navigator.clipboard.writeText(value),
            (error) => {
                if (clipboardFailureReported) return;
                clipboardFailureReported = true;
                onError(errorMessage(error, 'Terminal selection could not be copied'));
            },
        );
        const selectionDisposable = xterm.onSelectionChange(() => {
            void selectionClipboard.copy(xterm.getSelection());
        });
        const unsubscribe = caxri.onEvent((event) => {
            if (event.event !== 'terminal.output' || event.payload.terminalId !== terminalId)
                return;
            replay.push(event.payload.data);
            if (event.payload.droppedBytes)
                replay.push(
                    `\r\n[${event.payload.droppedBytes} bytes dropped by output backpressure]`,
                );
        });
        const observer = new ResizeObserver(fitAndResize);
        /** Restore into the final visible grid instead of xterm's default 80x24 viewport. */
        const initialSize = fitToPane();
        const initialize = async (): Promise<void> => {
            let payload = '';
            try {
                const attachmentIsLive = latestRef.current.processState === 'running';
                const attachment = await caxri.request(
                    'terminal.attach',
                    attachmentIsLive && initialSize
                        ? { terminalId, ...initialSize }
                        : { terminalId },
                );
                if (attachmentIsLive && initialSize) lastSentSize = initialSize;
                payload = attachment?.payload ?? '';
            } catch (error) {
                if (!disposed) onError(errorMessage(error, 'Terminal attachment failed'));
            }
            if (disposed) return;
            await replay.restore(payload);
            if (disposed) return;
            /** Resize only after xterm has parsed the snapshot and every output event buffered behind it. */
            fitAndResize();
            observer.observe(container);
            requestAnimationFrame(() => {
                if (disposed) return;
                if (latestRef.current.active && latestRef.current.processState === 'running')
                    xterm.focus();
            });
        };
        void initialize();

        return () => {
            disposed = true;
            observer.disconnect();
            container.removeEventListener('paste', handlePaste, true);
            unsubscribe();
            selectionDisposable.dispose();
            dataDisposable.dispose();
            unregisterLinks();
            xterm.dispose();
            xtermRef.current = undefined;
            void caxri.request('terminal.detach', { terminalId }).catch(() => {
                // Runtime restarts can race a pane teardown; a detached Runtime has no view to notify.
            });
        };
    }, [fontsReady, terminalId]);

    useEffect(() => {
        if (attachedEpochRef.current === attachEpoch) return;
        attachedEpochRef.current = attachEpoch;
        /** Runtime-owned attachment state is lost with the utility process even though this pane remains mounted. */
        void caxri
            .request('terminal.attach', { terminalId })
            .catch((error: unknown) =>
                onError(errorMessage(error, 'Terminal reattachment failed')),
            );
    }, [attachEpoch, terminalId]);

    useEffect(() => {
        const xterm = xtermRef.current;
        if (!xterm) return;
        const isRunning = processState === 'running';
        xterm.options.disableStdin = !isRunning;
        if (active && isRunning) requestAnimationFrame(() => xterm.focus());
        else xterm.blur();
    }, [active, processState]);

    useEffect(() => {
        if (!xtermRef.current) return;
        xtermRef.current.options.fontSize = fontSize;
        xtermRef.current.options.scrollback = scrollback;
        xtermRef.current.options.theme = terminalTheme;
    }, [fontSize, scrollback, terminalTheme]);

    useEffect(
        () => registerTerminalClearHandler(terminalId, () => xtermRef.current?.clear()),
        [terminalId],
    );

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
            <TerminalRecoveryBar
                processState={processState}
                resumesAgentSession={resumesAgentSession}
                terminalId={terminalId}
            />
        </div>
    );
}
