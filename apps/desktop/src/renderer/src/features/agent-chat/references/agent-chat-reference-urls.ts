import { proseWebLinks } from '@caxri/markdown';
import type { AgentChatItem } from '@caxri/protocol';
import { collectAgentChatTrackers } from '@caxri/protocol';

import type { AgentChatTimelineEntry } from '../transcript/agent-chat-timeline';

/**
 * Items are immutable snapshots: a patch replaces only the items it changed, so caching by identity rescans just those.
 */
const cache = new WeakMap<AgentChatItem, readonly string[]>();

function itemReferenceUrls(item: AgentChatItem): readonly string[] {
    switch (item.type) {
        case 'userMessage':
        case 'agentMessage': {
            return proseWebLinks(item.text).map((link) => link.url);
        }
        case 'command':
        case 'toolCall': {
            // The pull request or issue a command (`gh pr create`) or tool call filed, as its turn's card shows it.
            return collectAgentChatTrackers([item]).map((artifact) => artifact.url);
        }
        default: {
            return [];
        }
    }
}

function entryItems(entry: AgentChatTimelineEntry): readonly AgentChatItem[] {
    switch (entry.kind) {
        case 'item': {
            return [entry.item];
        }
        case 'work': {
            return entry.items;
        }
        case 'turn': {
            return entry.entries.flatMap(entryItems);
        }
        case 'artifacts': {
            return [];
        }
    }
}

function cachedItemReferenceUrls(item: AgentChatItem): readonly string[] {
    // A reply still streaming waits until it settles, so a growing reply is not rescanned on every delta.
    if (item.type === 'agentMessage' && item.streaming) return [];
    let found = cache.get(item);
    if (!found) {
        found = itemReferenceUrls(item);
        cache.set(item, found);
    }
    return found;
}

/**
 * Every web link a Chat timeline holds that a later mention may refer back to: those written in the user's messages and
 * the Agent's replies, and the pull requests and issues its commands and tool calls filed, folded turns included.
 */
export function agentChatReferenceUrls(entries: readonly AgentChatTimelineEntry[]): string[] {
    return entries.flatMap(entryItems).flatMap(cachedItemReferenceUrls);
}
