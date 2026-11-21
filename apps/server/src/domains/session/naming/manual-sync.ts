import { agentProviderCatalog } from '@caxri/protocol';

import type { AgentLifecycleSignal } from '../../agents';
/**
 * Server domain boundaries require the owning public root; structure tests reject cross-domain deep imports.
 */
// react-doctor-disable-next-line react-doctor/no-barrel-import
import { agentProviderStateRoot } from '../../agents';
import type { CaxriDatabase } from '../../db';
import { caxriBotIdentity } from '../../db';
import type { SessionRenameService } from './rename';

/**
 * Conversations remembered. Above the live Terminal limit (128), so eviction only drops conversations that have since
 * ended; an evicted one costs a single native snapshot on its next turn.
 */
const CONVERSATION_CAPACITY = 512;

/**
 * Attempts per conversation before it is left alone until the next Server start. One retry covers a provider that had
 * not recorded the conversation when its first turn started; a write that keeps failing (an Agent CLI too old to
 * rename, a signed-out account) must not spawn a provider process on every turn.
 */
const MAX_ATTEMPTS = 3;

interface ConversationSync {
    attempts: number;
    /**
     * No further attempt for this conversation: written, kept, or out of attempts.
     */
    isSettled: boolean;
    running?: { controller: AbortController; task: Promise<void> };
}

/**
 * Carries a manual Session title to the primary Agent's conversation once that conversation exists, once per
 * conversation (Terminal and Agent session ID).
 *
 * A Session named before its Agent started, which is every `--type` or `--new-session` delegation, otherwise kept that
 * name in Caxri only: the native conversation stayed listed by its first message in the Codex app and `claude
 * --resume`, and for a delegation that message is only the task pointer. A started turn tries first, so a long task is
 * listed by its name while it runs; a finished turn retries a conversation the provider had not recorded yet.
 * {@link SessionRenameService.synchronizeManualTitle} decides whether to write and logs the outcome.
 */
export class ManualTitleSync {
    private readonly conversations = new Map<string, ConversationSync>();
    private closed = false;

    constructor(
        private readonly database: CaxriDatabase,
        private readonly renames: SessionRenameService,
        private readonly isCurrentLaunch: (terminalId: string, launchId: string) => boolean,
    ) {}

    observe(event: AgentLifecycleSignal): void {
        if (this.closed || event.agentId) return;
        if (event.phase !== 'turnStarted' && event.phase !== 'turnFinished') return;
        const terminal = this.database.getTerminal(event.terminalId);
        const session = terminal && this.database.getSession(terminal.sessionId);
        if (
            !terminal ||
            !session ||
            session.primaryAgentTerminalId !== terminal.id ||
            session.titleMode !== 'manual' ||
            session.archivedAt !== undefined ||
            !terminal.agentSessionId ||
            !terminal.provider ||
            !agentProviderCatalog[terminal.provider].capabilities.nativeRename ||
            caxriBotIdentity(this.database)?.sessionId === session.id ||
            !this.isCurrentLaunch(terminal.id, event.launchId)
        )
            return;
        const key = `${terminal.id}\u{0}${terminal.agentSessionId}`;
        const previous = this.conversations.get(key);
        if (previous?.running || previous?.isSettled) return;
        const attempts = (previous?.attempts ?? 0) + 1;
        const controller = new AbortController();
        const target = {
            terminalId: terminal.id,
            agentSessionId: terminal.agentSessionId,
            provider: terminal.provider,
            cwd: agentProviderStateRoot(terminal),
        };
        const entry: ConversationSync = { attempts, isSettled: false };
        const run = async (): Promise<void> => {
            let isSettled = false;
            try {
                isSettled = await this.renames.synchronizeManualTitle(
                    session.id,
                    target,
                    controller.signal,
                );
            } catch {
                /**
                 * The rename service already logged the outcome; an unsettled conversation retries on its next turn.
                 */
            } finally {
                entry.running = undefined;
                entry.isSettled = isSettled || attempts >= MAX_ATTEMPTS;
                if (this.closed) this.conversations.delete(key);
            }
        };
        entry.running = { controller, task: run() };
        this.conversations.delete(key);
        this.conversations.set(key, entry);
        while (this.conversations.size > CONVERSATION_CAPACITY) {
            const oldest = this.conversations.entries().find(([, sync]) => !sync.running);
            if (!oldest) break;
            this.conversations.delete(oldest[0]);
        }
    }

    async close(): Promise<void> {
        this.closed = true;
        const running = this.conversations
            .values()
            .flatMap((sync) => (sync.running ? [sync.running] : []))
            .toArray();
        for (const sync of running) sync.controller.abort();
        await Promise.allSettled(running.map((sync) => sync.task));
        this.conversations.clear();
    }
}
