import { z } from 'zod';

import { agentChatTextWithSessionMentions } from '../domain/session-conversation-reference.js';
import {
    agentChatSessionHandoffDraft,
    parseAgentChatSessionHandoff,
    splitAgentChatSessionHandoffNote,
} from './agent-chat-commands.js';
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
        // The filesystem root is always a folder, and its one-character path cannot carry a trailing `/` marker.
        const isDirectory = path === '/' || path.endsWith('/');
        references.push({
            path: isDirectory && path !== '/' ? path.slice(0, -1) : path,
            isDirectory,
        });
    }
    return references;
}

/**
 * Splits a sent message back into its skills, its path references, and what the user typed
 * (`agentChatTextWithPathReferences`), so a Client can show them as chips, including in a conversation resumed from the
 * provider's own record. Text that does not start with the reference block comes back whole with neither. A
 * `/new-session` hand-off's words come back as the command the user typed (`agentChatSessionHandoffDraft`), with
 * `handoff` set. Only the instructions the composer wrote set it: a literal `/new-session` the composer could not turn
 * into a hand-off reached the Agent as plain words, so it must not read as one.
 */
export function parseAgentChatPathReferences(text: string): {
    handoff?: { note: string };
    references: AgentChatPathReference[];
    skills: AgentChatSkillReference[];
    text: string;
} {
    const block = splitReferenceBlock(text);
    if (!block) return { references: [], skills: [], ...requestWords(text) };
    const { references, rest, skills } = block;
    return { references, skills, ...requestWords(rest) };
}

/**
 * The reference block a message starts with, parsed, and the raw text after it. `undefined` when the message does not
 * start with a well-formed one.
 */
function splitReferenceBlock(text: string):
    | {
          references: AgentChatPathReference[];
          rest: string;
          skills: AgentChatSkillReference[];
      }
    | undefined {
    const match = REFERENCE_BLOCK.exec(text);
    if (!match) return undefined;
    // Both sections are optional groups, which come back `undefined` when absent; the exec type does not say so.
    const [, skillBlock, pathBlock] = match as ReadonlyArray<string | undefined>;
    if (skillBlock === undefined && pathBlock === undefined) return undefined;
    const skills = parseSkillLines(skillBlock);
    const references = parsePathLines(pathBlock);
    if (!skills || !references) return undefined;
    return { references, rest: text.slice(match[0].length), skills };
}

/**
 * What the user typed under the reference block, and the hand-off it asked for, if any.
 */
function requestWords(text: string): { handoff?: { note: string }; text: string } {
    const handoff = parseAgentChatSessionHandoff(text);
    return { text: agentChatSessionHandoffDraft(text), ...(handoff && { handoff }) };
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
 * A queued message's text split for editing in place: the file, folder, and skill lines a message may carry ahead of
 * what the user typed stay as they are (`prefix`), and only `body` is edited. A `/new-session` hand-off keeps its
 * instructions in `prefix` too, so only the user's note is edited. `body` is always the raw end of `text`: the
 * read-back form ({@link parseAgentChatPathReferences}) shows a hand-off as `/new-session <note>`, which no message ends
 * with.
 */
export function agentChatQueuedTextEdit(text: string): { prefix: string; body: string } {
    const rest = splitReferenceBlock(text)?.rest ?? text;
    const referencePrefix = text.slice(0, text.length - rest.length);
    const handoff = splitAgentChatSessionHandoffNote(rest);
    return handoff
        ? { prefix: `${referencePrefix}${handoff.instructions}`, body: handoff.note }
        : { prefix: referencePrefix, body: rest };
}

/**
 * The text an in-place edit saves: the edited `body` after the untouched `prefix`.
 */
export function agentChatQueuedTextAfterEdit(prefix: string, body: string): string {
    return `${prefix}${body}`;
}

/**
 * A one-line summary of a message for a queue row or the message rail: the user's words, each cited Session as its
 * `@title` mention, or the names of the files and folders it cites when it has no words. A preview clipped inside the
 * reference block names the references it still holds.
 */
export function agentChatPathReferencePreview(text: string): string {
    const parsed = parseAgentChatPathReferences(text);
    const { references, skills } = parsed;
    const words = agentChatTextWithSessionMentions(parsed.text);
    if (references.length > 0 || skills.length > 0)
        return (
            words.trim() ||
            [
                ...skills.map(({ name }) => name),
                ...references.map((reference) => referenceName(reference.path)),
            ].join(', ')
        );
    if (!text.startsWith(REFERENCES_HEADING) && !text.startsWith(SKILLS_HEADING)) return words;
    return text
        .split('\n')
        .flatMap((line) => {
            const name =
                REFERENCE_LINE.exec(line)?.groups?.name ?? SKILL_LINE.exec(line)?.groups?.name;
            return name ? [name] : [];
        })
        .join(', ');
}

/**
 * A video the user cites in a Chat message by its absolute path. The Agent reads the file itself; Desktop serves the
 * same path to the Renderer through `AGENT_CHAT_MEDIA_SCHEME` so the message can show the video's poster frame and play
 * it, because the Renderer's Content-Security-Policy forbids `file:` and a screen recording is far larger than an asset
 * read may be.
 */
export const AGENT_CHAT_MEDIA_SCHEME = 'caxri-media';

/**
 * Extensions Chromium plays in a `<video>` on macOS. A format it cannot decode (`.avi`, `.mkv` with HEVC) stays an
 * ordinary file reference, so a pill never promises playback it cannot give.
 */
const VIDEO_EXTENSIONS = new Set(['m4v', 'mov', 'mp4', 'ogv', 'webm']);

/**
 * What a media URL asks for: the video itself, streamed with range requests, or its poster frame as a PNG.
 */
export type AgentChatMediaKind = 'poster' | 'video';

/**
 * Whether `path` names a video the Chat previews and plays, judged by its extension.
 */
export function isAgentChatVideoPath(path: string): boolean {
    const name = path.slice(path.lastIndexOf('/') + 1);
    const dot = name.lastIndexOf('.');
    return dot > 0 && VIDEO_EXTENSIONS.has(name.slice(dot + 1).toLowerCase());
}

/**
 * The URL that serves the video at the absolute `path`, or its poster frame.
 */
export function agentChatMediaUrl(kind: AgentChatMediaKind, path: string): string {
    return `${AGENT_CHAT_MEDIA_SCHEME}://local/${kind}?path=${encodeURIComponent(path)}`;
}

/**
 * The request a media URL makes, or `undefined` when it is not one `agentChatMediaUrl` writes for a video path.
 */
export function parseAgentChatMediaUrl(
    url: string,
): { kind: AgentChatMediaKind; path: string } | undefined {
    let parsed: URL;
    try {
        parsed = new URL(url);
    } catch {
        return undefined;
    }
    if (parsed.protocol !== `${AGENT_CHAT_MEDIA_SCHEME}:` || parsed.host !== 'local')
        return undefined;
    const kind = parsed.pathname.slice(1);
    const path = parsed.searchParams.get('path');
    if ((kind !== 'poster' && kind !== 'video') || !path?.startsWith('/')) return undefined;
    if (!isAgentChatVideoPath(path)) return undefined;
    return { kind, path };
}
