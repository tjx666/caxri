import { useCallback, useEffect, useRef, useState } from 'react';

import type {
    ProcessState,
    TerminalReferenceContext,
    TerminalReferenceLinkRule,
    TerminalSnapshot,
    ThemeTokens,
} from '@caxri/protocol';
import { errorMessage } from '@caxri/protocol';
import type { Terminal } from '@xterm/xterm';

import { useLatestReference } from '@/hooks/use-latest-reference';

import { translate } from '../../../i18n';
import { caxri } from '../../../lib/caxri';
import { useDialogStore } from '../../../stores/dialogs';
import { pushToast } from '../../../stores/toasts';
import { gpuIncidentBudget } from '../../gpu/gpu-incident-budget';
import {
    beginRendererPerformanceTerminalStage,
    recordRendererPerformanceTerminalAttachment,
} from '../../renderer-performance/controller';
import {
    createTerminalCommandStatusElement,
    formatTerminalCommandCompletionStatus,
    registerTerminalCommandNavigation,
    terminalCommandDecorationDefaultColor,
    terminalCommandDecorationFailedColor,
    terminalCommandDecorationSucceededColor,
    TerminalCommandTracker,
} from '../terminal-command-tracker';
import {
    attachTerminal,
    detachTerminalQuietly,
    prepareTerminalLongPaste,
    resizeTerminal,
} from '../terminal-commands';
import { loadTerminalFonts } from '../terminal-fonts';
import { createTerminalImageAddon, registerTerminalImageAddon } from '../terminal-images';
import {
    registerTerminalClipboardHandlers,
    terminalCommandKeyOwner,
    terminalKeyboardInput,
} from '../terminal-keyboard';
import { createTerminalLongPasteRuntime, longPasteFailureMessage } from '../terminal-long-paste';
import {
    markTerminalAttached,
    registerTerminalClearHandler,
    registerTerminalSelectionHandlers,
} from '../terminal-pane-handlers';
import {
    onError,
    reattachTerminalView,
    registerTerminalInputHandlers,
    registerTerminalPaneLinks,
    reportTerminalOperationError,
    xtermThemeWithoutOverviewRulerBorder,
} from '../terminal-pane-support';
import { createTerminalPaneXterm } from '../terminal-pane-xterm';
import { reconcileTerminalProcessFocus, shouldAutoFocusTerminal } from '../terminal-process-focus';
import { clearTerminalProgress, updateTerminalProgress } from '../terminal-progress';
import { shouldReconcileTerminalRecovery } from '../terminal-recovery';
import type { TerminalGpuAcceleration } from '../terminal-renderer';
import { TerminalRendererController } from '../terminal-renderer';
import { createTerminalRendererObserver } from '../terminal-renderer-observer';
import { TerminalBackpressureRecovery, TerminalReplayCoordinator } from '../terminal-replay';
import { TerminalSelectionClipboard } from '../terminal-selection-clipboard';
import {
    didTerminalSizeChange,
    TerminalPaneResizeController,
    TerminalResizeSettler,
} from '../terminal-size';
import { useTerminalPaneSearch } from './use-terminal-pane-search';
import {
    didHandleTerminalSizeOwnershipEvent,
    useTerminalSizeOwnership,
} from './use-terminal-size-ownership';
import { useTerminalVisibilityRestore } from './use-terminal-visibility-restore';

