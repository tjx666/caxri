import { FitAddon } from '@xterm/addon-fit';
import { ClipboardAddon } from '@xterm/addon-clipboard';
import { ProgressAddon } from '@xterm/addon-progress';
import {
    SearchAddon,
    type ISearchOptions,
    type ISearchResultChangeEvent,
} from '@xterm/addon-search';
import { Unicode11Addon } from '@xterm/addon-unicode11';
import { Terminal } from '@xterm/xterm';
import { useCallback, useEffect, useRef, useState } from 'react';

import { editorModelPath } from '@shared/editor-state';
import { errorMessage } from '@shared/ipc';
import type { ProcessState, ThemeTokens } from '@shared/types';

import { caxri } from '../../lib/caxri';
import { pushToast } from '../../stores/toasts';
import { openFile } from '../editor/document-actions';
import { revealEditorLocation } from '../editor/editor-reveal';
import {
    registerTerminalClearHandler,
    registerTerminalSelectionHandlers,
} from './terminal-actions';
import {
    formatTerminalCommandCompletionStatus,
    registerTerminalCommandNavigation,
    TerminalCommandTracker,
} from './terminal-commands';
import { loadTerminalFonts, TERMINAL_FONT_FAMILY } from './terminal-fonts';
import {
    CODEX_IMAGE_PASTE_INPUT,
    clipboardContainsImage,
    terminalKeyboardInput,
} from './terminal-keyboard';
import { registerTerminalLinks } from './terminal-links';
import { ControlledOsc52Clipboard, type Osc52BlockReason } from './terminal-osc52-clipboard';
import { clearTerminalProgress, updateTerminalProgress } from './terminal-progress';
import { createTerminalImageAddon, registerTerminalImageAddon } from './terminal-images';
import { shouldReconcileTerminalRecovery } from './terminal-recovery';
import {
    TerminalRendererController,
    type TerminalGpuAcceleration,
    type TerminalRendererReason,
    type TerminalRendererStatus,
} from './terminal-renderer';
import { TerminalReplayCoordinator } from './terminal-replay';
import {
    TERMINAL_SEARCH_HIGHLIGHT_LIMIT,
    type TerminalSearchOptions,
    type TerminalSearchResults,
} from './terminal-search';
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
    gpuAcceleration: TerminalGpuAcceleration;
    isCodex: boolean;
    osc52ClipboardWrite: boolean;
    processState: ProcessState;
    projectRoot: string;
    scrollback: number;
    terminalCwd: string;
    terminalId: string;
    terminalSessionId: string;
    terminalTheme: ThemeTokens['terminal'] | undefined;
}

const onError = (message: string): void => pushToast('error', message);

/**
 * A blocked OSC 52 write is expected policy enforcement, not a failure — it uses `info` (which
 * auto-dismisses) rather than the persistent `error` styling reserved for `onWriteFailure` below.
 */
const OSC52_BLOCK_MESSAGES: Record<Osc52BlockReason, string> = {
    'disabled':
        'A Terminal program tried to copy to the clipboard, but OSC 52 access is off in Settings.',
    'malformed': 'A Terminal program sent a malformed clipboard request; it was ignored.',
    'oversized': 'A Terminal program tried to copy too much text at once; the request was ignored.',
    'rate-limited':
        'A Terminal program is copying to the clipboard too quickly; extra requests are being ignored.',
};

const emptySearchResults: TerminalSearchResults = { resultCount: 0, resultIndex: -1 };

/**
 * Only the reasons the user did not choose are worth a toast: `disabled` reflects their own GPU
 * acceleration setting, `active`/`disposed` are healthy or teardown states, so neither needs one.
 */
const RENDERER_FALLBACK_MESSAGES: Partial<Record<TerminalRendererReason, string>> = {
    'context-loss':
        'GPU acceleration was lost for this Terminal; it fell back to standard rendering.',
    'load-failed':
        'GPU acceleration could not start for this Terminal; it is using standard rendering.',
    'unsupported':
        'This Terminal is using standard rendering because GPU acceleration is unavailable.',
};

/** SearchAddon requires opaque `#RRGGBB`; imported semantic tokens may include an alpha byte. */
function opaqueSearchColor(color: string): string {
    return color.slice(0, 7);
}

