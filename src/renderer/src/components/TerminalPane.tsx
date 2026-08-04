import { FitAddon } from '@xterm/addon-fit';
import { SearchAddon } from '@xterm/addon-search';
import { Terminal } from '@xterm/xterm';
import { RotateCcw, Skull } from 'lucide-react';
import { useEffect, useRef } from 'react';

import type { TerminalRecord, TerminalSnapshot, ThemeTokens } from '@shared/types';

import { TerminalReplayBuffer } from '../lib/terminal-replay';
import { Button } from './ui/button';

interface TerminalPaneProps {
    terminal: TerminalRecord;
    theme: ThemeTokens;
    fontSize: number;
    scrollback: number;
    onRestart: (terminalId: string) => void;
    onError: (message: string) => void;
}

export function TerminalPane({
    terminal,
    theme,
    fontSize,
    scrollback,
    onRestart,
    onError,
}: TerminalPaneProps) {
    const containerRef = useRef<HTMLDivElement>(null);
    const xtermRef = useRef<Terminal | undefined>(undefined);
    const latestRef = useRef({
        fontSize,
        onError,
        processState: terminal.lastProcessState,
        scrollback,
        terminalTheme: theme.terminal,
    });

    useEffect(() => {
        latestRef.current = {
            fontSize,
            onError,
            processState: terminal.lastProcessState,
            scrollback,
            terminalTheme: theme.terminal,
        };
    }, [fontSize, onError, scrollback, terminal.lastProcessState, theme.terminal]);

    useEffect(() => {
        if (!containerRef.current) return;
        const latest = latestRef.current;
        const xterm = new Terminal({
            allowProposedApi: false,
            convertEol: false,
            cursorBlink: true,
            disableStdin: latest.processState !== 'running',
            fontFamily: 'SFMono-Regular, Menlo, Monaco, Consolas, monospace',
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
            if (latestRef.current.processState === 'running') xterm.focus();
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
    }, [terminal.id]);

    useEffect(() => {
        const xterm = xtermRef.current;
        if (!xterm) return;
        const isRunning = terminal.lastProcessState === 'running';
        xterm.options.disableStdin = !isRunning;
        if (isRunning) requestAnimationFrame(() => xterm.focus());
        else xterm.blur();
    }, [terminal.lastProcessState]);

    useEffect(() => {
        if (!xtermRef.current) return;
        xtermRef.current.options.fontSize = fontSize;
        xtermRef.current.options.scrollback = scrollback;
        xtermRef.current.options.theme = theme.terminal;
    }, [fontSize, scrollback, theme]);

    const isDead =
        terminal.lastProcessState !== 'running' && terminal.lastProcessState !== 'starting';

    return (
        <div className="terminal-pane" data-terminal-id={terminal.id}>
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
