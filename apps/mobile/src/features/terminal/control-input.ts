const MAXIMUM_INPUT_BYTES = 8 * 1_024;
const MAXIMUM_WEBVIEW_TEXT_UNITS = 12 * 1_024;
const encoder = new TextEncoder();

export interface TerminalControlTarget {
    terminalId: string;
    subscriptionId: string;
    expectedGeneration: number;
}

/**
 * Key bar, Paste, and Terminal text entry all share this exact-byte, generation-fenced send boundary.
 */
export const sendTerminalControlInput = async (
    request: (
        method: 'mobile.terminal.input',
        parameters: TerminalControlTarget & { data: string },
    ) => Promise<null>,
    target: TerminalControlTarget,
    data: string,
): Promise<null> => {
    if (data.length === 0 || encoder.encode(data).byteLength > MAXIMUM_INPUT_BYTES)
        throw new Error('Terminal input must be between 1 byte and 8 KiB.');
    return request('mobile.terminal.input', { ...target, data });
};

/**
 * Injected WebView commands stay below the bridge limit without cutting a Unicode character in half.
 */
export const chunkTerminalText = (value: string): string[] => {
    const chunks: string[] = [];
    for (let offset = 0; offset < value.length;) {
        let end = Math.min(value.length, offset + MAXIMUM_WEBVIEW_TEXT_UNITS);
        // eslint-disable-next-line unicorn/prefer-code-point -- Inspect the boundary code unit; codePointAt consumes its following low surrogate.
        const last = value.charCodeAt(end - 1);
        if (end < value.length && last >= 0xd800 && last <= 0xdbff) end -= 1;
        chunks.push(value.slice(offset, end));
        offset = end;
    }
    return chunks;
};