/** Owns the imperative xterm lifecycle so TerminalPane stays a small presentation component. */
export function useTerminalPaneRuntime({
    active,
    attachEpoch,
    copyOnSelect,
    fontSize,
    gpuAcceleration,
    isCodex,
    osc52ClipboardWrite,
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
    /** Set by the mount effect below; the context menu's Paste action reads through this instead of
     *  capturing the imperative xterm instance directly, since the effect (re)runs per attach epoch. */
    const pasteRef = useRef<(() => Promise<void>) | undefined>(undefined);
    const searchRef = useRef<SearchAddon | undefined>(undefined);
    const searchActiveRef = useRef(false);
    const searchSignatureRef = useRef('');
    const replayRef = useRef<TerminalReplayCoordinator | undefined>(undefined);
    const rendererRef = useRef<TerminalRendererController | undefined>(undefined);
    const [fontsReady, setFontsReady] = useState(false);
    const [searchResults, setSearchResults] = useState<TerminalSearchResults>(emptySearchResults);
    const attachedEpochRef = useRef(attachEpoch);
    const previousProcessStateRef = useRef(processState);
    const latestRef = useRef({
        active,
        copyOnSelect,
        fontSize,
        gpuAcceleration,
        isCodex,
        osc52ClipboardWrite,
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
            gpuAcceleration,
            isCodex,
            osc52ClipboardWrite,
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
        gpuAcceleration,
        isCodex,
        osc52ClipboardWrite,
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
            allowProposedApi: true,
            convertEol: false,
            cursorBlink: true,
            disableStdin: latest.processState !== 'running',
            fontFamily: TERMINAL_FONT_FAMILY,
            fontSize: latest.fontSize,
            scrollback: latest.scrollback,
            theme: latest.terminalTheme,
        });
        const fit = new FitAddon();
        /** One bounded sentinel match distinguishes exactly-at-limit from overflow without parsing
         *  Terminal text outside xterm's Unicode- and wrap-aware search engine. */
        const search = new SearchAddon({ highlightLimit: TERMINAL_SEARCH_HIGHLIGHT_LIMIT + 1 });
        const unicode11 = new Unicode11Addon();
        const osc52Clipboard = new ControlledOsc52Clipboard({
            enabled: () => latestRef.current.osc52ClipboardWrite,
            onBlocked: (reason) => pushToast('info', OSC52_BLOCK_MESSAGES[reason]),
            onWriteFailure: () =>
                onError('OSC 52 clipboard write was denied. Check macOS clipboard permissions.'),
            writeClipboard: (text) => navigator.clipboard.writeText(text),
        });
        const clipboard = new ClipboardAddon(osc52Clipboard, osc52Clipboard);
        const progress = new ProgressAddon();
        xterm.loadAddon(fit);
        xterm.loadAddon(search);
        xterm.loadAddon(clipboard);
        xterm.loadAddon(progress);
        xterm.loadAddon(unicode11);
        xterm.unicode.activeVersion = '11';
        xterm.open(container);
        const commandStatusElement = document.createElement('div');
        commandStatusElement.className = 'terminal-command-status sr-only';
        commandStatusElement.setAttribute('aria-atomic', 'true');
        commandStatusElement.setAttribute('aria-live', 'polite');
        commandStatusElement.setAttribute('role', 'status');
        container.append(commandStatusElement);
        let previousCompletedCommandCount = 0;
        const commandTracker = new TerminalCommandTracker(
            xterm,
            {
                failed: latest.terminalTheme?.red ?? '#ff5555',
                prompt: latest.terminalTheme?.brightBlack ?? '#6272a4',
                running: latest.terminalTheme?.yellow ?? '#f1fa8c',
                succeeded: latest.terminalTheme?.green ?? '#50fa7b',
            },
            ({ commandCount, completedCount, lastExitStatus }) => {
                container.dataset.terminalCommandCount = String(commandCount);
                container.dataset.terminalCommandCompletedCount = String(completedCount);
                if (lastExitStatus === undefined)
                    delete container.dataset.terminalCommandLastExitStatus;
                else container.dataset.terminalCommandLastExitStatus = String(lastExitStatus);
                if (completedCount > previousCompletedCommandCount && lastExitStatus !== undefined)
                    commandStatusElement.textContent =
                        formatTerminalCommandCompletionStatus(lastExitStatus);
                previousCompletedCommandCount = completedCount;
            },
        );
        const unregisterCommandNavigation = registerTerminalCommandNavigation(
            terminalId,
            (direction) => commandTracker.navigate(direction),
        );
        let unregisterTerminalImages = (): void => undefined;
        const images = createTerminalImageAddon();
        try {
            xterm.loadAddon(images);
            unregisterTerminalImages = registerTerminalImageAddon(terminalId, images, (status) => {
                container.dataset.terminalImageStatus = 'active';
                container.dataset.terminalImagesAdded = String(status.imagesAdded);
                container.dataset.terminalImageStorageMb = String(status.storageUsageMb);
                container.dataset.terminalImageStorageLimitMb = String(status.storageLimitMb);
                container.dataset.terminalImageGlobalStorageMb = String(
                    status.globalStorageUsageMb,
                );
                container.dataset.terminalImageGlobalStorageLimitMb = String(
                    status.globalStorageLimitMb,
                );
            });
        } catch {
            /** Inline images are optional output decoration; addon activation must not make the
             *  Terminal or its underlying PTY unavailable. */
            images.dispose();
            container.dataset.terminalImageStatus = 'unavailable';
        }
        searchRef.current = search;
        const searchResultsDisposable = search.onDidChangeResults(
            ({ resultCount, resultIndex }: ISearchResultChangeEvent) =>
                setSearchResults({ resultCount, resultIndex }),
        );
        const progressDisposable = progress.onChange((update) => {
            /** A stopped Terminal can replay historical OSC bytes during recovery; those bytes must
             *  not resurrect progress after the process lifecycle already cleared it. */
            if (latestRef.current.processState !== 'running') {
                clearTerminalProgress(terminalId);
                return;
            }
            updateTerminalProgress(terminalId, update);
        });
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

        let rendererFallbackNotified = false;
        const publishRendererStatus = (status: TerminalRendererStatus): void => {
            container.dataset.terminalRenderer = status.mode;
            container.dataset.terminalRendererReason = status.reason;
            container.dataset.terminalWebglContextLosses = String(status.contextLossCount);
            container.dataset.terminalRendererRedraws = String(status.redrawCount);
            /** A dropped GPU context can recur many times; only the first fallback for this pane's
             *  lifetime is worth a toast; repeats would just be noise about the same known state. */
            const message = RENDERER_FALLBACK_MESSAGES[status.reason];
            if (message && !rendererFallbackNotified) {
                rendererFallbackNotified = true;
                pushToast('info', message);
            }
        };
        const renderer = new TerminalRendererController(
            xterm,
            () => {
                fitToPane();
                xterm.refresh(0, xterm.rows - 1);
            },
            publishRendererStatus,
        );
        rendererRef.current = renderer;
        renderer.setPreference(latest.gpuAcceleration);
        const restoreRenderer = (): void => {
            if (document.visibilityState === 'visible') renderer.restoreVisible();
        };
        document.addEventListener('visibilitychange', restoreRenderer);
        window.addEventListener('focus', restoreRenderer);
        window.addEventListener('pageshow', restoreRenderer);

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
            /** SearchAddon represents the active match as a selection; it must not overwrite the
             *  system clipboard when the user's copy-on-select preference is enabled. */
            if (searchActiveRef.current) return;
            if (!latestRef.current.copyOnSelect) return;
            void selectionClipboard.copy(xterm.getSelection());
        });
        const unregisterSelectionHandlers = registerTerminalSelectionHandlers(terminalId, {
            copySelection: () => {
                const selection = xterm.getSelection();
                if (selection) void selectionClipboard.copy(selection);
            },
            hasSelection: () => xterm.hasSelection(),
        });
        const pasteFromClipboard = async (): Promise<void> => {
            if (latestRef.current.processState !== 'running') return;
            try {
                const text = await navigator.clipboard.readText();
                if (text) xterm.paste(text);
            } catch (error) {
                onError(errorMessage(error, 'Terminal paste failed'));
            }
        };
        pasteRef.current = pasteFromClipboard;
        const unsubscribe = caxri.onEvent((event) => {
            if (event.event !== 'terminal.output' || event.payload.terminalId !== terminalId)
                return;
            replay.push(event.payload.data);
            /** Runtime's `TerminalImageOutputFilter` now reports its own size-limit drops as an
             *  inline `TERMINAL_IMAGE_OUTPUT_TRUNCATED_PLACEHOLDER` inside `data` above instead of
             *  folding them into this counter, so a nonzero value here is genuine output-queue
             *  backpressure only. */
            if (event.payload.droppedBytes)
                replay.push(
                    `\r\n[${event.payload.droppedBytes} bytes dropped by output backpressure]`,
                );
        });
        const observer = new ResizeObserver(fitAndResize);
        let attachFocusSuperseded = false;
        const trackNewerFocus = (event: FocusEvent): void => {
            const target = event.target;
            if (target instanceof Node && target !== document.body && !container.contains(target))
                attachFocusSuperseded = true;
        };
        document.addEventListener('focusin', trackNewerFocus);
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
                document.removeEventListener('focusin', trackNewerFocus);
                if (disposed) return;
                /** Attach may finish after the activation effect ran before xterm existed. Complete
                 *  that initial focus only while no newer interaction has moved focus elsewhere. */
                if (
                    latestRef.current.active &&
                    latestRef.current.processState === 'running' &&
                    !attachFocusSuperseded
                )
                    xterm.focus();
            });
        };
        void initialize();

        return () => {
            disposed = true;
            observer.disconnect();
            document.removeEventListener('focusin', trackNewerFocus);
            document.removeEventListener('visibilitychange', restoreRenderer);
            window.removeEventListener('focus', restoreRenderer);
            window.removeEventListener('pageshow', restoreRenderer);
            container.removeEventListener('paste', handlePaste, true);
            unsubscribe();
            progressDisposable.dispose();
            searchResultsDisposable.dispose();
            selectionDisposable.dispose();
            unregisterSelectionHandlers();
            if (pasteRef.current === pasteFromClipboard) pasteRef.current = undefined;
            dataDisposable.dispose();
            unregisterLinks();
            unregisterCommandNavigation();
            commandTracker.dispose();
            commandStatusElement.remove();
            unregisterTerminalImages();
            renderer.dispose();
            /** Inactive tabs dispose their xterm pane too. TerminalProgressRegistry therefore
             *  reconciles against durable Terminal records instead of treating pane disposal as close. */
            xterm.dispose();
            xtermRef.current = undefined;
            if (rendererRef.current === renderer) rendererRef.current = undefined;
            if (searchRef.current === search) searchRef.current = undefined;
            searchActiveRef.current = false;
            searchSignatureRef.current = '';
            if (replayRef.current === replay) replayRef.current = undefined;
            void caxri.request('terminal.detach', { terminalId }).catch(() => {
                // Runtime restarts can race a pane teardown; a detached Runtime has no view to notify.
            });
        };
    }, [fontsReady, terminalId]);

    useEffect(() => {
        rendererRef.current?.setPreference(gpuAcceleration);
    }, [gpuAcceleration]);

    useEffect(() => {
        if (processState !== 'running') clearTerminalProgress(terminalId);
    }, [processState, terminalId]);

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

    const beginSearch = useCallback((): void => {
        searchActiveRef.current = true;
    }, []);

    const endSearch = useCallback((): void => {
        try {
            searchRef.current?.clearDecorations();
        } finally {
            searchActiveRef.current = false;
            searchSignatureRef.current = '';
            setSearchResults(emptySearchResults);
        }
    }, []);

    const find = useCallback(
        (
            direction: 'next' | 'previous',
            query: string,
            options: TerminalSearchOptions,
            incremental = false,
        ): void => {
            const search = searchRef.current;
            if (!search) return;
            searchActiveRef.current = true;
            const theme = latestRef.current.terminalTheme;
            const searchOptions: ISearchOptions = {
                ...options,
                incremental,
                ...(theme
                    ? {
                          decorations: {
                              activeMatchBackground: opaqueSearchColor(theme.yellow),
                              activeMatchBorder: opaqueSearchColor(theme.foreground),
                              activeMatchColorOverviewRuler: opaqueSearchColor(theme.yellow),
                              matchBackground: opaqueSearchColor(theme.selectionBackground),
                              matchBorder: opaqueSearchColor(theme.brightBlack),
                              matchOverviewRuler: opaqueSearchColor(theme.selectionBackground),
                          },
                      }
                    : {}),
            };
            try {
                const signature = JSON.stringify([query, options, theme]);
                /** addon-search beta updates its cached options before checking whether options
                 *  changed, so toggling Match Case/Whole Word/Regex for the same query would retain
                 *  stale decorations and counts. Clear only on an incremental signature change;
                 *  explicit next/previous navigation must preserve the current result. */
                if (incremental && signature !== searchSignatureRef.current)
                    search.clearDecorations();
                searchSignatureRef.current = signature;
                if (!query) {
                    search.findNext('', searchOptions);
                    setSearchResults(emptySearchResults);
                    return;
                }
                if (direction === 'previous') search.findPrevious(query, searchOptions);
                else search.findNext(query, searchOptions);
            } catch (error) {
                search.clearDecorations();
                setSearchResults({
                    error:
                        error instanceof SyntaxError
                            ? 'Invalid regular expression'
                            : 'Search unavailable',
                    resultCount: 0,
                    resultIndex: -1,
                });
            }
        },
        [],
    );

    const focusTerminal = useCallback((): void => xtermRef.current?.focus(), []);

    const pasteFromClipboard = useCallback((): void => {
        void pasteRef.current?.();
    }, []);

    return {
        beginSearch,
        containerRef,
        endSearch,
        find,
        focusTerminal,
        pasteFromClipboard,
        searchResults,
    };
}
