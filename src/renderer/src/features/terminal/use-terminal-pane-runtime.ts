import { useCallback, useEffect, useRef, useState } from 'react';

import { editorModelPath } from '@shared/editor-state';
import { errorMessage } from '@shared/ipc';
import type { ProcessState, ThemeTokens } from '@shared/types';
import { ClipboardAddon } from '@xterm/addon-clipboard';
import { FitAddon } from '@xterm/addon-fit';
import { ProgressAddon } from '@xterm/addon-progress';
import type { ISearchOptions, ISearchResultChangeEvent } from '@xterm/addon-search';
import { SearchAddon } from '@xterm/addon-search';
import { Unicode11Addon } from '@xterm/addon-unicode11';
import { Terminal } from '@xterm/xterm';

import { caxri } from '../../lib/caxri';
import { useDialogStore } from '../../stores/dialogs';
import { sessionViewScope } from '../../stores/session-view';
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
import { createTerminalImageAddon, registerTerminalImageAddon } from './terminal-images';
import {
    CODEX_IMAGE_PASTE_INPUT,
    isClipboardContainingImage,
    terminalKeyboardInput,
} from './terminal-keyboard';
import { registerTerminalLinks } from './terminal-links';
import { ControlledOsc52Clipboard } from './terminal-osc52-clipboard';
import {
    detachTerminalQuietly,
    emptySearchResults,
    onError,
    opaqueSearchColor,
    OSC52_BLOCK_MESSAGES,
    RENDERER_FALLBACK_MESSAGES,
} from './terminal-pane-support';
import { reconcileTerminalProcessFocus, shouldAutoFocusTerminal } from './terminal-process-focus';
import { clearTerminalProgress, updateTerminalProgress } from './terminal-progress';
import { shouldReconcileTerminalRecovery } from './terminal-recovery';
import type { TerminalGpuAcceleration, TerminalRendererStatus } from './terminal-renderer';
import { TerminalRendererController } from './terminal-renderer';
import { TerminalReplayCoordinator } from './terminal-replay';
import type { TerminalSearchOptions, TerminalSearchResults } from './terminal-search';
import { TERMINAL_SEARCH_HIGHLIGHT_LIMIT } from './terminal-search';
import { TerminalSelectionClipboard } from './terminal-selection-clipboard';
import type { TerminalSize } from './terminal-size';
import { didTerminalSizeChange, terminalSizeWithScrollbarGutter } from './terminal-size';

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

