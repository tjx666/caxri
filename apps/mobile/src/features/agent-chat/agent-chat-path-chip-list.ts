import type { AgentChatPathReference, AgentChatSkillReference } from '@caxri/protocol';
import { agentChatPathReferenceName } from '@caxri/protocol';

/**
 * One chip under a user message: a skill, a file, or a folder the message cited. `path` is what a tap reveals, since
 * the phone has no Finder to open.
 */
export interface AgentChatPathChip {
    key: string;
    kind: 'file' | 'folder' | 'skill';
    name: string;
    path: string | undefined;
}

/**
 * The chips for a message's citations in Desktop's order (skills first, then files and folders), each named by its last
 * path segment.
 */
export const agentChatPathChips = (
    references: readonly AgentChatPathReference[],
    skills: readonly AgentChatSkillReference[],
): AgentChatPathChip[] => [
    ...skills.map(({ name }) => ({
        key: `skill:${name}`,
        kind: 'skill' as const,
        name,
        path: undefined,
    })),
    ...references.map((reference) => ({
        key: `path:${reference.path}`,
        kind: reference.isDirectory ? ('folder' as const) : ('file' as const),
        name: agentChatPathReferenceName(reference),
        path: reference.path,
    })),
];
