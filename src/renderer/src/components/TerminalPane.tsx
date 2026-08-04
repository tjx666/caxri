import { FitAddon } from '@xterm/addon-fit';
import { SearchAddon } from '@xterm/addon-search';
import { Terminal } from '@xterm/xterm';
import { RotateCcw, Skull } from 'lucide-react';
import { useEffect, useRef, useState } from 'react';

import type { TerminalRecord, TerminalSnapshot, ThemeTokens } from '@shared/types';

import { loadTerminalFonts, TERMINAL_FONT_FAMILY } from '../lib/terminal-fonts';
import { TerminalReplayBuffer } from '../lib/terminal-replay';
import { onTerminalViewClear } from '../lib/terminal-view-commands';
import { Button } from './ui/button';

interface TerminalPaneProps {
    active: boolean;
    ariaLabel: string;
    attachEpoch: number;
    terminal: TerminalRecord;
    theme: ThemeTokens;
    fontSize: number;
    scrollback: number;
    onRestart: (terminalId: string) => void;
    onError: (message: string) => void;
    onFocus: () => void;
}

export function TerminalPane({
    active,
    ariaLabel,
    attachEpoch,
    terminal,
    theme,
    fontSize,
    scrollback,
    onRestart,
    onError,
    onFocus,
}: TerminalPaneProps) {
    const containerRef = useRef<HTMLDivElement>(null);
    const xtermRef = useRef<Terminal | undefined>(undefined);
    const [fontsReady, setFontsReady] = useState(false);
    const attachedEpochRef = useRef(attachEpoch);
    const latestRef = useRef({
        active,
        fontSize,
        onError,
        processState: terminal.lastProcessState,
        scrollback,
        terminalTheme: theme.terminal,
    });

    useEffect(() => {
        latestRef.current = {
            active,
            fontSize,
            onError,
            processState: terminal.lastProcessState,
            scrollback,
            terminalTheme: theme.terminal,
        };
    }, [active, fontSize, onError, scrollback, terminal.lastProcessState, theme.terminal]);

    useEffect(() => {
        let canceled = false;
        void loadTerminalFonts()
            .catch((error: unknown) => {
                latestRef.current.onError(
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
            void window.caxri
                .request('terminal.input', { terminalId: terminal.id, data })
                .catch((error: unknown) => {
                    latestRef.current.onError(
                        error instanceof Error ? error.message : 'Terminal input failed',
                    );
                });
        });
        const unsubscribe = window.caxri.onEvent((event) => {
            if (event.event !== 'terminal.output' || event.payload.terminalId !== terminal.id)
                return;
            replay.push(event.payload.data);
            if (event.payload.droppedBytes)
                replay.push(
                    `\r\n[${event.payload.droppedBytes} bytes dropped by output backpressure]`,
                );
        });
        void window.caxri
            .request<TerminalSnapshot | null>('terminal.attach', { terminalId: terminal.id })
            .then((snapshot) => {
                if (!disposed) replay.restore(snapshot?.payload ?? '');
            })
            .catch((error: unknown) => {
                if (disposed) return;
                replay.restore('');
                latestRef.current.onError(
                    error instanceof Error ? error.message : 'Terminal attachment failed',
                );
            });
        const observer = new ResizeObserver(() => {
            try {
                fit.fit();
                if (latestRef.current.processState === 'running') {
                    void window.caxri.request('terminal.resize', {
                        terminalId: terminal.id,
                        cols: xterm.cols,
                        rows: xterm.rows,
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
            void window.caxri.request('terminal.detach', { terminalId: terminal.id }).catch(() => {
                // Runtime restarts can race a pane teardown; a detached Runtime has no view to notify.
            });
        };
    }, [fontsReady, terminal.id]);

    useEffect(() => {
        if (attachedEpochRef.current === attachEpoch) return;
        attachedEpochRef.current = attachEpoch;
        /** Runtime-owned attachment state is lost with the utility process even though this pane remains mounted. */
        void window.caxri
            .request('terminal.attach', { terminalId: terminal.id })
            .catch((error: unknown) =>
                latestRef.current.onError(
                    error instanceof Error ? error.message : 'Terminal reattachment failed',
                ),
            );
    }, [attachEpoch, terminal.id]);

    useEffect(() => {
        const xterm = xtermRef.current;
        if (!xterm) return;
        const isRunning = terminal.lastProcessState === 'running';
        xterm.options.disableStdin = !isRunning;
        if (active && isRunning) requestAnimationFrame(() => xterm.focus());
        else xterm.blur();
    }, [active, terminal.lastProcessState]);

    useEffect(() => {
        if (!xtermRef.current) return;
        xtermRef.current.options.fontSize = fontSize;
        xtermRef.current.options.scrollback = scrollback;
        xtermRef.current.options.theme = theme.terminal;
    }, [fontSize, scrollback, theme]);

    useEffect(
        () => onTerminalViewClear(terminal.id, () => xtermRef.current?.clear()),
        [terminal.id],
    );

    const isDead =
        terminal.lastProcessState !== 'running' && terminal.lastProcessState !== 'starting';

    return (
        <div
            role="region"
            aria-label={ariaLabel}
            className="terminal-pane"
            data-terminal-id={terminal.id}
            onFocus={onFocus}
        >
            <div ref={containerRef} className="terminal-surface" />
            {isDead && (
                <div className="terminal-dead">
                    <Skull size={17} />
                    <span>Terminal {terminal.lastProcessState}</span>
                    <Button size="sm" variant="secondary" onClick={() => onRestart(terminal.id)}>
                        <RotateCcw size={13} /> Restart Terminal
                    </Button>
                </div>
            )}
        </div>
    );
}
