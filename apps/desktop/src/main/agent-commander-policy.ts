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
 * `agentChat.rewind` or `agentChat.restoreFiles` admitted only for the Commander Terminal.
 * `agentChat.openPathReference` only shows a path the user attached in Finder and changes nothing. It shares the
 * Workbench's Desktop principal, so this list is its only authority boundary. The hand-over picker's
 * `commander.conversations`, `commander.session.handOver`, and `commander.session.takeBack` are the user's own grant of
 * Sessions to the Commander, the same requests the Workbench's Session menu sends; the Commander's Agent Endpoint still
 * lacks the `agents.control` they require. `commander.switchAgent` and `agentCommander.clearData` only touch the
 * Commander's own Terminal, ledger, Inbox, and workspace, and clearing still passes Main's native confirmation;
 * `commander.data` reads the sizes that dialog shows.
 */
const ADMITTED_METHODS = new Set<string>([
    'agentCommander.clearData',
    'agentCommander.openSettings',
    'agentCommander.revealSession',
    'agentCommander.stop',
    'agentChat.confirmRevertFiles',
    'agentChat.openPathReference',
    'commander.board',
    'commander.conversations',
    'commander.data',
    'commander.ensure',
    'commander.inbox.dismiss',
    'commander.inbox.list',
    'commander.inbox.merge',
    'commander.inbox.reply',
    'commander.inbox.show',
    'commander.session.handOver',
    'commander.session.takeBack',
    'commander.snapshot',
    'commander.switchAgent',
    'contextMenu.show',
    'events.recover',
    'external.open',
    'keybindings.get',
    'session.pullRequests',
    'settings.get',
    'theme.get',
    'window.fullScreen.get',
]);

/**
 * Terminal requests the window may send, and only for the Commander Terminal it learned from `commander.ensure` or
 * `commander.snapshot`. `terminal.restart` backs the pane's own Resume and Restart actions; `terminal.referenceContext`
 * is the read the pane issues on mount to resolve file links; `agentCommander.openFileLink` hands a detected file link
 * to the Workbench (see that method's JSDoc for why this cannot grant cross-Project authority).
 * `terminal.switchSurface` backs the title bar's `Terminal | Chat` toggle, and the `agentChat.*` and `agentActions.*`
 * methods are the Chat pane's whole surface once the Commander runs as a Chat. `terminal.agentUsage` is the read-only
 * usage poll behind the composer's plan pace alert, which the Chat pane mounts here as in the Workbench.
 * `agentChat.usageLimitWait` backs the usage-limit notice's Cancel and Continue now, which only touch this Chat.
 */
const TERMINAL_METHODS = new Set<string>([
    'agentActions.list',
    'agentActions.read',
    'agentChat.configure',
    'agentChat.generateHandoff',
    'agentChat.interrupt',
    'agentChat.previewRestoreFiles',
    'agentChat.read',
    'agentChat.readHistory',
    'agentChat.readImage',
    'agentChat.readTask',
    'agentChat.editQueued',
    'agentChat.removeQueued',
    'agentChat.restoreQueued',
    'agentChat.respond',
    'agentChat.restoreFiles',
    'agentChat.resumeQueue',
    'agentChat.rewind',
    'agentChat.runCommand',
    'agentChat.saveLongPaste',
    'agentChat.send',
    'agentChat.sendQueuedNow',
    'agentChat.stopTask',
    'agentChat.takeQueued',
    'agentChat.usageLimitWait',
    'agentCommander.openFileLink',
    'terminal.agentUsage',
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
 * from here". `agentChat.readContext` feeds the Context tab, a Workbench editor tab this window cannot open, so it does
 * not offer the meter's Details button either. `agentChat.continueInAgent` and the `agentChat.continuationTargets` read
 * behind it open a new Session the same way, so the window offers neither "Continue in <Agent>" nor "Open in another
 * Agent"; the usage guard's `agentChat.generateHandoff` stays admitted for the Commander Terminal.
 * `agentChat.askSideQuestion` feeds the Workbench's side chat tab, which this window has no pane for, so it offers no
 * `/btw` either. `agentChat.pendingRequests` lists every waiting Chat in every Session for the Workbench's waiting
 * popup, which this window does not mount, and it would reach past the Commander Terminal. `project.setChatDefault` is
 * not an `agentChat.*` method and stays refused with every other write.
 */
const REFUSED_AGENT_CHAT_METHODS = new Set<string>([
    'agentChat.askSideQuestion',
    'agentChat.continuationTargets',
    'agentChat.continueInAgent',
    'agentChat.fork',
    'agentChat.pendingRequests',
    'agentChat.readContext',
]);

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
    /**
     * Whether the current document has learned its Terminal. A reload clears it so PTY bytes wait for the new
     * document's `commander.ensure`, while `identity` keeps admitting the old document's last layout and resize
     * requests that are still in flight when the navigation starts.
     */
    private isViewing = false;

    constructor(private readonly onDenied: (method: string | null) => void) {}

    admit(raw: unknown): void {
        const method = methodFromEnvelope(raw);
        if (method && ADMITTED_METHODS.has(method)) return;
        if (method && TERMINAL_METHODS.has(method)) {
            const target = terminalTargetSchema.safeParse(raw);
            if (target.success && this.identity?.terminalId === target.data.params.terminalId)
                return;
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
        if (!parsed.success) return;
        this.identity = parsed.data.result.identity;
        this.isViewing = true;
    }

    /**
     * True when `terminalId` is the Terminal the Commander window views, so its output belongs to that window.
     */
    viewedTerminalId(): string | undefined {
        return this.isViewing ? this.identity?.terminalId : undefined;
    }

    ownsTerminal(terminalId: string): boolean {
        return this.viewedTerminalId() === terminalId;
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

    /**
     * The window started loading a new document: route nothing to it until that document re-learns its Terminal.
     */
    releaseView(): void {
        this.isViewing = false;
    }

    /**
     * The window closed: nothing it sent is admitted any more.
     */
    reset(): void {
        this.identity = undefined;
        this.isViewing = false;
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
