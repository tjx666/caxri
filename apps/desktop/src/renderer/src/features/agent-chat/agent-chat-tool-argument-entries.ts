/**
 * One argument of a tool call: its name and its value as text. `isCode` marks a value that is not a plain string (a
 * number, a flag, a list, an object), which reads as JSON.
 */
export interface AgentChatToolArgumentEntry {
    name: string;
    value: string;
    isCode: boolean;
}

/**
 * The arguments preview of a tool call as name and value pairs, when it is a whole JSON object. A preview the Server
 * clipped mid-object, or anything else, returns `undefined` and is shown as written.
 */
export function agentChatToolArgumentEntries(
    text: string,
): AgentChatToolArgumentEntry[] | undefined {
    let parsed: unknown;
    try {
        parsed = JSON.parse(text);
    } catch {
        return undefined;
    }
    if (typeof parsed !== 'object' || parsed === null || Array.isArray(parsed)) return undefined;
    const entries = Object.entries(parsed);
    if (entries.length === 0) return undefined;
    return entries.map(([name, value]) =>
        typeof value === 'string'
            ? { name, value, isCode: false }
            : { name, value: JSON.stringify(value, null, 2), isCode: true },
    );
}
