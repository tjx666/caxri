import { useCallback, useEffect, useLayoutEffect, useRef, useState } from 'react';

import * as Clipboard from 'expo-clipboard';

import { useMobileClient } from '../connection/mobile-client-provider';
import { MobileGatewayRequestError } from '../connection/mobile-gateway-client';
import type { LiveTerminalState } from './control-availability';
import {
    canUseTerminalControls,
    shouldObserveTerminal,
    terminalViewState,
} from './control-availability';
import type { TerminalControlTarget } from './control-input';
import { chunkTerminalText, sendTerminalControlInput } from './control-input';
import type { TerminalKey } from './key-input';
import { controlByteFor, pressTerminalKey } from './key-input';
import { canAdoptTerminalLease } from './lease-admission';
import { createTerminalOutputQueue } from './output-queue';
import type { TerminalResyncReason } from './resync-policy';
import { terminalResyncPlan } from './resync-policy';
import { createTerminalStreamAssembly } from './stream-assembly';
import type { TerminalWebviewCommand } from './webview-bridge';
import { parseTerminalWebviewMessage, terminalWebviewCommandScript } from './webview-bridge';
import { canForwardTerminalWheel, createTerminalWheelForwarder } from './wheel-queue';

type TerminalWebviewPayload = TerminalWebviewCommand extends infer Command
    ? Command extends TerminalWebviewCommand
        ? Omit<Command, 'terminalId' | 'version'>
        : never
    : never;

const MAX_PENDING_OUTPUT_BYTES = 4 * 1_024 * 1_024;

const controlError = (error: unknown): string => {
    if (error instanceof MobileGatewayRequestError) {
        if (error.code === 'FORBIDDEN')
            return 'This device cannot control the Terminal. Pair it again with control access.';
        if (error.code === 'CONFLICT') return 'The Terminal changed. Reopen it before sending.';
        return error.message;
    }
    return "Couldn't confirm delivery. Check the Terminal before sending again.";
};

const unsubscribeQuietly = async (handle: { unsubscribe(): Promise<void> }): Promise<void> => {
    try {
        await handle.unsubscribe();
    } catch {
        // The Server also retires subscriptions on connection loss.
    }
};

/**
 * The subscription effect cancels this retry timer whenever its resource identity changes.
 */
const scheduleTerminalRetry = (
    attempt: number,
    onRetry: () => void,
): ReturnType<typeof setTimeout> => {
    const delay = Math.min(10_000, 500 * 2 ** Math.min(5, attempt));
    return setTimeout(onRetry, delay);
};

/**
 * Start of every Terminal's typed-input chain; shared so the ref initializer allocates nothing per render.
 */
const SETTLED_INPUT = Promise.resolve();

