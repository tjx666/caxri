import { z } from 'zod';

import {
    agentChatImageMediaTypeSchema,
    MAX_AGENT_CHAT_PICKED_IMAGES_BYTES,
} from './agent-chat-contract.js';

/**
 * A file or folder the user attached to a message by path: dropped from Finder, pasted, or picked with `+`. The Agent
 * reads it from disk itself, so a message carries only the path.
 */
export interface AgentChatPathReference {
    /**
     * Absolute path on the machine the Agent runs on.
     */
    path: string;
    isDirectory: boolean;
}

/**
 * One path `dialog.selectPaths` returns: an image's bytes when the composer asked for them, and whether it is a folder,
 * which the composer shows on its card.
 */
const agentChatPickedImageSchema = z.object({
    mediaType: agentChatImageMediaTypeSchema,
    base64: z.string().max(Math.ceil(MAX_AGENT_CHAT_PICKED_IMAGES_BYTES / 3) * 4),
});
export const agentChatPickedPathSchema = z.object({
    path: z.string().min(1),
    image: agentChatPickedImageSchema.optional(),
    isDirectory: z.literal(true).optional(),
});

const REFERENCES_HEADING = '# Files mentioned by the user:';

/**
 * Where the user's own words begin. Codex itself strips everything before `## My request for Codex:` when it shows or
 * titles a message, so a Codex Chat uses that heading; other providers get the provider-neutral one.
 */
function requestHeading(providerName: string | undefined): string {
    return providerName ? `## My request for ${providerName}:` : '## My request:';
}

const REFERENCE_BLOCK =
    /^# Files mentioned by the user:\n\n((?:## [^\n]*\n\n)+)## My request(?: for [^\n:]+)?:\n/u;
const REFERENCE_LINE = /^## (?<name>[^\n]*?): (?<path>\/[^\n]*)$/u;

function referenceName(path: string): string {
    const trimmed = path.replace(/\/+$/u, '');
    return trimmed.slice(trimmed.lastIndexOf('/') + 1) || trimmed || path;
}

/**
 * The message text that carries `references` ahead of what the user typed, in the Codex app's layout: one `## name:
 * path` line per reference, a folder's path ending in `/`, then the request heading. Text without references is sent
 * unchanged.
 */
export function agentChatTextWithPathReferences(
    text: string,
    references: readonly AgentChatPathReference[],
    providerName?: string,
): string {
    if (references.length === 0) return text;
    const lines = references.map(({ isDirectory, path }) => {
        const normalized = path.replace(/\/+$/u, '') || '/';
        const shown = isDirectory && normalized !== '/' ? `${normalized}/` : normalized;
        return `## ${referenceName(normalized)}: ${shown}\n\n`;
    });
    return `${REFERENCES_HEADING}\n\n${lines.join('')}${requestHeading(providerName)}\n${text}`;
}

/**
 * Splits a sent message back into its path references and what the user typed (`agentChatTextWithPathReferences`), so a
 * Client can show the references as chips, including in a conversation resumed from the provider's own record. Text
 * that does not start with the reference block comes back whole with no references.
 */
export function parseAgentChatPathReferences(text: string): {
    references: AgentChatPathReference[];
    text: string;
} {
    const match = REFERENCE_BLOCK.exec(text);
    const block = match?.[1];
    if (!match || !block) return { references: [], text };
    const references: AgentChatPathReference[] = [];
    for (const line of block.split('\n\n')) {
        if (!line) continue;
        const path = REFERENCE_LINE.exec(line)?.groups?.path;
        if (!path) return { references: [], text };
        const isDirectory = path.length > 1 && path.endsWith('/');
        references.push({ path: isDirectory ? path.slice(0, -1) : path, isDirectory });
    }
    return { references, text: text.slice(match[0].length) };
}

/**
 * What a reference chip shows: the last path segment.
 */
export function agentChatPathReferenceName(
    reference: Pick<AgentChatPathReference, 'path'>,
): string {
    return referenceName(reference.path);
}

/**
 * A one-line summary of a message for a queue row or the message rail: the user's words, or the names of the files and
 * folders it cites when it has no words. A preview clipped inside the reference block names the references it still
 * holds.
 */
export function agentChatPathReferencePreview(text: string): string {
    const { references, text: words } = parseAgentChatPathReferences(text);
    if (references.length > 0)
        return (
            words.trim() || references.map((reference) => referenceName(reference.path)).join(', ')
        );
    if (!text.startsWith(REFERENCES_HEADING)) return text;
    return text
        .split('\n')
        .flatMap((line) => {
            const name = REFERENCE_LINE.exec(line)?.groups?.name;
            return name ? [name] : [];
        })
        .join(', ');
}
