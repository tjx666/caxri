import { useCallback, useEffect, useRef, useState } from 'react';

import type { ProcessState, ServerEvent } from '@caxri/protocol';

import type { TerminalPaneResizeController } from '../terminal-size';

type SizeOwnershipPayload = Extract<ServerEvent, { event: 'terminal.sizeOwnership' }>['payload'];

interface SizeOwnershipState extends SizeOwnershipPayload {
    attachEpoch: number;
}

export function visibleMobileSizeOwnership(
    state: SizeOwnershipState | undefined,
    terminalId: string,
    attachEpoch: number,
    processState: ProcessState,
): Pick<SizeOwnershipPayload, 'cols' | 'rows'> | undefined {
    if (
        processState !== 'running' ||
        state?.owner !== 'mobile' ||
        state.terminalId !== terminalId ||
        state.attachEpoch !== attachEpoch
    )
        return undefined;
    return { cols: state.cols, rows: state.rows };
}

export function didHandleTerminalSizeOwnershipEvent(
    event: ServerEvent,
    terminalId: string,
    resizeController: Pick<TerminalPaneResizeController, 'setSizeOwnership' | 'resetSizeOwnership'>,
    callbacks: {
        onSizeOwnership: (payload: SizeOwnershipPayload) => void;
        onTerminalExit: () => void;
    },
): boolean {
    if (event.event === 'terminal.sizeOwnership') {
        if (event.payload.terminalId === terminalId) {
            const { owner, cols, rows } = event.payload;
            resizeController.setSizeOwnership(owner, { cols, rows });
            callbacks.onSizeOwnership(event.payload);
        }
        return true;
    }
    if (event.event === 'terminal.exit') {
        if (event.payload.terminalId === terminalId) {
            resizeController.resetSizeOwnership();
            callbacks.onTerminalExit();
        }
        return true;
    }
    return false;
}

/**
 * An ownership event belongs to one Server attachment. Terminal exit clears it before a later PTY run, while a new
 * Server attachment cannot reuse an event from the previous attach epoch.
 */
export function useTerminalSizeOwnership(
    terminalId: string,
    attachEpoch: number,
    processState: ProcessState,
) {
    const [state, setState] = useState<SizeOwnershipState>();
    const attachEpochReference = useRef(attachEpoch);
    useEffect(() => {
        attachEpochReference.current = attachEpoch;
    }, [attachEpoch]);
    const onSizeOwnership = useCallback((payload: SizeOwnershipPayload): void => {
        setState({ ...payload, attachEpoch: attachEpochReference.current });
    }, []);
    const onTerminalExit = useCallback((): void => setState(undefined), []);

    return {
        mobileSizeOwnership: visibleMobileSizeOwnership(
            state,
            terminalId,
            attachEpoch,
            processState,
        ),
        onSizeOwnership,
        onTerminalExit,
    };
}
