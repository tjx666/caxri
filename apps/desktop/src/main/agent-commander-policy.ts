import type { CaxriReply } from '@caxri/protocol';
import { CaxriError, methodFromEnvelope } from '@caxri/protocol';
import { z } from 'zod';

/**
 * Requests the Agent Commander window may send without naming a Terminal. Everything here is either a read the window
 * renders, the Commander's own lifecycle (including stopping it), a Workbench hand-off that only raises the Workbench
 * (`agentCommander.revealSession`, `agentCommander.openSettings`), or the Terminal pane's native context menu
 * (`contextMenu.show`), which Main pops over this window and which only reports the chosen entry back: the entry's
 * action is a Renderer request admitted here on its own. The Inbox admits the owner's side only (read, reply, dismiss,
 * merge): the Commander's own `add`, `resolve`, and `ack` stay out, so the window can never speak for the Commander.
 * Anything that edits files, Projects, Settings, or another Session's Terminal is deliberately absent, and so are
 * `app.bootstrap` and `app.records`: the window reads its rows through `commander.snapshot`. `session.pullRequests` is
 * the board's own pull request read: the board patches its rows from it after a `sessionPullRequests.changed` event,
 * and it answers from the same snapshot `commander.board` embeds, so it exposes nothing the board does not already
 * show. `agentChat.confirmRevertFiles` names no Terminal: it only asks the native confirmation before "Edit from here"
 * or "Restore code to here" reverts files and returns the answer, and the revert itself is a separate
 * `agentChat.rewind` or `agentChat.restoreFiles` admitted only for the Commander Terminal. It shares the Workbench's
 * Desktop principal, so this list is its only authority boundary.
 */
const ADMITTED_METHODS = new Set<string>([
    'agentCommander.openSettings',
    'agentCommander.revealSession',
    'agentCommander.stop',
    'agentChat.confirmRevertFiles',
    'commander.board',
    'commander.ensure',
    'commander.inbox.dismiss',
    'commander.inbox.list',
    'commander.inbox.merge',
    'commander.inbox.reply',
    'commander.inbox.show',
    'commander.snapshot',
    'contextMenu.show',
    'events.recover',
    'external.open',
    'keybindings.get',
    'session.pullRequests',
    'settings.get',
    'theme.get',
]);

/**
 * Terminal requests the window may send, and only for the Commander Terminal it learned from `commander.ensure` or
 * `commander.snapshot`. `terminal.restart` backs the pane's own Resume and Restart actions; `terminal.referenceContext`
 * is the read the pane issues on mount to resolve file links; `agentCommander.openFileLink` hands a detected file link
 * to the Workbench (see that method's JSDoc for why this cannot grant cross-Project authority).
 * `terminal.switchSurface` backs the title bar's `Terminal | Chat` toggle, and the `agentChat.*` and `agentActions.*`
 * methods are the Chat pane's whole surface once the Commander runs as a Chat.
 */
const TERMINAL_METHODS = new Set<string>([
    'agentActions.list',
    'agentActions.read',
    'agentChat.configure',
    'agentChat.interrupt',
    'agentChat.read',
    'agentChat.readImage',
    'agentChat.readTask',
    'agentChat.removeQueued',
    'agentChat.respond',
    'agentChat.restoreFiles',
    'agentChat.resumeQueue',
    'agentChat.rewind',
    'agentChat.runCommand',
    'agentChat.saveLongPaste',
    'agentChat.send',
    'agentChat.sendQueuedNow',
    'agentChat.stopTask',
    'agentCommander.openFileLink',
    'terminal.attach',
    'terminal.detach',
    'terminal.input',
    'terminal.inputAgentExact',
    'terminal.inputBinary',
    'terminal.prepareLongPaste',
    'terminal.referenceContext',
    'terminal.resize',
    'terminal.restart',
    'terminal.switchSurface',
]);

/**
 * The pane persists its own layout and focus; admitted only for the Commander Session, so the window cannot rewrite a
 * Workbench Session's state.
 */
const SESSION_METHODS = new Set<string>(['session.updateState']);

/**
 * `agentChat.*` methods refused even for the Commander Terminal. Every `agentChat.*` method must sit in one of the
 * admitted sets or here, so a new Chat request is classified on purpose instead of failing as `FORBIDDEN` in the
 * Commander window (the unit test walks the protocol registry). `agentChat.fork` opens a new Session in the Commander's
 * hidden system Project and selects it, and this window has no Workbench to show it; the window does not offer "Fork
 * from here". `project.setChatDefault` is not an `agentChat.*` method and stays refused with every other write.
 */
const REFUSED_AGENT_CHAT_METHODS = new Set<string>(['agentChat.fork']);

/**
 * How the policy classifies `method`, or `undefined` when it names none of its sets (so it is refused by default).
 * Exposed for the exhaustiveness test.
 */
