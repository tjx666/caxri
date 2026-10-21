/**
 * The `error` notification Codex sends while it retries a dropped response stream, for a `slow reconnect` turn.
 */
export const CODEX_RECONNECTING = {
    willRetry: true,
    error: {
        message: 'Reconnecting... 2/5',
        codexErrorInfo: 'responseStreamDisconnected',
        additionalDetails: 'stream disconnected before completion',
    },
};
