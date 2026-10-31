import { randomUUID } from 'node:crypto';

import type {
    AgentChatRewindTarget,
    AgentChatSnapshot,
    AgentChatVersionContent,
    AgentChatVersionSummary,
} from '@caxri/protocol';
import { CaxriError } from '@caxri/protocol';

import type { CaxriDatabase } from '../../db';
import { requireChatTerminal } from '../chat-launch';
import { chatStateStore } from '../chat-state-store';

/**
 * The earlier version one rewind keeps, from its save before the provider rewinds to its final anchor after the
 * restart.
 */
export interface KeptChatVersion {
    id: string;
    agentSessionId: string | null;
}

/**
 * Saves the slice of the projection "Edit from here" is about to replace, from the edited message on, as an earlier
 * version. It is saved before the provider rewinds: a Server Core that dies after the provider's rewind but before its
 * answer would otherwise lose the turns with no record anywhere. The worst a dead rewind leaves is a version identical
 * to the conversation that continued. The anchor is the turn before the message as this projection names it until
 * {@link anchorChatVersion} replaces it with the rebuilt projection's name.
 */
export function keepChatVersion(
    database: CaxriDatabase,
    terminalId: string,
    snapshot: Pick<AgentChatSnapshot, 'items' | 'turns'>,
    target: AgentChatRewindTarget,
): KeptChatVersion {
    const start = snapshot.items.findIndex((item) => item.id === target.itemId);
    const agentSessionId = database.getTerminal(terminalId)?.agentSessionId ?? null;
    const id = randomUUID();
    chatStateStore(database).versions.save({
        terminalId,
        id,
        agentSessionId,
        anchorTurnId: snapshot.turns[target.keptTurns - 1]?.id ?? null,
        items: snapshot.items.slice(Math.max(start, 0)),
        turns: snapshot.turns.slice(target.keptTurns),
    });
    return { id, agentSessionId };
}

/**
 * Drops a version whose rewind the provider refused, since the conversation still holds every turn it kept.
 */
export function dropChatVersion(
    database: CaxriDatabase,
    terminalId: string,
    version: KeptChatVersion,
): void {
    chatStateStore(database).versions.remove(terminalId, version.id);
}

/**
 * Re-anchors a kept version on the rebuilt projection, between the restart and the send of the edited message, so the
 * anchor is the turn id a provider replay gives (Grok Build replays turns as `history:N` while a live turn has a
 * generated id) and survives every later restart. Before the restart, a projection that held only part of the
 * conversation could also not tell whether the edited message was its first. `rebuilt` is undefined when the restart
 * left no projection, which keeps the anchor the version was saved with; `isFresh` says the rewind emptied the
 * conversation, so its first message is the one replaced.
 */
export function anchorChatVersion(
    database: CaxriDatabase,
    terminalId: string,
    version: KeptChatVersion,
    rebuilt: Pick<AgentChatSnapshot, 'turns'> | undefined,
    isFresh: boolean,
): void {
    const anchor = isFresh ? null : rebuilt?.turns.at(-1)?.id;
    if (anchor === undefined) return;
    chatStateStore(database).versions.setAnchor(terminalId, version.id, anchor);
}

/**
 * Moves the conversation's versions to the Agent Session the rewind continues it in (an edit of Claude Code's first
 * message opens a new session), once the edited message was sent and the provider bound it.
 */
export function followChatVersionSession(
    database: CaxriDatabase,
    terminalId: string,
    version: KeptChatVersion,
): void {
    const current = database.getTerminal(terminalId)?.agentSessionId ?? null;
    if (current === null) return;
    chatStateStore(database).versions.moveSession(terminalId, version.agentSessionId, current);
}

/**
 * `agentChat.listVersions`: the versions of the conversation the Chat's Agent Session holds now.
 */
export function listChatVersions(
    database: CaxriDatabase,
    terminalId: string,
): AgentChatVersionSummary[] {
    const terminal = requireChatTerminal(database, terminalId);
    return chatStateStore(database).versions.list(terminalId, terminal.agentSessionId ?? null);
}

/**
 * `agentChat.readVersion`.
 */
export function readChatVersion(
    database: CaxriDatabase,
    terminalId: string,
    versionId: string,
): AgentChatVersionContent {
    requireChatTerminal(database, terminalId);
    const content = chatStateStore(database).versions.read(terminalId, versionId);
    if (!content) throw new CaxriError('NOT_FOUND', 'This earlier version is no longer kept');
    return content;
}