interface TerminalPaneRuntimeOptions {
    canAcceptAgentInput: boolean;
    active: boolean;
    attachEpoch: number;
    copyOnSelect: boolean;
    /**
     * `--danger` token, resolved to hex by the theme store; see `terminalCommandDecorationFailedColor`.
     */
    dangerColor: string | undefined;
    fontFamily: string;
    fontSize: number;
    gpuAcceleration: TerminalGpuAcceleration;
    githubRepositories: TerminalReferenceContext['githubRepositories'];
    imagePasteInput?: string;
    /**
     * Whether this pane's Workbench is the one on screen. A kept-alive Session stays mounted but hidden; its Terminals
     * keep every byte of state and give up only their GPU context.
     */
    isPaneVisible: boolean;
    longPasteThreshold: number;
    osc52ClipboardWrite: boolean;
    processState: ProcessState;
    projectRoot: string;
    referenceLinks: TerminalReferenceLinkRule[];
    scrollback: number;
    /**
     * `--success` token, resolved to hex by the theme store; see `terminalCommandDecorationSucceededColor`.
     */
    successColor: string | undefined;
    terminalCwd: string;
    terminalId: string;
    terminalTheme: ThemeTokens['terminal'] | undefined;
    wordSeparators: string;
}

/**
 * Owns the imperative xterm lifecycle so TerminalPane stays a small presentation component.
 */
