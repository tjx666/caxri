import type { TerminalOsc52ClipboardWriteFailureDiagnostic } from '@caxri/protocol';

interface TerminalOsc52ClipboardDiagnosticInput {
    diagnosticId: string;
    error: unknown;
    terminalId: string;
}

interface TerminalOsc52ClipboardDiagnosticContext {
    documentFocused: boolean;
    documentVisible: boolean;
    queryPermission?: () => Promise<PermissionState>;
    secureContext: boolean;
    terminalFocused: boolean;
    userActivationActive: boolean | null;
    userActivationHasBeenActive: boolean | null;
}

function classifyClipboardWriteError(
    error: unknown,
): TerminalOsc52ClipboardWriteFailureDiagnostic['errorCategory'] {
    if (typeof DOMException !== 'undefined' && error instanceof DOMException) {
        if (error.name === 'AbortError') return 'abort';
        if (error.name === 'InvalidStateError') return 'invalid-state';
        if (error.name === 'NotAllowedError') return 'not-allowed';
        if (error.name === 'SecurityError') return 'security';
        return 'other-dom-exception';
    }
    return error instanceof Error ? 'error' : 'non-error';
}

async function inspectClipboardWritePermission(
    context: TerminalOsc52ClipboardDiagnosticContext,
): Promise<TerminalOsc52ClipboardWriteFailureDiagnostic['clipboardWritePermission']> {
    if (!context.queryPermission) return 'unavailable';
    try {
        const permission = await context.queryPermission();
        return ['denied', 'granted', 'prompt'].includes(permission) ? permission : 'query-failed';
    } catch {
        return 'query-failed';
    }
}

/**
 * Converts a clipboard rejection into a strict diagnostic receipt. The raw rejection is only classified into a closed
 * enum and is never returned, logged, or sent through IPC.
 */
export async function createTerminalOsc52ClipboardWriteFailureDiagnostic(
    input: TerminalOsc52ClipboardDiagnosticInput,
    context: TerminalOsc52ClipboardDiagnosticContext,
): Promise<TerminalOsc52ClipboardWriteFailureDiagnostic> {
    const errorCategory = classifyClipboardWriteError(input.error);
    const clipboardWritePermission = await inspectClipboardWritePermission(context);
    return {
        kind: 'terminal-osc52-clipboard-write-failure',
        diagnosticId: input.diagnosticId,
        terminalId: input.terminalId,
        errorCategory,
        clipboardWritePermission,
        documentVisible: context.documentVisible,
        documentFocused: context.documentFocused,
        secureContext: context.secureContext,
        terminalFocused: context.terminalFocused,
        userActivationActive: context.userActivationActive,
        userActivationHasBeenActive: context.userActivationHasBeenActive,
    };
}