export const useLiveTerminal = ({
    injectScript,
    isConnected,
    onTap,
    isStopped,
    role,
    terminalId,
    visible,
}: {
    injectScript: (script: string) => void;
    isConnected: boolean;
    /**
     * A deliberate tap on the Terminal surface, used to raise the keyboard while this phone holds the lease.
     */
    onTap?: () => void;
    isStopped: boolean;
    role: 'view' | 'reply' | 'control' | null;
    terminalId: string;
    visible: boolean;
}) => {
    const { connectionEpoch, request, subscribe, subscriptionAvailable } = useMobileClient();
    const subscription = useRef<{ subscriptionId: string; unsubscribe(): Promise<void> } | null>(
        null,
    );
    const generation = useRef<number | null>(null);
    const size = useRef<{ cols: number; rows: number } | null>(null);
    const lease = useRef<TerminalControlTarget | null>(null);
    const [outbound] = useState(() => createTerminalOutputQueue(MAX_PENDING_OUTPUT_BYTES));
    const outboundFrame = useRef<number | null>(null);
    const retries = useRef(0);
    const inputChain = useRef<Promise<void>>(SETTLED_INPUT);
    const resizeTimer = useRef<ReturnType<typeof setTimeout> | undefined>(undefined);
    const lifetime = useRef(0);
    const context = useRef({ isConnected, role, visible, subscriptionAvailable });
    const webviewValid = useRef(false);
    const [webviewReady, setWebviewReady] = useState(false);
    const [webviewGeneration, setWebviewGeneration] = useState(0);
    const [state, setState] = useState<LiveTerminalState>('loading');
    const [error, setError] = useState<string | null>(null);
    const [atBottom, setAtBottom] = useState(true);
    const [hasLease, setHasLease] = useState(false);
    const [hasSize, setHasSize] = useState(false);
    const [ctrl, setCtrl] = useState(false);
    const [retry, setRetry] = useState(0);
    const [currentGeneration, setCurrentGeneration] = useState<number | null>(null);
    const [hasSubscription, setHasSubscription] = useState(false);

    const invalidateWebview = useCallback((): void => {
        webviewValid.current = false;
        generation.current = null;
        lifetime.current += 1;
        setWebviewReady(false);
        setState('loading');
        size.current = null;
        setHasSize(false);
    }, []);

    /**
     * Recreate the native document rather than reloading a terminated Android WebView.
     * https://developer.android.com/develop/ui/views/layout/webapps/handle-termination
     */
    const onWebviewTerminated = useCallback((): void => {
        invalidateWebview();
        setWebviewGeneration((current) => current + 1);
    }, [invalidateWebview]);

    useLayoutEffect(() => {
        context.current = { isConnected, role, visible, subscriptionAvailable };
    }, [isConnected, role, subscriptionAvailable, visible]);

    const sendWebview = useCallback(
        (command: TerminalWebviewPayload): void => {
            injectScript(terminalWebviewCommandScript({ ...command, version: 1, terminalId }));
        },
        [injectScript, terminalId],
    );
    const appendOutput = useCallback(
        (data: string): boolean => {
            if (!outbound.push(chunkTerminalText(data))) return false;
            if (outboundFrame.current !== null) return true;
            const drain = (): void => {
                outboundFrame.current = null;
                for (let count = 0; count < 4; count += 1) {
                    const next = outbound.shift();
                    if (next === undefined) break;
                    sendWebview({ type: 'append', data: next });
                }
                if (outbound.length > 0) outboundFrame.current = requestAnimationFrame(drain);
            };
            outboundFrame.current = requestAnimationFrame(drain);
            return true;
        },
        [outbound, sendWebview],
    );
    /**
     * Tells the document whether it draws the phone's own grid with a live cursor, and whether drags may scroll an
     * alternate-screen application. Sent with every snapshot, which follows a new document and a role change, and at
     * each lease transition.
     */
    const sendControl = useCallback(
        (isLeased: boolean): void => {
            const canForwardScroll = canForwardTerminalWheel(context.current.role);
            sendWebview({
                type: 'control',
                canForwardScroll,
                isLeased: isLeased && canForwardScroll,
            });
        },
        [sendWebview],
    );
    const resetOutput = useCallback(
        (cols: number, rows: number, data: string): boolean => {
            if (outboundFrame.current !== null) cancelAnimationFrame(outboundFrame.current);
            outboundFrame.current = null;
            outbound.clear();
            sendWebview({ type: 'reset', cols, rows });
            sendControl(lease.current !== null);
            return appendOutput(data);
        },
        [appendOutput, outbound, sendControl, sendWebview],
    );

    useEffect(() => {
        let isActive = true;
        let isStreamActive = true;
        let ownedHandle: { subscriptionId: string; unsubscribe(): Promise<void> } | null = null;
        let retryTimer: ReturnType<typeof setTimeout> | undefined;
        const assembly = createTerminalStreamAssembly(terminalId);
        const scheduleResync = (reason: TerminalResyncReason = 'local'): void => {
            if (!isActive || retryTimer !== undefined) return;
            const plan = terminalResyncPlan(reason);
            isStreamActive = false;
            assembly.invalidate();
            if (outboundFrame.current !== null) cancelAnimationFrame(outboundFrame.current);
            outboundFrame.current = null;
            outbound.clear();
            if (plan.showStale) setState('stale');
            generation.current = null;
            setCurrentGeneration(null);
            setHasSubscription(false);
            const heldLease = lease.current;
            lease.current = null;
            if (heldLease) {
                setHasLease(false);
                sendControl(false);
                // eslint-disable-next-line no-void -- Unsubscribe and Server lease cleanup remain the final fallback.
                void request('mobile.terminal.release', heldLease).catch(() => {});
            }
            if (ownedHandle) {
                // eslint-disable-next-line no-void -- The old stream is invalid immediately after a gap.
                void unsubscribeQuietly(ownedHandle);
                ownedHandle = null;
                subscription.current = null;
            }
            if (plan.useBackoff)
                retryTimer = scheduleTerminalRetry(retries.current++, () => {
                    if (isActive) setRetry((current) => current + 1);
                });
            else setRetry((current) => current + 1);
        };
        if (shouldObserveTerminal({ isStopped, subscriptionAvailable, visible, webviewReady })) {
            // eslint-disable-next-line no-void -- The effect owns the bounded subscription and its cleanup.
            void subscribe({ kind: 'terminal', terminalId }, (message) => {
                if (!isActive || !isStreamActive || !webviewValid.current) return;
                if (message.kind === 'resync-required') {
                    scheduleResync(message.reason);
                    return;
                }
                if (message.type !== 'stream') return;
                const result = assembly.receive(message);
                if (result.kind === 'resync') {
                    scheduleResync();
                    return;
                }
                if (result.kind === 'snapshot') {
                    generation.current = result.generation;
                    setCurrentGeneration(result.generation);
                    retries.current = 0;
                    const snapshot = result.snapshot;
                    if (
                        !resetOutput(
                            snapshot?.cols ?? 80,
                            snapshot?.rows ?? 24,
                            snapshot?.payload ?? '',
                        )
                    ) {
                        scheduleResync();
                        return;
                    }
                    setState(snapshot ? (isStopped ? 'stopped' : 'ready') : 'unavailable');
                    setError(null);
                } else if (result.kind === 'output' && !appendOutput(result.data)) scheduleResync();
            })
                .then((handle) => {
                    if (!isActive || !isStreamActive) {
                        // eslint-disable-next-line no-void -- The stale handle belongs to the completed subscription setup.
                        void unsubscribeQuietly(handle);
                        return;
                    }
                    ownedHandle = handle;
                    subscription.current = handle;
                    setHasSubscription(true);
                })
                .catch(() => {
                    if (!isActive) return;
                    setState('error');
                    scheduleResync();
                });
        }
        return () => {
            isActive = false;
            isStreamActive = false;
            assembly.invalidate();
            if (outboundFrame.current !== null) cancelAnimationFrame(outboundFrame.current);
            outboundFrame.current = null;
            outbound.clear();
            lifetime.current += 1;
            clearTimeout(retryTimer);
            generation.current = null;
            setCurrentGeneration(null);
            setHasSubscription(false);
            const ownedLease = lease.current;
            lease.current = null;
            if (ownedLease) {
                setHasLease(false);
                sendControl(false);
                // eslint-disable-next-line no-void -- Server also releases on unsubscribe and disconnect.
                void request('mobile.terminal.release', ownedLease).catch(() => {});
            }
            const handle = subscription.current;
            subscription.current = null;
            if (handle) {
                // eslint-disable-next-line no-void -- Server tears down the observer even if this best-effort ACK is lost.
                void handle.unsubscribe().catch(() => {});
            }
        };
    }, [
        appendOutput,
        connectionEpoch,
        isStopped,
        outbound,
        request,
        resetOutput,
        retry,
        role,
        sendControl,
        subscribe,
        subscriptionAvailable,
        terminalId,
        visible,
        webviewReady,
    ]);

    useEffect(
        () => () => {
            if (outboundFrame.current !== null) cancelAnimationFrame(outboundFrame.current);
            clearTimeout(resizeTimer.current);
        },
        [],
    );

    const leased = hasLease && role === 'control';

    const currentTarget = (): TerminalControlTarget | null => {
        const handle = subscription.current;
        const currentGeneration = generation.current;
        if (
            !handle ||
            currentGeneration === null ||
            !webviewValid.current ||
            !canUseTerminalControls({
                connected: isConnected,
                generation: currentGeneration,
                hasSubscription: true,
                role,
                state,
            })
        )
            return null;
        return {
            terminalId,
            subscriptionId: handle.subscriptionId,
            expectedGeneration: currentGeneration,
        };
    };

    const targetReference = useRef(currentTarget);
    useLayoutEffect(() => {
        targetReference.current = currentTarget;
    });
    /**
     * Created on the first forwarded drag so the queue's sender reads the latest target only from event handlers.
     */
    const wheel = useRef<ReturnType<typeof createTerminalWheelForwarder> | null>(null);

    const sendInput = async (data: string): Promise<'sent' | 'blocked'> => {
        const target = currentTarget();
        if (!target) return 'blocked';
        try {
            await sendTerminalControlInput(request, target, data);
            setError(null);
            return 'sent';
        } catch (error_) {
            setError(controlError(error_));
            return 'blocked';
        }
    };
    /**
     * Typed characters arrive one keystroke at a time. Chaining the sends keeps them in keystroke order even though
     * each request resolves independently, and an armed Ctrl turns the next letter into its control byte.
     */
    const typeText = (text: string): Promise<void> => {
        const bytes = ctrl ? controlByteFor(text) : text;
        if (ctrl) setCtrl(false);
        if (bytes === null) {
            setError('That Ctrl key combination is not supported.');
            return inputChain.current;
        }
        const previous = inputChain.current;
        const next = async (): Promise<void> => {
            await previous;
            await sendInput(bytes);
        };
        inputChain.current = next();
        return inputChain.current;
    };
    const pressKey = async (key: TerminalKey): Promise<void> => {
        const next = pressTerminalKey(ctrl, key);
        setCtrl(next.ctrl);
        if (key !== 'ctrl' && next.bytes === null) {
            setError('That Ctrl key combination is not supported.');
            return;
        }
        if (next.bytes) await sendInput(next.bytes);
    };
    const paste = async (): Promise<void> => {
        try {
            const value = await Clipboard.getStringAsync();
            if (value) await sendInput(value);
        } catch {
            setError('Unable to read the clipboard.');
        }
    };
    const takeOver = async (): Promise<void> => {
        const target = currentTarget();
        const phoneSize = size.current;
        if (!target || !phoneSize) return;
        const admittedEpoch = lifetime.current;
        try {
            await request('mobile.terminal.takeOver', {
                ...target,
                ...phoneSize,
            });
            if (
                !canAdoptTerminalLease({
                    admittedEpoch,
                    currentEpoch: lifetime.current,
                    currentGeneration: generation.current,
                    currentSubscriptionId: subscription.current?.subscriptionId ?? null,
                    isConnected:
                        context.current.isConnected &&
                        context.current.subscriptionAvailable &&
                        context.current.role === 'control',
                    visible: context.current.visible,
                    target,
                })
            ) {
                // eslint-disable-next-line no-void -- The Server also releases when the old subscription closes.
                void request('mobile.terminal.release', target).catch(() => {});
                return;
            }
            lease.current = target;
            /**
             * The observer stream carries only output, so the phone applies the size it just gave the PTY to its own
             * grid. Otherwise it keeps rendering the Desktop grid while the Agent redraws for the phone.
             */
            sendWebview({ type: 'resize', ...phoneSize });
            sendControl(true);
            setHasLease(true);
            setError(null);
        } catch (error_) {
            setError(controlError(error_));
        }
    };
    const release = async (): Promise<void> => {
        const target = lease.current;
        if (!target) return;
        try {
            await request('mobile.terminal.release', target);
            if (lease.current === target) {
                lease.current = null;
                setHasLease(false);
                sendControl(false);
                setError(null);
            }
        } catch (error_) {
            setError(controlError(error_));
        }
    };
    const onWebviewMessage = (source: string): void => {
        const message = parseTerminalWebviewMessage(source, terminalId);
        if (!message) return;
        switch (message.type) {
            case 'ready': {
                webviewValid.current = true;
                setWebviewReady(true);
                // Each document needs its own snapshot, even if a previous document was already ready.
                setRetry((current) => current + 1);
                break;
            }
            case 'scroll': {
                setAtBottom(message.atBottom);
                break;
            }
            case 'size': {
                const previous = size.current;
                size.current = { cols: message.cols, rows: message.rows };
                setHasSize(true);
                /**
                 * The keyboard and rotation change the phone's grid while it holds the lease. Re-asserting the lease
                 * with the new size reflows the shared Terminal; the Server accepts a repeat from the same holder.
                 */
                if (
                    lease.current &&
                    (previous?.cols !== message.cols || previous.rows !== message.rows)
                ) {
                    clearTimeout(resizeTimer.current);
                    resizeTimer.current = setTimeout(() => {
                        const target = lease.current;
                        const next = size.current;
                        if (!target || !next) return;
                        // eslint-disable-next-line no-void -- A failed resize keeps the previous lease size.
                        void request('mobile.terminal.takeOver', { ...target, ...next })
                            .then(() => {
                                if (lease.current === target)
                                    sendWebview({ type: 'resize', ...next });
                            })
                            .catch(() => {});
                    }, 250);
                }
                break;
            }
            case 'tap': {
                onTap?.();
                break;
            }
            case 'wheel': {
                wheel.current ??= createTerminalWheelForwarder({
                    onError: (error_) => setError(controlError(error_)),
                    request,
                    target: () => targetReference.current(),
                });
                wheel.current(role, { col: message.col, lines: message.lines, row: message.row });
                break;
            }
            case 'error': {
                invalidateWebview();
                setState('error');
                setError('The Terminal display could not render.');
            }
        }
    };

    const displayState = terminalViewState(state, isStopped, isConnected, subscriptionAvailable);
    return {
        atBottom,
        canControl: canUseTerminalControls({
            connected: isConnected && subscriptionAvailable,
            generation: currentGeneration,
            hasSubscription,
            role,
            state: displayState,
        }),
        ctrl,
        error,
        hasLease: leased,
        hasSize,
        jump: () => sendWebview({ type: 'jump' }),
        onWebviewMessage,
        onWebviewTerminated,
        paste,
        pressKey,
        release,
        retry: onWebviewTerminated,
        sendInput,
        typeText,
        state: displayState,
        takeOver,
        webviewGeneration,
    };
};