/**
 * Owns the imperative xterm lifecycle so TerminalPane stays a small presentation component.
 */
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
    const containerReference = useRef<HTMLDivElement>(null);
    const xtermReference = useRef<Terminal | undefined>(undefined);
    /**
     * Set by the mount effect below; the context menu's Paste action reads through this instead of capturing the
     * imperative xterm instance directly, since the effect (re)runs per attach epoch.
     */
    const pasteReference = useRef<(() => Promise<void>) | undefined>(undefined);
    const searchReference = useRef<SearchAddon | undefined>(undefined);
    const searchActiveReference = useRef(false);
    const searchSignatureReference = useRef('');
    const replayReference = useRef<TerminalReplayCoordinator | undefined>(undefined);
    const rendererReference = useRef<TerminalRendererController | undefined>(undefined);
    const [fontsReady, setFontsReady] = useState(false);
    const [searchResults, setSearchResults] = useState<TerminalSearchResults>(emptySearchResults);
    const attachedEpochReference = useRef(attachEpoch);
    const previousProcessStateReference = useRef(processState);
    const latestReference = useRef({
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
        latestReference.current = {
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
        let isCanceled = false;
        const load = async (): Promise<void> => {
            try {
                await loadTerminalFonts();
            } catch (error) {
                onError(errorMessage(error, 'Bundled terminal fonts failed to load'));
            } finally {
                /**
                 * A corrupt font must degrade to the system monospace stack instead of blocking the PTY.
                 */
                if (!isCanceled) setFontsReady(true);
            }
        };
        // Effects cannot be async themselves; the failure path above already reports the error.
        // eslint-disable-next-line no-void -- intentional floating-promise discard, see above
        void load();
        return () => {
            isCanceled = true;
        };
    }, []);

    useEffect(() => {
        const container = containerReference.current;
        if (!fontsReady || !container) return;
        delete container.dataset.terminalAttached;
        const latest = latestReference.current;
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
        /**
         * One bounded sentinel match distinguishes exactly-at-limit from overflow without parsing Terminal text outside
         * xterm's Unicode- and wrap-aware search engine.
         */
        const search = new SearchAddon({ highlightLimit: TERMINAL_SEARCH_HIGHLIGHT_LIMIT + 1 });
        const unicode11 = new Unicode11Addon();
        const osc52Clipboard = new ControlledOsc52Clipboard({
            enabled: () => latestReference.current.osc52ClipboardWrite,
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
                if (lastExitStatus !== undefined && completedCount > previousCompletedCommandCount)
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
            /**
             * Inline images are optional output decoration; addon activation must not make the Terminal or its
             * underlying PTY unavailable.
             */
            images.dispose();
            container.dataset.terminalImageStatus = 'unavailable';
        }
        searchReference.current = search;
        const searchResultsDisposable = search.onDidChangeResults(
            ({ resultCount, resultIndex }: ISearchResultChangeEvent) =>
                setSearchResults({ resultCount, resultIndex }),
        );
        const progressDisposable = progress.onChange((update) => {
            /**
             * A stopped Terminal can replay historical OSC bytes during recovery; those bytes must not resurrect
             * progress after the process lifecycle already cleared it.
             */
            if (latestReference.current.processState !== 'running') {
                clearTerminalProgress(terminalId);
                return;
            }
            updateTerminalProgress(terminalId, update);
        });
        const unregisterLinks = registerTerminalLinks(xterm, {
            get cwd() {
                return latestReference.current.terminalCwd;
            },
            get projectRoot() {
                return latestReference.current.projectRoot;
            },
            async openFile(path, location) {
                const resolvedPath = await openFile(path);
                if (!resolvedPath || !location) return;
                revealEditorLocation(
                    editorModelPath(
                        sessionViewScope(latestReference.current.terminalSessionId),
                        resolvedPath,
                    ),
                    location,
                );
            },
            async openUrl(url) {
                try {
                    const result = await caxri.request('external.open', { url });
                    if (result.status !== 'rejected') return;
                    onError(
                        result.reason === 'unsupported_protocol'
                            ? 'Only HTTP and HTTPS links can be opened'
                            : result.reason === 'credentials_not_allowed'
                              ? 'External links cannot include credentials'
                              : 'External link is invalid',
                    );
                } catch (error) {
                    onError(errorMessage(error, 'External link could not be opened'));
                }
            },
        });
        xterm.attachCustomKeyEventHandler((event) => {
            const input = terminalKeyboardInput(event, latestReference.current.isCodex);
            if (!input) return true;
            event.preventDefault();
            event.stopPropagation();
            xterm.input(input);
            return false;
        });
        const handlePaste = (event: ClipboardEvent): void => {
            if (
                !latestReference.current.isCodex ||
                !event.clipboardData ||
                !isClipboardContainingImage(event.clipboardData)
            )
                return;
            /**
             * Codex owns image encoding and temp-file lifecycle; it only needs its Ctrl+V binding.
             */
            event.preventDefault();
            event.stopImmediatePropagation();
            xterm.input(CODEX_IMAGE_PASTE_INPUT);
        };
        container.addEventListener('paste', handlePaste, { capture: true });
        xtermReference.current = xterm;
        let isDisposed = false;
        const replay = new TerminalReplayCoordinator(
            (value) =>
                new Promise<void>((resolve) => {
                    if (isDisposed) resolve();
                    else xterm.write(value, resolve);
                }),
            () => {
                if (!isDisposed) xterm.reset();
            },
        );
        replayReference.current = replay;
        let lastSentSize: TerminalSize | undefined;

        const fitToPane = (): TerminalSize | undefined => {
            const size = terminalSizeWithScrollbarGutter(fit.proposeDimensions());
            if (!size) return undefined;
            if (didTerminalSizeChange({ cols: xterm.cols, rows: xterm.rows }, size))
                xterm.resize(size.cols, size.rows);
            return size;
        };

        const sendResize = async (size: TerminalSize): Promise<void> => {
            try {
                await caxri.request('terminal.resize', { terminalId, ...size });
            } catch {
                /**
                 * Runtime restarts can reject a resize; allow the next layout observation to retry it.
                 */
                if (lastSentSize?.cols === size.cols && lastSentSize.rows === size.rows)
                    lastSentSize = undefined;
            }
        };

        const fitAndResize = (): void => {
            try {
                const size = fitToPane();
                if (!size || latestReference.current.processState !== 'running') return;
                if (!didTerminalSizeChange(lastSentSize, size)) return;
                lastSentSize = size;
                // A ResizeObserver callback cannot be async; the failure path above already retries
                // on the next layout observation.
                // eslint-disable-next-line no-void -- intentional floating-promise discard, see above
                void sendResize(size);
            } catch {
                // The pane may be between layout and disposal during a Session switch.
            }
        };

        let isRendererFallbackNotified = false;
        const publishRendererStatus = (status: TerminalRendererStatus): void => {
            container.dataset.terminalRenderer = status.mode;
            container.dataset.terminalRendererReason = status.reason;
            container.dataset.terminalWebglContextLosses = String(status.contextLossCount);
            container.dataset.terminalRendererRedraws = String(status.redrawCount);
            /**
             * A dropped GPU context can recur many times; only the first fallback for this pane's lifetime is worth a
             * toast; repeats would just be noise about the same known state.
             */
            const message = RENDERER_FALLBACK_MESSAGES[status.reason];
            if (message && !isRendererFallbackNotified) {
                isRendererFallbackNotified = true;
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
        rendererReference.current = renderer;
        renderer.setPreference(latest.gpuAcceleration);
        const restoreRenderer = (): void => {
            if (document.visibilityState === 'visible') renderer.restoreVisible();
        };
        document.addEventListener('visibilitychange', restoreRenderer);
        window.addEventListener('focus', restoreRenderer);
        window.addEventListener('pageshow', restoreRenderer);

        const sendInput = async (data: string): Promise<void> => {
            try {
                await caxri.request('terminal.input', { terminalId, data });
            } catch (error) {
                onError(errorMessage(error, 'Terminal input failed'));
            }
        };
        const dataDisposable = xterm.onData((data) => {
            if (latestReference.current.processState !== 'running') return;
            // xterm's onData callback cannot be async; sendInput already reports its own failure.
            // eslint-disable-next-line no-void -- intentional floating-promise discard, see above
            void sendInput(data);
        });
        let isClipboardFailureReported = false;
        const selectionClipboard = new TerminalSelectionClipboard(
            (value) => navigator.clipboard.writeText(value),
            (error) => {
                if (isClipboardFailureReported) return;
                isClipboardFailureReported = true;
                onError(errorMessage(error, 'Terminal selection could not be copied'));
            },
        );
        const selectionDisposable = xterm.onSelectionChange(() => {
            /**
             * SearchAddon represents the active match as a selection; it must not overwrite the system clipboard when
             * the user's copy-on-select preference is enabled.
             */
            if (searchActiveReference.current) return;
            if (!latestReference.current.copyOnSelect) return;
            // xterm's onSelectionChange callback cannot be async; TerminalSelectionClipboard already
            // reports its own write failures through the onFailure callback given to its constructor.
            // eslint-disable-next-line no-void -- intentional floating-promise discard, see above
            void selectionClipboard.copy(xterm.getSelection());
        });
        const unregisterSelectionHandlers = registerTerminalSelectionHandlers(terminalId, {
            copySelection: () => {
                const selection = xterm.getSelection();
                // eslint-disable-next-line no-void -- intentional floating-promise discard, see above
                if (selection) void selectionClipboard.copy(selection);
            },
            hasSelection: () => xterm.hasSelection(),
        });
        const pasteFromClipboard = async (): Promise<void> => {
            if (latestReference.current.processState !== 'running') return;
            try {
                const text = await navigator.clipboard.readText();
                if (text) xterm.paste(text);
            } catch (error) {
                onError(errorMessage(error, 'Terminal paste failed'));
            }
        };
        pasteReference.current = pasteFromClipboard;
        const unsubscribe = caxri.onEvent((event) => {
            if (event.event !== 'terminal.output' || event.payload.terminalId !== terminalId)
                return;
            replay.push(event.payload.data);
            /**
             * Runtime's `TerminalImageOutputFilter` now reports its own size-limit drops as an inline
             * `TERMINAL_IMAGE_OUTPUT_TRUNCATED_PLACEHOLDER` inside `data` above instead of folding them into this
             * counter, so a nonzero value here is genuine output-queue backpressure only.
             */
            if (event.payload.droppedBytes)
                replay.push(
                    `\r\n[${event.payload.droppedBytes} bytes dropped by output backpressure]`,
                );
        });
        const observer = new ResizeObserver(fitAndResize);
        let isAttachFocusSuperseded = false;
        let isTerminalReceivedFocus = false;
        const trackNewerFocus = (event: FocusEvent): void => {
            const target = event.target;
            if (!(target instanceof Node)) return;
            if (container.contains(target)) {
                isTerminalReceivedFocus = true;
                return;
            }
            if (isTerminalReceivedFocus && target !== document.body) isAttachFocusSuperseded = true;
        };
        const trackExplicitInteraction = (event: Event): void => {
            const target = event.target;
            if (target instanceof Node && !container.contains(target))
                isAttachFocusSuperseded = true;
        };
        document.addEventListener('focusin', trackNewerFocus);
        document.addEventListener('keydown', trackExplicitInteraction, { capture: true });
        document.addEventListener('pointerdown', trackExplicitInteraction, { capture: true });
        /**
         * Restore into the final visible grid instead of xterm's default 80x24 viewport.
         */
        const initialSize = fitToPane();
        const initialize = async (): Promise<void> => {
            let payload = '';
            try {
                const attachment = await caxri.request(
                    'terminal.attach',
                    initialSize ? { terminalId, ...initialSize } : { terminalId },
                );
                if (initialSize && latestReference.current.processState === 'running')
                    lastSentSize = initialSize;
                payload = attachment?.payload ?? '';
            } catch (error) {
                if (!isDisposed) onError(errorMessage(error, 'Terminal attachment failed'));
            }
            if (isDisposed) return;
            await replay.restoreInitial(payload);
            if (isDisposed) return;
            /**
             * Resize only after xterm has parsed the snapshot and every output event buffered behind it.
             */
            fitAndResize();
            observer.observe(container);
            container.dataset.terminalAttached = 'true';
            requestAnimationFrame(() => {
                document.removeEventListener('focusin', trackNewerFocus);
                document.removeEventListener('keydown', trackExplicitInteraction, true);
                document.removeEventListener('pointerdown', trackExplicitInteraction, true);
                if (isDisposed) return;
                /**
                 * Dialog teardown may restore focus before xterm ever receives it, which is not a newer user choice.
                 * After Terminal focus or an explicit pointer/key action, asynchronous attach completion must not
                 * reclaim focus from another control. A modal can also open before xterm ever receives focus, so its
                 * registry is the authoritative keyboard owner even when no prior Terminal focus was observed.
                 */
                if (
                    !isAttachFocusSuperseded &&
                    shouldAutoFocusTerminal({
                        active: latestReference.current.active,
                        focusedElement: document.activeElement as HTMLElement | null,
                        isModalOpen: useDialogStore.getState().isModalOpen(),
                        isRunning: latestReference.current.processState === 'running',
                        terminalId,
                    })
                )
                    xterm.focus();
            });
        };
        // Effects cannot be async themselves; initialize already reports its own failure via onError.
        // eslint-disable-next-line no-void -- intentional floating-promise discard, see above
        void initialize();

        return () => {
            isDisposed = true;
            delete container.dataset.terminalAttached;
            observer.disconnect();
            document.removeEventListener('focusin', trackNewerFocus);
            document.removeEventListener('keydown', trackExplicitInteraction, true);
            document.removeEventListener('pointerdown', trackExplicitInteraction, true);
            document.removeEventListener('visibilitychange', restoreRenderer);
            window.removeEventListener('focus', restoreRenderer);
            window.removeEventListener('pageshow', restoreRenderer);
            container.removeEventListener('paste', handlePaste, true);
            unsubscribe();
            progressDisposable.dispose();
            searchResultsDisposable.dispose();
            selectionDisposable.dispose();
            unregisterSelectionHandlers();
            if (pasteReference.current === pasteFromClipboard) pasteReference.current = undefined;
            dataDisposable.dispose();
            unregisterLinks();
            unregisterCommandNavigation();
            commandTracker.dispose();
            commandStatusElement.remove();
            unregisterTerminalImages();
            renderer.dispose();
            /**
             * Inactive tabs dispose their xterm pane too. TerminalProgressRegistry therefore reconciles against durable
             * Terminal records instead of treating pane disposal as close.
             */
            xterm.dispose();
            xtermReference.current = undefined;
            if (rendererReference.current === renderer) rendererReference.current = undefined;
            if (searchReference.current === search) searchReference.current = undefined;
            searchActiveReference.current = false;
            searchSignatureReference.current = '';
            if (replayReference.current === replay) replayReference.current = undefined;
            // A cleanup function cannot be async; a Runtime restart racing this teardown has no view
            // left to notify, so the detach failure is intentionally unobserved.
            // eslint-disable-next-line no-void -- intentional floating-promise discard, see above
            void detachTerminalQuietly(terminalId);
        };
    }, [fontsReady, terminalId]);

    useEffect(() => {
        rendererReference.current?.setPreference(gpuAcceleration);
    }, [gpuAcceleration]);

    useEffect(() => {
        if (processState !== 'running') clearTerminalProgress(terminalId);
    }, [processState, terminalId]);

    useEffect(() => {
        if (attachedEpochReference.current === attachEpoch) return;
        attachedEpochReference.current = attachEpoch;
        const replay = replayReference.current;
        const xterm = xtermReference.current;
        if (!replay || !xterm) return;
        /**
         * Runtime-owned attachment state is lost with the utility process even though this pane remains mounted.
         */
        const reattach = async (): Promise<void> => {
            try {
                await replay.reattach(async () => {
                    const attachment = await caxri.request(
                        'terminal.attach',
                        latestReference.current.processState === 'running'
                            ? { terminalId, cols: xterm.cols, rows: xterm.rows }
                            : { terminalId },
                    );
                    return attachment?.payload ?? '';
                });
            } catch (error) {
                onError(errorMessage(error, 'Terminal reattachment failed'));
            }
        };
        // Effects cannot be async themselves; the failure path above already reports the error.
        // eslint-disable-next-line no-void -- intentional floating-promise discard, see above
        void reattach();
    }, [attachEpoch, terminalId]);

    useEffect(() => {
        const xterm = xtermReference.current;
        const replay = replayReference.current;
        const previousProcessState = previousProcessStateReference.current;
        previousProcessStateReference.current = processState;
        if (!xterm) return;
        const isRunning = processState === 'running';
        xterm.options.disableStdin = !isRunning;
        reconcileTerminalProcessFocus({
            active,
            blur: () => xterm.blur(),
            focus: () => xterm.focus(),
            getFocusedElement: () => document.activeElement as HTMLElement | null,
            isModalOpen: () => useDialogStore.getState().isModalOpen(),
            isRunning,
            requestFrame: (callback) => requestAnimationFrame(callback),
            terminalId,
        });
        if (!replay || !shouldReconcileTerminalRecovery(previousProcessState, processState)) return;
        /**
         * The initial attach can finish before Runtime spawns a new, restarted, or resumed PTY. Reattach once at the
         * measured grid so Runtime resizes its parsed screen behind an ordering barrier, then replace any stale
         * persisted snapshot ahead of later live output.
         */
        const reattach = async (): Promise<void> => {
            try {
                await replay.reattach(async () => {
                    const attachment = await caxri.request('terminal.attach', {
                        terminalId,
                        cols: xterm.cols,
                        rows: xterm.rows,
                    });
                    return attachment?.payload ?? '';
                });
            } catch (error) {
                onError(errorMessage(error, 'Terminal recovery reconciliation failed'));
            }
        };
        // Effects cannot be async themselves; the failure path above already reports the error.
        // eslint-disable-next-line no-void -- intentional floating-promise discard, see above
        void reattach();
    }, [active, processState, terminalId]);

    useEffect(() => {
        if (!xtermReference.current) return;
        xtermReference.current.options.fontSize = fontSize;
        xtermReference.current.options.scrollback = scrollback;
        xtermReference.current.options.theme = terminalTheme;
    }, [fontSize, scrollback, terminalTheme]);

    useEffect(
        () => registerTerminalClearHandler(terminalId, () => xtermReference.current?.clear()),
        [terminalId],
    );

    const beginSearch = useCallback((): void => {
        searchActiveReference.current = true;
    }, []);

    const endSearch = useCallback((): void => {
        try {
            searchReference.current?.clearDecorations();
        } finally {
            searchActiveReference.current = false;
            searchSignatureReference.current = '';
            setSearchResults(emptySearchResults);
        }
    }, []);

    const find = useCallback(
        (
            direction: 'next' | 'previous',
            query: string,
            options: TerminalSearchOptions,
            isIncremental = false,
        ): void => {
            const search = searchReference.current;
            if (!search) return;
            searchActiveReference.current = true;
            const theme = latestReference.current.terminalTheme;
            const searchOptions: ISearchOptions = {
                ...options,
                incremental: isIncremental,
                ...(theme && {
                    decorations: {
                        activeMatchBackground: opaqueSearchColor(theme.yellow),
                        activeMatchBorder: opaqueSearchColor(theme.foreground),
                        activeMatchColorOverviewRuler: opaqueSearchColor(theme.yellow),
                        matchBackground: opaqueSearchColor(theme.selectionBackground),
                        matchBorder: opaqueSearchColor(theme.brightBlack),
                        matchOverviewRuler: opaqueSearchColor(theme.selectionBackground),
                    },
                }),
            };
            try {
                const signature = JSON.stringify([query, options, theme]);
                /**
                 * Addon-search beta updates its cached options before checking whether options changed, so toggling
                 * Match Case/Whole Word/Regex for the same query would retain stale decorations and counts. Clear only
                 * on an incremental signature change; explicit next/previous navigation must preserve the current
                 * result.
                 */
                if (isIncremental && signature !== searchSignatureReference.current)
                    search.clearDecorations();
                searchSignatureReference.current = signature;
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

    const focusTerminal = useCallback((): void => xtermReference.current?.focus(), []);

    const pasteFromClipboard = useCallback((): void => {
        // This wrapper is called from sync command/menu handlers; the underlying paste already
        // reports its own failure through onError.
        // eslint-disable-next-line no-void -- intentional floating-promise discard, see above
        void pasteReference.current?.();
    }, []);

    return {
        beginSearch,
        containerRef: containerReference,
        endSearch,
        find,
        focusTerminal,
        pasteFromClipboard,
        searchResults,
    };
}