export function useTerminalPaneRuntime({
    canAcceptAgentInput,
    active,
    attachEpoch,
    copyOnSelect,
    dangerColor,
    fontFamily,
    fontSize,
    gpuAcceleration,
    githubRepositories,
    imagePasteInput,
    isPaneVisible,
    longPasteThreshold,
    osc52ClipboardWrite,
    processState,
    projectRoot,
    referenceLinks,
    scrollback,
    successColor,
    terminalCwd,
    terminalId,
    terminalTheme,
    wordSeparators,
}: TerminalPaneRuntimeOptions) {
    const containerReference = useRef<HTMLDivElement>(null);
    const xtermReference = useRef<Terminal | undefined>(undefined);
    const fitAndResizeReference = useRef<(() => void) | undefined>(undefined);
    const resizeControllerReference = useRef<TerminalPaneResizeController | undefined>(undefined);
    /**
     * Context-menu Paste reads this effect-owned ref instead of capturing xterm across attach epochs.
     */
    const pasteReference = useRef<(() => Promise<void>) | undefined>(undefined);
    const replayReference = useRef<TerminalReplayCoordinator | undefined>(undefined);
    const rendererReference = useRef<TerminalRendererController | undefined>(undefined);
    /**
     * Whether this pane has been off screen since it was built, so a return can be counted as a reuse rather than as
     * the mount's own attachment.
     */
    const wasSuspendedReference = useRef(false);
    const [fontsReady, setFontsReady] = useState(false);
    const [longPasteState, setLongPasteState] = useState({ id: terminalId, pending: false });
    const longPastePending = longPasteState.id === terminalId && longPasteState.pending;
    const sizeOwnership = useTerminalSizeOwnership(terminalId, attachEpoch, processState);
    const attachedEpochReference = useRef(attachEpoch);
    const previousProcessStateReference = useRef(processState);
    const latestReference = useLatestReference({
        canAcceptAgentInput,
        active,
        copyOnSelect,
        dangerColor,
        fontFamily,
        fontSize,
        gpuAcceleration,
        githubRepositories,
        imagePasteInput,
        isAgent: canAcceptAgentInput,
        longPastePending,
        longPasteThreshold,
        osc52ClipboardWrite,
        processState,
        projectRoot,
        referenceContext: { githubRepositories, rules: referenceLinks },
        referenceLinks,
        scrollback,
        successColor,
        terminalCwd,
        terminalId,
        terminalTheme,
        wordSeparators,
    });
    const {
        createSearchAddon,
        endSearch,
        find,
        isSearchSelection,
        registerSearchAddon,
        searchResults,
    } = useTerminalPaneSearch(latestReference);

    useEffect(() => {
        let isCanceled = false;
        const load = async (): Promise<void> => {
            try {
                await loadTerminalFonts();
            } catch (error) {
                onError(errorMessage(error, translate('terminal.errors.fontsFailed')));
            }
            /**
             * A corrupt font must degrade to the system monospace stack instead of blocking the PTY. After the
             * try/catch rather than in a `finally`, which React Compiler cannot lower; the catch never rethrows.
             */
            if (!isCanceled) setFontsReady(true);
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
        /**
         * One bounded sentinel match distinguishes exactly-at-limit from overflow without parsing Terminal text outside
         * xterm's Unicode- and wrap-aware search engine.
         */
        const search = createSearchAddon();
        const { fit, progress, xterm } = createTerminalPaneXterm({
            container,
            initial: latest,
            latest: () => latestReference.current,
            search,
        });
        const commandStatusElement = createTerminalCommandStatusElement();
        container.append(commandStatusElement);
        let previousCompletedCommandCount = 0;
        const commandTracker = new TerminalCommandTracker(
            xterm,
            // VS Code registers a `terminalCommandDecoration.*` color per theme (dark/light/HC) rather than one fixed
            // hex; deriving these from the workbench `--danger` / `--success` tokens is the token-driven equivalent
            // (see terminal-command-tracker.ts).
            {
                failed: terminalCommandDecorationFailedColor(latest.dangerColor),
                running: terminalCommandDecorationDefaultColor(latest.terminalTheme?.foreground),
                succeeded: terminalCommandDecorationSucceededColor(latest.successColor),
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
            (status) => (commandStatusElement.textContent = status),
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
        const unregisterSearchAddon = registerSearchAddon(search);
        const progressDisposable = progress.onChange((update) => {
            /**
             * A stopped Terminal has no process that can own progress, including while its visual history is restored.
             */
            if (latestReference.current.processState !== 'running') {
                clearTerminalProgress(terminalId);
                return;
            }
            updateTerminalProgress(terminalId, update);
        });
        const terminalLinks = registerTerminalPaneLinks(xterm, () => latestReference.current);
        let isDisposed = false;
        const longPasteRuntime = createTerminalLongPasteRuntime({
            latest: () => latestReference.current,
            /**
             * The controller drops (rather than queues) a paste that arrives while a previous long paste is still being
             * saved, so this toast is the user's only feedback that their paste was discarded.
             */
            onDropped: () => pushToast('info', translate('terminal.longPaste.previousPending')),
            onFailure: (reason) => onError(longPasteFailureMessage(reason)),
            onPendingChange: (pending, shouldDisableStdin) => {
                xterm.options.disableStdin = shouldDisableStdin;
                setLongPasteState({ id: terminalId, pending });
            },
            paste: (text) => xterm.paste(text),
            request: (content) => prepareTerminalLongPaste(terminalId, content),
        });
        const longPaste = longPasteRuntime.controller;
        xterm.attachCustomKeyEventHandler((event) => {
            /**
             * A modal owns the keyboard for as long as it is open: the same rule `workbench-root-prompt-keyboard.ts`
             * and `sidebar-detail-card-dismissal.ts` already follow. Focus can still be sitting in this Terminal when
             * one opens: Sonner's toaster restores focus to whatever held it before the toast was focused, so clicking
             * a toast action that opens a confirmation hands focus straight back here. xterm's own `_keyDown` calls
             * `stopPropagation()` for keys it claims, including `Escape`, and the dialog's dismissal listener sits on
             * `document` in the bubble phase, so a swallowed `Escape` never reaches the dialog and it cannot be closed
             * by keyboard at all. Returning `false` bails out before xterm touches the event, which keeps both halves
             * out of the Terminal: nothing reaches the PTY, and nothing is stopped on its way to the modal. It also
             * suppresses the `focus()` xterm performs on `keyup`, which would otherwise pull focus back again.
             */
            if (useDialogStore.getState().isModalOpen()) return false;
            const commandKeyOwner = terminalCommandKeyOwner(event, xterm.hasSelection());
            if (commandKeyOwner === 'select-all') xterm.selectAll();
            if (commandKeyOwner !== 'xterm') return false;
            const input = terminalKeyboardInput(
                event,
                latestReference.current.canAcceptAgentInput && !longPaste.isPending(),
            );
            if (!input) return true;
            event.preventDefault();
            event.stopPropagation();
            xterm.input(input);
            return false;
        });
        const unregisterClipboardHandlers = registerTerminalClipboardHandlers({
            canAcceptAgentInput: () => latestReference.current.canAcceptAgentInput,
            container,
            document,
            getSelection: () => xterm.getSelection(),
            imagePasteInput: () => latestReference.current.imagePasteInput,
            pasteImage: (input) => xterm.input(input),
            pasteText: (text) => longPaste.intercept(text),
        });
        xtermReference.current = xterm;
        const resizeController = new TerminalPaneResizeController({
            apply: ({ cols, rows }) => xterm.resize(cols, rows),
            current: () => ({ cols: xterm.cols, rows: xterm.rows }),
            fitted: ({ cols, rows }) => (container.dataset.terminalGrid = `${cols}x${rows}`),
            isRunning: () => latestReference.current.processState === 'running',
            /**
             * A pane with no layout box yet has the fit addon read its parent's height as `auto` and propose `NaN`
             * columns; sent to the PTY, that would reflow its whole buffer, so it proposes nothing until it has a size.
             * A Session kept alive off screen keeps its box (`content-visibility: hidden`, see `workbench.tsx`).
             */
            propose: () =>
                container.offsetWidth > 0 && container.offsetHeight > 0
                    ? fit.proposeDimensions()
                    : undefined,
            request: (size) => resizeTerminal(terminalId, size),
            terminalId,
        });
        resizeControllerReference.current = resizeController;
        const resizeSettler = new TerminalResizeSettler(() => resizeController.fitAndResize());
        const scheduleResize = (): void => resizeSettler.schedule();
        fitAndResizeReference.current = scheduleResize;
        const rendererObserver = createTerminalRendererObserver({
            container,
            current: () => latestReference.current,
            retry: () => rendererReference.current?.retryFromUser() ?? false,
            terminalId,
        });
        const renderer = new TerminalRendererController(
            xterm,
            (intent) => {
                /**
                 * DOM and WebGL can measure different cell grids. Route renderer changes through the paused resize
                 * settler so snapshot replay finishes before xterm and its PTY receive the new grid together.
                 */
                if (intent === 'grid-sync') scheduleResize();
                xterm.refresh(0, xterm.rows - 1);
            },
            (status) => rendererObserver.publish(status),
            {
                beginActivationMeasurement: () =>
                    beginRendererPerformanceTerminalStage('webgl-attach'),
                policy: gpuIncidentBudget,
            },
        );
        rendererReference.current = renderer;
        renderer.setPreference(latest.gpuAcceleration);
        const unregisterInputHandlers = registerTerminalInputHandlers(
            xterm,
            terminalId,
            () => latestReference.current.processState === 'running' && !longPaste.isPending(),
            longPasteRuntime.expectedAgentLaunchId,
        );
        let isClipboardFailureReported = false;
        const selectionClipboard = new TerminalSelectionClipboard(
            (value) => navigator.clipboard.writeText(value),
            (error) => {
                if (isClipboardFailureReported) return;
                isClipboardFailureReported = true;
                onError(errorMessage(error, translate('terminal.errors.copyFailed')));
            },
        );
        const selectionDisposable = xterm.onSelectionChange(() => {
            /**
             * SearchAddon represents the active match as a selection; it must not overwrite the system clipboard when
             * the user's copy-on-select preference is enabled. The guard covers the addon's own searches: explicit
             * navigation and the re-search it runs after Terminal output or a resize, so a mouse selection made while
             * the search bar is open still copies.
             */
            if (isSearchSelection()) return;
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
                await longPaste.pasteFromClipboard(() => navigator.clipboard.readText());
            } catch (error) {
                onError(errorMessage(error, translate('terminal.errors.pasteFailed')));
            }
        };
        pasteReference.current = pasteFromClipboard;
        const observer = new ResizeObserver(scheduleResize);
        const backpressureRecovery: { current?: TerminalBackpressureRecovery } = {};
        const replay = new TerminalReplayCoordinator(
            (value) =>
                new Promise<void>((resolve) => {
                    if (isDisposed) resolve();
                    else xterm.write(value, resolve);
                }),
            () => {
                if (!isDisposed) xterm.reset();
            },
            {
                beginSnapshot: () => {
                    resizeSettler.pause();
                    resizeController.pause();
                },
                finishSnapshot: () => {
                    if (isDisposed) return;
                    observer.observe(container);
                    resizeController.resume();
                    resizeSettler.resume();
                },
                prepareSnapshot: ({ cols, rows }) => {
                    if (
                        didTerminalSizeChange(
                            { cols: xterm.cols, rows: xterm.rows },
                            { cols, rows },
                        )
                    )
                        xterm.resize(cols, rows);
                },
                restoreSnapshotLinks: ({ oscLinks }) =>
                    terminalLinks.restoreOscLinks(oscLinks ?? []),
                onDroppedOutput: () => backpressureRecovery.current?.request(),
            },
        );
        backpressureRecovery.current = new TerminalBackpressureRecovery(
            () =>
                replay.reattach(() =>
                    attachTerminal(terminalId, { cols: xterm.cols, rows: xterm.rows }),
                ),
            (error) => reportTerminalOperationError(error, 'terminal.errors.outputRecoveryFailed'),
        );
        replayReference.current = replay;
        const unsubscribe = caxri.onEvent((event) => {
            if (event.event === 'gpu.recoveryRequested') {
                const wasFocused = container.contains(document.activeElement);
                rendererObserver.withRecovery(event.payload.correlationId, () =>
                    renderer.recoverFromGpuProcessLoss(),
                );
                if (wasFocused) xterm.focus();
                return;
            }
            if (
                didHandleTerminalSizeOwnershipEvent(
                    event,
                    terminalId,
                    resizeController,
                    sizeOwnership,
                )
            )
                return;
            if (event.event !== 'terminal.output' || event.payload.terminalId !== terminalId)
                return;
            rendererObserver.recordOutput(event.payload.data, event.payload.droppedBytes ?? 0);
            /**
             * Server's `TerminalImageOutputFilter` now reports its own size-limit drops as an inline
             * `TERMINAL_IMAGE_OUTPUT_TRUNCATED_PLACEHOLDER` inside `data` above instead of folding them into this
             * counter, so a nonzero value here is genuine output-queue backpressure only.
             */
            if (event.payload.droppedBytes) {
                backpressureRecovery.current?.request();
                return;
            }
            replay.push(event.payload.data);
        });
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
        const initialSize = resizeController.fitInitial();
        const initialize = async (): Promise<void> => {
            resizeSettler.pause();
            resizeController.pause();
            let attachment: TerminalSnapshot | null = null;
            let isAttached = false;
            // The Server round trip plus the buffer rewrite: the cost a kept-alive Session is meant to avoid entirely,
            // and the one the user sees as the Terminal "flashing" on a switch.
            const settleSnapshotReplay = beginRendererPerformanceTerminalStage('snapshot-replay');
            try {
                attachment = await attachTerminal(terminalId, initialSize);
                isAttached = true;
            } catch (error) {
                if (!isDisposed)
                    reportTerminalOperationError(error, 'terminal.errors.attachFailed');
            }
            // After the try/catch: React Compiler cannot lower a logical expression inside one.
            if (isAttached && initialSize && latestReference.current.processState === 'running')
                resizeController.confirmSent(initialSize);
            if (isDisposed) {
                settleSnapshotReplay();
                return;
            }
            await replay.restoreInitial(attachment);
            settleSnapshotReplay();
            // TS narrows `isDisposed` to `false` here because it cannot see the `dispose()` closure reassigning it
            // during the `await` above; the pane can genuinely be torn down while `restoreInitial` is in flight.
            // oxlint-disable-next-line typescript/no-unnecessary-condition -- see comment above
            if (isDisposed) return;
            container.dataset.terminalAttached = 'true';
            // A failed attach leaves Server without an attachment id, so command input must keep waiting.
            if (isAttached) markTerminalAttached(terminalId, true);
            // Built from nothing: the expensive half of a Session switch, and the half the keep-alive removes.
            recordRendererPerformanceTerminalAttachment(false);
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
            longPaste.dispose();
            delete container.dataset.terminalAttached;
            markTerminalAttached(terminalId, false);
            observer.disconnect();
            resizeSettler.dispose();
            resizeController.dispose();
            if (resizeControllerReference.current === resizeController)
                resizeControllerReference.current = undefined;
            document.removeEventListener('focusin', trackNewerFocus);
            document.removeEventListener('keydown', trackExplicitInteraction, true);
            document.removeEventListener('pointerdown', trackExplicitInteraction, true);
            unregisterClipboardHandlers();
            unsubscribe();
            backpressureRecovery.current?.dispose();
            replay.dispose();
            progressDisposable.dispose();
            unregisterSearchAddon();
            selectionDisposable.dispose();
            unregisterSelectionHandlers();
            unregisterInputHandlers();
            if (pasteReference.current === pasteFromClipboard) pasteReference.current = undefined;
            terminalLinks.dispose();
            unregisterCommandNavigation();
            commandTracker.dispose();
            commandStatusElement.remove();
            unregisterTerminalImages();
            rendererObserver.dispose();
            renderer.dispose();
            /**
             * Inactive tabs dispose their xterm pane too. TerminalProgressRegistry therefore reconciles against durable
             * Terminal records instead of treating pane disposal as close.
             */
            xterm.dispose();
            xtermReference.current = undefined;
            if (fitAndResizeReference.current === scheduleResize)
                fitAndResizeReference.current = undefined;
            if (rendererReference.current === renderer) rendererReference.current = undefined;
            if (replayReference.current === replay) replayReference.current = undefined;
            // A cleanup function cannot be async; a Server restart racing this teardown has no view
            // left to notify, so the detach failure is intentionally unobserved.
            // eslint-disable-next-line no-void -- intentional floating-promise discard, see above
            void detachTerminalQuietly(terminalId);
        };
        // eslint-disable-next-line react-hooks/exhaustive-deps -- `latestReference` is a stable ref object, intentionally excluded
    }, [fontsReady, sizeOwnership.onSizeOwnership, sizeOwnership.onTerminalExit, terminalId]);
    useEffect(() => {
        rendererReference.current?.setPreference(gpuAcceleration);
    }, [gpuAcceleration]);
    /**
     * Follows the pane off and back onto the screen while it stays mounted, which is what a Session kept alive in the
     * background does (issue #657). Suspending releases only the GPU context; the xterm buffer, scroll position, PTY
     * subscription, and Agent lifecycle are untouched, so coming back is a redraw rather than a rebuild. The re-fit is
     * required because a hidden Session skips layout (`content-visibility: hidden`): a window resized meanwhile never
     * reached this pane, so its grid may not match the window it returns to.
     */
    useEffect(() => {
        const renderer = rendererReference.current;
        if (!renderer) return;
        if (!isPaneVisible) {
            wasSuspendedReference.current = true;
            renderer.suspend();
            return;
        }
        renderer.resume();
        fitAndResizeReference.current?.();
        // Only a pane that actually left the screen was reused; a first mount already counted itself as an attachment.
        if (!wasSuspendedReference.current) return;
        wasSuspendedReference.current = false;
        recordRendererPerformanceTerminalAttachment(true);
    }, [fontsReady, isPaneVisible, terminalId]);
    useTerminalVisibilityRestore(terminalId, rendererReference);
    useEffect(() => {
        if (processState !== 'running') clearTerminalProgress(terminalId);
    }, [processState, terminalId]);
    useEffect(() => {
        if (attachedEpochReference.current === attachEpoch) return;
        attachedEpochReference.current = attachEpoch;
        resizeControllerReference.current?.resetSizeOwnership();
        const replay = replayReference.current;
        const xterm = xtermReference.current;
        if (!replay || !xterm) return;
        // Server-owned attachment state is lost with the utility process even though this pane remains mounted.
        // Effects cannot be async themselves; `reattachTerminalView` reports its own failure.
        // eslint-disable-next-line no-void -- intentional floating-promise discard, see above
        void reattachTerminalView(
            terminalId,
            replay,
            () =>
                latestReference.current.processState === 'running'
                    ? { cols: xterm.cols, rows: xterm.rows }
                    : undefined,
            'terminal.errors.reattachFailed',
        );
    }, [attachEpoch, latestReference, terminalId]);

    useEffect(() => {
        const xterm = xtermReference.current;
        const replay = replayReference.current;
        const previousProcessState = previousProcessStateReference.current;
        previousProcessStateReference.current = processState;
        if (!xterm) return;
        const isRunning = processState === 'running';
        if (!isRunning) resizeControllerReference.current?.resetSizeOwnership();
        xterm.options.disableStdin = !isRunning || longPastePending;
        const invalidateFocus = reconcileTerminalProcessFocus({
            active,
            blur: () => xterm.blur(),
            focus: () => xterm.focus(),
            getFocusedElement: () => document.activeElement as HTMLElement | null,
            isModalOpen: () => useDialogStore.getState().isModalOpen(),
            isRunning,
            requestFrame: (callback) => requestAnimationFrame(callback),
            terminalId,
        });
        if (!replay || !shouldReconcileTerminalRecovery(previousProcessState, processState))
            return invalidateFocus;
        /**
         * The initial attach can finish before Server spawns a new, restarted, or resumed PTY. Reattach once at the
         * measured grid so Server resizes its parsed screen behind an ordering barrier, then replace any stale
         * persisted snapshot ahead of later live output.
         */
        // Effects cannot be async themselves; `reattachTerminalView` reports its own failure.
        // eslint-disable-next-line no-void -- intentional floating-promise discard, see above
        void reattachTerminalView(
            terminalId,
            replay,
            () => ({ cols: xterm.cols, rows: xterm.rows }),
            'terminal.errors.recoveryFailed',
        );
        return invalidateFocus;
    }, [active, longPastePending, processState, terminalId]);

    useEffect(() => {
        const xterm = xtermReference.current;
        if (!xterm) return;
        xterm.options.fontFamily = fontFamily;
        xterm.options.fontSize = fontSize;
        xterm.options.scrollback = scrollback;
        xterm.options.theme = xtermThemeWithoutOverviewRulerBorder(terminalTheme);
        xterm.options.wordSeparator = wordSeparators;
    }, [fontFamily, fontSize, scrollback, terminalTheme, wordSeparators]);

    useEffect(() => {
        /**
         * Xterm applies a font option to the DOM before its cell metrics settle. Refit on the next paint so a split
         * Terminal cannot keep the previous font's narrow PTY grid after Settings changes.
         */
        const frame = requestAnimationFrame(() => fitAndResizeReference.current?.());
        return () => cancelAnimationFrame(frame);
    }, [fontFamily, fontSize]);

    useEffect(
        () => registerTerminalClearHandler(terminalId, () => xtermReference.current?.clear()),
        [terminalId],
    );
    const focusTerminal = useCallback((): void => xtermReference.current?.focus(), []);
    const getFocusElement = useCallback(
        (): HTMLElement | null => xtermReference.current?.textarea ?? null,
        [],
    );
    const pasteFromClipboard = useCallback((): void => {
        // Sync command handlers float this promise; its own path reports failures through onError.
        // eslint-disable-next-line no-void -- intentional floating-promise discard, see above
        void pasteReference.current?.();
    }, []);
    return {
        containerRef: containerReference,
        endSearch,
        find,
        focusTerminal,
        getFocusElement,
        longPastePending,
        mobileSizeOwnership: sizeOwnership.mobileSizeOwnership,
        pasteFromClipboard,
        searchResults,
    };
}
