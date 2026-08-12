import { FitAddon } from '@xterm/addon-fit';
import { SearchAddon } from '@xterm/addon-search';
import { Terminal } from '@xterm/xterm';
import { useEffect, useRef, useState } from 'react';

import { editorModelPath } from '@shared/editor-state';
import { errorMessage } from '@shared/ipc';
import type { ProcessState, ThemeTokens } from '@shared/types';

import { caxri } from '../../lib/caxri';
import { pushToast } from '../../stores/toasts';
import { openFile } from '../editor/document-actions';
import { revealEditorLocation } from '../editor/editor-reveal';
import { registerTerminalClearHandler } from './terminal-actions';
import { loadTerminalFonts, TERMINAL_FONT_FAMILY } from './terminal-fonts';
import {
    CODEX_IMAGE_PASTE_INPUT,
    clipboardContainsImage,
    terminalKeyboardInput,
} from './terminal-keyboard';
import { registerTerminalLinks } from './terminal-links';
import { shouldReconcileTerminalRecovery } from './terminal-recovery';
import { TerminalReplayCoordinator } from './terminal-replay';
import { TerminalSelectionClipboard } from './terminal-selection-clipboard';
import {
    terminalSizeChanged,
    terminalSizeWithScrollbarGutter,
    type TerminalSize,
} from './terminal-size';

interface TerminalPaneRuntimeOptions {
    active: boolean;
    attachEpoch: number;
    copyOnSelect: boolean;
    fontSize: number;
    isCodex: boolean;
    processState: ProcessState;
    projectRoot: string;
    scrollback: number;
    terminalCwd: string;
    terminalId: string;
    terminalSessionId: string;
    terminalTheme: ThemeTokens['terminal'] | undefined;
}

const onError = (message: string): void => pushToast('error', message);

/** Owns the imperative xterm lifecycle so TerminalPane stays a small presentation component. */
export function useTerminalPaneRuntime({
    active,
    attachEpoch,
    copyOnSelect,
    fontSize,
    isCodex,
    processState,
    projectRoot,
    scrollback,
    terminalCwd,
    terminalId,
    terminalSessionId,
    terminalTheme,
}: TerminalPaneRuntimeOptions) {
    const containerRef = useRef<HTMLDivElement>(null);
    const xtermRef = useRef<Terminal | undefined>(undefined);
    const replayRef = useRef<TerminalReplayCoordinator | undefined>(undefined);
    const [fontsReady, setFontsReady] = useState(false);
    const attachedEpochRef = useRef(attachEpoch);
    const previousProcessStateRef = useRef(processState);
    const latestRef = useRef({
        active,
        copyOnSelect,
        fontSize,
        isCodex,
        processState,
        projectRoot,
        scrollback,
        terminalCwd,
        terminalSessionId,
        terminalTheme,
    });

    useEffect(() => {
        latestRef.current = {
            active,
            copyOnSelect,
            fontSize,
            isCodex,
            processState,
            projectRoot,
            scrollback,
            terminalCwd,
            terminalSessionId,
            terminalTheme,
        };
    }, [
        active,
        copyOnSelect,
        fontSize,
        isCodex,
        processState,
        projectRoot,
        scrollback,
        terminalCwd,
        terminalSessionId,
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
                void caxri
                    .request('external.open', { url })
                    .then((result) => {
                        if (result.status !== 'rejected') return;
                        onError(
                            result.reason === 'unsupported_protocol'
                                ? 'Only HTTP and HTTPS links can be opened'
                                : result.reason === 'credentials_not_allowed'
                                  ? 'External links cannot include credentials'
                                  : 'External link is invalid',
                        );
                    })
                    .catch((error) =>
                        onError(errorMessage(error, 'External link could not be opened')),
                    );
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
        let disposed = false;
        const replay = new TerminalReplayCoordinator(
            (value) =>
                new Promise<void>((resolve) => {
                    if (disposed) resolve();
                    else xterm.write(value, resolve);
                }),
            () => {
                if (!disposed) xterm.reset();
            },
        );
        replayRef.current = replay;
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
            if (!latestRef.current.copyOnSelect) return;
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
                const attachment = await caxri.request(
                    'terminal.attach',
                    initialSize ? { terminalId, ...initialSize } : { terminalId },
                );
                if (latestRef.current.processState === 'running' && initialSize)
                    lastSentSize = initialSize;
                payload = attachment?.payload ?? '';
            } catch (error) {
                if (!disposed) onError(errorMessage(error, 'Terminal attachment failed'));
            }
            if (disposed) return;
            await replay.restoreInitial(payload);
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
            if (replayRef.current === replay) replayRef.current = undefined;
            void caxri.request('terminal.detach', { terminalId }).catch(() => {
                // Runtime restarts can race a pane teardown; a detached Runtime has no view to notify.
            });
        };
    }, [fontsReady, terminalId]);

    useEffect(() => {
        if (attachedEpochRef.current === attachEpoch) return;
        attachedEpochRef.current = attachEpoch;
        const replay = replayRef.current;
        const xterm = xtermRef.current;
        if (!replay || !xterm) return;
        /** Runtime-owned attachment state is lost with the utility process even though this pane remains mounted. */
        void replay
            .reattach(async () => {
                const attachment = await caxri.request(
                    'terminal.attach',
                    latestRef.current.processState === 'running'
                        ? { terminalId, cols: xterm.cols, rows: xterm.rows }
                        : { terminalId },
                );
                return attachment?.payload ?? '';
            })
            .catch((error: unknown) =>
                onError(errorMessage(error, 'Terminal reattachment failed')),
            );
    }, [attachEpoch, terminalId]);

    useEffect(() => {
        const xterm = xtermRef.current;
        const replay = replayRef.current;
        const previousProcessState = previousProcessStateRef.current;
        previousProcessStateRef.current = processState;
        if (!xterm) return;
        const isRunning = processState === 'running';
        xterm.options.disableStdin = !isRunning;
        if (active && isRunning) requestAnimationFrame(() => xterm.focus());
        else xterm.blur();
        if (!replay || !shouldReconcileTerminalRecovery(previousProcessState, processState)) return;
        /** The initial attach can finish before Runtime spawns a new, restarted, or resumed PTY.
         *  Reattach once at the measured grid so Runtime resizes its parsed screen behind an ordering
         *  barrier, then replace any stale persisted snapshot ahead of later live output. */
        void replay
            .reattach(async () => {
                const attachment = await caxri.request('terminal.attach', {
                    terminalId,
                    cols: xterm.cols,
                    rows: xterm.rows,
                });
                return attachment?.payload ?? '';
            })
            .catch((error: unknown) =>
                onError(errorMessage(error, 'Terminal recovery reconciliation failed')),
            );
    }, [active, processState, terminalId]);

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

    return containerRef;
}
