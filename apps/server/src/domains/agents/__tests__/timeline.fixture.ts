/**
 * Sanitized native record shape established by the adjacent Claude provider tests and Codex rollout writer/types. No
 * host Agent transcript is read or copied into this public-ready fixture.
 *
 * @see https://github.com/openai/codex/blob/main/codex-rs/rollout/src/recorder.rs
 * @see https://github.com/openai/codex/blob/main/codex-rs/protocol/src/protocol.rs
 */
export const claude = (type: 'user' | 'assistant', uuid: string, content: unknown, extra = {}) => ({
    type,
    uuid,
    timestamp: '2026-01-02T03:04:05.000Z',
    message: { content },
    ...extra,
});
