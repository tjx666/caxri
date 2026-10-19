import { z } from 'zod';

import { agentChatImageMediaTypeSchema } from './agent-chat-contract.js';
import { MAX_AGENT_CHAT_PICKED_IMAGES_BYTES } from './agent-chat-limits.js';

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

/**
 * A product skill the user asked the Agent to use for one message, picked from the composer's `+` menu. The message
 * carries only its name and how to load it: the Caxri CLI serves the version-matched guide (`skills get`), so the text
 * never drifts from the commands it documents.
 */
export interface AgentChatSkillReference {
    name: string;
}

/**
 * The product skill the composer offers: the guide to driving Caxri itself through its CLI.
 */
export const CAXRI_SKILL_NAME = 'caxri-cli';

const SKILLS_HEADING = '# Skills the user asked you to use:';
const REFERENCES_HEADING = '# Files mentioned by the user:';

function skillLine(name: string): string {
    return `## ${name}: run \`"$CAXRI_CLI" skills get ${name} --full\` and follow it`;
}

/**
 * Where the user's own words begin. Codex itself strips everything before `## My request for Codex:` when it shows or
 * titles a message, so a Codex Chat uses that heading; other providers get the provider-neutral one.
 */
function requestHeading(providerName: string | undefined): string {
    return providerName ? `## My request for ${providerName}:` : '## My request:';
}

const REFERENCE_BLOCK =
    /^(?:# Skills the user asked you to use:\n\n((?:## [^\n]*\n\n)+))?(?:# Files mentioned by the user:\n\n((?:## [^\n]*\n\n)+))?## My request(?: for [^\n:]+)?:\n/u;
const REFERENCE_LINE = /^## (?<name>[^\n]*?): (?<path>\/[^\n]*)$/u;
const SKILL_LINE = /^## (?<name>[\w.-]+): /u;

function referenceName(path: string): string {
    const trimmed = path.replace(/\/+$/u, '');
    return trimmed.slice(trimmed.lastIndexOf('/') + 1) || trimmed || path;
}

/**
 * The message text that carries `references` and `skills` ahead of what the user typed, in the Codex app's layout: the
 * skills to load first, one `## name: how to load it` line each, then one `## name: path` line per reference, a
 * folder's path ending in `/`, then the request heading. Text without either is sent unchanged.
 */
export function agentChatTextWithPathReferences(
    text: string,
    references: readonly AgentChatPathReference[],
    providerName?: string,
    skills: readonly AgentChatSkillReference[] = [],
): string {
    if (references.length === 0 && skills.length === 0) return text;
    const skillBlock =
        skills.length === 0
            ? ''
            : `${SKILLS_HEADING}\n\n${skills.map(({ name }) => `${skillLine(name)}\n\n`).join('')}`;
    const lines = references.map(({ isDirectory, path }) => {
        const normalized = path.replace(/\/+$/u, '') || '/';
        const shown = isDirectory && normalized !== '/' ? `${normalized}/` : normalized;
        return `## ${referenceName(normalized)}: ${shown}\n\n`;
    });
    const referenceBlock =
        references.length === 0 ? '' : `${REFERENCES_HEADING}\n\n${lines.join('')}`;
    return `${skillBlock}${referenceBlock}${requestHeading(providerName)}\n${text}`;
}

function parseSkillLines(block: string | undefined): AgentChatSkillReference[] | undefined {
    if (block === undefined) return [];
    const skills: AgentChatSkillReference[] = [];
    for (const line of block.split('\n\n')) {
        if (!line) continue;
        const name = SKILL_LINE.exec(line)?.groups?.name;
        if (!name || line !== skillLine(name)) return undefined;
        skills.push({ name });
    }
    return skills;
}

function parsePathLines(block: string | undefined): AgentChatPathReference[] | undefined {
    if (block === undefined) return [];
    const references: AgentChatPathReference[] = [];
    for (const line of block.split('\n\n')) {
        if (!line) continue;
        const path = REFERENCE_LINE.exec(line)?.groups?.path;
        if (!path) return undefined;
        const isDirectory = path.length > 1 && path.endsWith('/');
        references.push({ path: isDirectory ? path.slice(0, -1) : path, isDirectory });
    }
    return references;
}

/**
 * Splits a sent message back into its skills, its path references, and what the user typed
 * (`agentChatTextWithPathReferences`), so a Client can show them as chips, including in a conversation resumed from the
 * provider's own record. Text that does not start with the reference block comes back whole with neither.
 */
export function parseAgentChatPathReferences(text: string): {
    references: AgentChatPathReference[];
    skills: AgentChatSkillReference[];
    text: string;
} {
    const match = REFERENCE_BLOCK.exec(text);
    if (!match) return { references: [], skills: [], text };
    // Both sections are optional groups, which come back `undefined` when absent; the exec type does not say so.
    const [, skillBlock, pathBlock] = match as ReadonlyArray<string | undefined>;
    if (skillBlock === undefined && pathBlock === undefined)
        return { references: [], skills: [], text };
    const skills = parseSkillLines(skillBlock);
    const references = parsePathLines(pathBlock);
    if (!skills || !references) return { references: [], skills: [], text };
    return { references, skills, text: text.slice(match[0].length) };
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
    const { references, skills, text: words } = parseAgentChatPathReferences(text);
    if (references.length > 0 || skills.length > 0)
        return (
            words.trim() ||
            [
                ...skills.map(({ name }) => name),
                ...references.map((reference) => referenceName(reference.path)),
            ].join(', ')
        );
    if (!text.startsWith(REFERENCES_HEADING) && !text.startsWith(SKILLS_HEADING)) return text;
    return text
        .split('\n')
        .flatMap((line) => {
            const name =
                REFERENCE_LINE.exec(line)?.groups?.name ?? SKILL_LINE.exec(line)?.groups?.name;
            return name ? [name] : [];
        })
        .join(', ');
}
