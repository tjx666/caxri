/**
 * Normalizes a prompt that came from outside the Renderer (an extension's tree action): line endings become `\n` and
 * every other control character is dropped, so nothing in it can end a Terminal Agent's bracketed paste early or inject
 * keystrokes. Returns `undefined` for anything that is not a non-empty string.
 */
export function agentPromptText(value: unknown): string | undefined {
    if (typeof value !== 'string') return undefined;
    const text = [...value.replaceAll('\r\n', '\n').replaceAll('\r', '\n')]
        .filter((character) => {
            const code = character.codePointAt(0)!;
            return code === 9 || code === 10 || (code >= 32 && code !== 127);
        })
        .join('')
        .trim();
    return text || undefined;
}