export function agentCommanderMethodClass(
    method: string,
): 'admitted' | 'refused' | 'session' | 'terminal' | undefined {
    if (ADMITTED_METHODS.has(method)) return 'admitted';
    if (TERMINAL_METHODS.has(method)) return 'terminal';
    if (SESSION_METHODS.has(method)) return 'session';
    if (REFUSED_AGENT_CHAT_METHODS.has(method)) return 'refused';
    return undefined;
}

const terminalTargetSchema = z.object({ params: z.object({ terminalId: z.string() }) });
const sessionTargetSchema = z.object({ params: z.object({ sessionId: z.string() }) });
const commanderIdentityReplySchema = z.object({ sessionId: z.string(), terminalId: z.string() });
const snapshotReplySchema = z.object({
    result: z.object({ identity: commanderIdentityReplySchema }),
});

/**
 * Main-side admission policy for the Agent Commander Renderer. It owns two facts: which requests the window may send,
 * and which Terminal the window is viewing so Main can route that Terminal's PTY output to it instead of the
 * Workbench.
 */
export class AgentCommanderRendererPolicy {
    private identity: z.infer<typeof commanderIdentityReplySchema> | undefined;

    constructor(private readonly onDenied: (method: string | null) => void) {}

    admit(raw: unknown): void {
        const method = methodFromEnvelope(raw);
        if (method && ADMITTED_METHODS.has(method)) return;
        if (method && TERMINAL_METHODS.has(method)) {
            const target = terminalTargetSchema.safeParse(raw);
            if (target.success && this.ownsTerminal(target.data.params.terminalId)) return;
        }
        if (method && SESSION_METHODS.has(method)) {
            const target = sessionTargetSchema.safeParse(raw);
            if (target.success && this.identity?.sessionId === target.data.params.sessionId) return;
        }
        this.onDenied(method);
        throw new CaxriError('FORBIDDEN', 'The Agent Commander window cannot send this request');
    }

    observeReply(raw: unknown, reply: CaxriReply): void {
        if (!reply.ok) return;
        const method = methodFromEnvelope(raw);
        if (method !== 'commander.ensure' && method !== 'commander.snapshot') return;
        const parsed = snapshotReplySchema.safeParse(reply);
        if (parsed.success) this.identity = parsed.data.result.identity;
    }

    /**
     * True when `terminalId` is the Terminal the Commander window views, so its output belongs to that window.
     */
    viewedTerminalId(): string | undefined {
        return this.identity?.terminalId;
    }

    ownsTerminal(terminalId: string): boolean {
        return this.identity?.terminalId === terminalId;
    }

    /**
     * Decides which Renderer receives one relay message. Durable journal envelopes reach both windows so each window's
     * recovering event client sees a gap-free cursor sequence. Transient messages are one-shot: reconnect and pull
     * request notices reach both windows, PTY bytes follow the window that views the Terminal, and everything else,
     * including UI commands (`command.execute`, `desktop.openRequested`), stays with the Workbench so a menu
     * accelerator never runs twice.
     */
    route(message: unknown): { commander: boolean; workbench: boolean } {
        /**
         * Runs for every PTY chunk, so it reads plain properties instead of parsing a schema.
         */
        if (typeof message !== 'object' || message === null)
            return { commander: false, workbench: true };
        if ('cursor' in message) return { commander: true, workbench: true };
        if (isSharedTransientEvent(message)) return { commander: true, workbench: true };
        const terminalId = transientTerminalId(message);
        const isCommander = terminalId !== undefined && this.ownsTerminal(terminalId);
        return { commander: isCommander, workbench: !isCommander };
    }

    reset(): void {
        this.identity = undefined;
    }
}

/**
 * Transient events both windows act on. A reconnect dropped PTY output to every mounted pane, the Commander's included,
 * the board shows the pull requests this announces, and the Inbox sidebar re-reads on an Inbox change. None is a
 * command, so delivering it twice runs nothing twice.
 */
const SHARED_TRANSIENT_EVENTS = new Set<string>([
    'commanderInbox.changed',
    'host.connectionChanged',
    'sessionPullRequests.changed',
]);

const TERMINAL_SCOPED_TRANSIENT_EVENTS = new Set<string>([
    'agentChat.patch',
    'agentChat.taskPatch',
    'terminal.output',
    'terminal.outputRecovery',
    'terminal.sizeOwnership',
]);

/**
 * The two fields routing reads from a relay message; everything else about the message is irrelevant here.
 */
interface RelayMessageFields {
    readonly event?: unknown;
    readonly payload?: unknown;
}

function isSharedTransientEvent({ event }: RelayMessageFields): boolean {
    return typeof event === 'string' && SHARED_TRANSIENT_EVENTS.has(event);
}

function transientTerminalId({ event, payload }: RelayMessageFields): string | undefined {
    if (typeof event !== 'string' || !TERMINAL_SCOPED_TRANSIENT_EVENTS.has(event)) return undefined;
    if (typeof payload !== 'object' || payload === null) return undefined;
    const terminalId: unknown = Reflect.get(payload, 'terminalId');
    return typeof terminalId === 'string' ? terminalId : undefined;
}
