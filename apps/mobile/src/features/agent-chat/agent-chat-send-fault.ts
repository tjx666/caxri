/**
 * The Acceptance fault value that makes the first Chat send end in an unknown outcome.
 */
export const CHAT_SEND_UNKNOWN_FAULT = 'chat-send-unknown-once';

/**
 * Whether the build-time Acceptance fault value is exactly {@link CHAT_SEND_UNKNOWN_FAULT}. Any other value, including
 * `undefined` in a production build, leaves every send untouched.
 */
export const isChatSendUnknownFault = (value: string | undefined): boolean =>
    value === CHAT_SEND_UNKNOWN_FAULT;

/**
 * Builds the one-shot gate for the Acceptance fault: `shouldInject` is true once, on the first call, only when `fault`
 * is exactly {@link CHAT_SEND_UNKNOWN_FAULT}, then false so later sends recover.
 */
export const createChatSendFaultGate = (fault: string | undefined) => {
    let isSpent = false;
    return {
        shouldInject: (): boolean => {
            if (isSpent || !isChatSendUnknownFault(fault)) return false;
            isSpent = true;
            return true;
        },
    };
};

/**
 * Acceptance-only: a build with `EXPO_PUBLIC_CAXRI_ACCEPTANCE_FAULT=chat-send-unknown-once` lets the first send reach
 * the Server and then fails it with a plain error, the shape of a connection that dropped after the request left. That
 * is the `unknown` path of `classifyMobileWriteFailure`, which no Server-side failure can reproduce on demand. Expo
 * replaces the environment expression while bundling, so a production build carries a gate that never fires.
 */
export const chatSendFaultGate = createChatSendFaultGate(
    // eslint-disable-next-line n/prefer-global/process
    process.env.EXPO_PUBLIC_CAXRI_ACCEPTANCE_FAULT,
);
