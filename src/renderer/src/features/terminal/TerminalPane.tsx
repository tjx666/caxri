import { FitAddon } from '@xterm/addon-fit';
import { SearchAddon } from '@xterm/addon-search';
import { Terminal } from '@xterm/xterm';
import { CircleCheck, CircleX, RotateCcw, TriangleAlert } from 'lucide-react';
import { useEffect, useRef, useState } from 'react';

import { Button } from '../../components/ui/button';
import { caxri } from '../../lib/caxri';
import { cn } from '../../lib/utils';
import { useSettings, useTerminal, useTheme } from '../../state/selectors';
import { pushToast } from '../../state/toasts';
import { useWorkbenchStore } from '../../state/workbench';
import {
    activateTerminal,
    registerTerminalClearHandler,
    restartTerminal,
} from './terminal-actions';
import { getTerminalExitPresentation } from './terminal-exit-presentation';
import { loadTerminalFonts, TERMINAL_FONT_FAMILY } from './terminal-fonts';
import { TerminalReplayBuffer } from './terminal-replay';
import { terminalSizeChanged, type TerminalSize } from './terminal-size';

interface TerminalPaneProps {
    active: boolean;
    ariaLabel: string;
    terminalId: string;
}

const onError = (message: string): void => pushToast('error', message);

const terminalPaneClassName =
    'terminal-pane relative flex h-full w-full min-h-0 min-w-0 flex-col pt-2 pr-1 pb-0 pl-2 bg-background';

const terminalRecoveryToneClassName = {
    danger: 'text-danger',
    neutral: 'text-muted',
} as const;

const terminalRecoveryMessageClassName =
    'terminal-recovery-message inline-flex items-center gap-2 overflow-hidden whitespace-nowrap text-ellipsis';

/**
 * Owns one xterm instance for the lifetime of its Terminal. Everything the imperative xterm callbacks
 * need is mirrored into `latestRef`, so the expensive open/attach effect never re-runs for a theme,
 * font, or process-state change. Presentation inputs are selected from the stores rather than passed
 * down, which keeps a snapshot refresh from rerendering every pane in a split layout.
 */
export function TerminalPane({ active, ariaLabel, terminalId }: TerminalPaneProps) {
    const terminal = useTerminal(terminalId);
    const theme = useTheme();
    const settings = useSettings();
    const attachEpoch = useWorkbenchStore((state) => state.attachEpoch);
    const fontSize = settings?.['terminal.fontSize'] ?? 13;
    const scrollback = settings?.['terminal.scrollback'] ?? 1_000;
    const processState = terminal?.lastProcessState ?? 'starting';
    const terminalTheme = theme?.terminal;

    const containerRef = useRef<HTMLDivElement>(null);
    const xtermRef = useRef<Terminal | undefined>(undefined);
    const [fontsReady, setFontsReady] = useState(false);
    const attachedEpochRef = useRef(attachEpoch);
    const latestRef = useRef({ active, fontSize, processState, scrollback, terminalTheme });

    useEffect(() => {
        latestRef.current = { active, fontSize, processState, scrollback, terminalTheme };
    }, [active, fontSize, processState, scrollback, terminalTheme]);

    useEffect(() => {
        let canceled = false;
        void loadTerminalFonts()
            .catch((error: unknown) => {
                onError(
                    error instanceof Error
                        ? error.message
                        : 'Bundled terminal fonts failed to load',
                );
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
        if (!fontsReady || !containerRef.current) return;
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
        xterm.open(containerRef.current);
        xtermRef.current = xterm;
        const replay = new TerminalReplayBuffer((value) => xterm.write(value));
        let disposed = false;

        const dataDisposable = xterm.onData((data) => {
            if (latestRef.current.processState !== 'running') return;
            void caxri.request('terminal.input', { terminalId, data }).catch((error: unknown) => {
                onError(error instanceof Error ? error.message : 'Terminal input failed');
            });
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
        void caxri
            .request('terminal.attach', { terminalId })
            .then((snapshot) => {
                if (!disposed) replay.restore(snapshot?.payload ?? '');
            })
            .catch((error: unknown) => {
                if (disposed) return;
                replay.restore('');
                onError(error instanceof Error ? error.message : 'Terminal attachment failed');
            });
        let lastSentSize: TerminalSize | undefined;
        const observer = new ResizeObserver(() => {
            try {
                fit.fit();
                if (latestRef.current.processState === 'running') {
                    const size = { cols: xterm.cols, rows: xterm.rows };
                    if (!terminalSizeChanged(lastSentSize, size)) return;
                    lastSentSize = size;
                    void caxri.request('terminal.resize', {
                        terminalId,
                        ...size,
                    });
                }
            } catch {
                // The pane may be between layout and disposal during a Session switch.
            }
        });
        observer.observe(containerRef.current);
        requestAnimationFrame(() => {
            fit.fit();
            if (latestRef.current.active && latestRef.current.processState === 'running')
                xterm.focus();
        });

        return () => {
            disposed = true;
            observer.disconnect();
            unsubscribe();
            dataDisposable.dispose();
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
                onError(error instanceof Error ? error.message : 'Terminal reattachment failed'),
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

    const exitPresentation = getTerminalExitPresentation(processState);
    const ExitIcon =
        exitPresentation?.icon === 'completed'
            ? CircleCheck
            : exitPresentation?.icon === 'failed'
              ? TriangleAlert
              : CircleX;

    return (
        <div
            role="region"
            aria-label={ariaLabel}
            className={terminalPaneClassName}
            data-terminal-id={terminalId}
            onFocus={() => activateTerminal(terminalId)}
        >
            <div ref={containerRef} className="terminal-surface min-h-0 w-full flex-1" />
            {exitPresentation && (
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
                    <Button
                        aria-label="Restart Terminal"
                        className="terminal-recovery-action flex-none min-h-6 px-2 text-inherit"
                        size="sm"
                        title="Restart Terminal (Command+Shift+R)"
                        variant="ghost"
                        onClick={() => restartTerminal(terminalId)}
                    >
                        <RotateCcw size={12} /> Restart
                    </Button>
                </div>
            )}
        </div>
    );
}
