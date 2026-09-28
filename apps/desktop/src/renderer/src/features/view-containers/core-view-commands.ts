import type { ExtensionViewActionRole } from '@caxri/protocol';
import { notifyListeners } from '@caxri/utils';

const MAX_PENDING_CORE_VIEW_COMMANDS = 64;
const MAX_PENDING_CORE_VIEW_COMMAND_KEYS = 64;

export interface CoreViewCommand {
    arguments: readonly unknown[];
    commandId: string;
    contextKey: string;
    role: ExtensionViewActionRole;
    viewId: string;
}

type CoreViewCommandListener = (command: CoreViewCommand) => void;

const listeners = new Map<string, Set<CoreViewCommandListener>>();
const pending = new Map<string, CoreViewCommand[]>();

function scopedViewKey(viewId: string, contextKey: string): string {
    return `${viewId}\0${contextKey}`;
}

function enqueuePending(key: string, command: CoreViewCommand): void {
    if (!pending.has(key) && pending.size >= MAX_PENDING_CORE_VIEW_COMMAND_KEYS) {
        const oldest = pending.keys().next().value;
        if (oldest !== undefined) pending.delete(oldest);
    }
    const queue = pending.get(key) ?? [];
    queue.push(command);
    if (queue.length > MAX_PENDING_CORE_VIEW_COMMANDS) queue.shift();
    pending.set(key, queue);
}

/**
 * Delivers a catalog-declared Workbench Core action without teaching the command router about a product id. Hidden
 * views retain a bounded queue so a shortcut can reveal the view and still reach its controller after React mounts it.
 */
export function dispatchCoreViewCommand(command: CoreViewCommand): void {
    const key = scopedViewKey(command.viewId, command.contextKey);
    const current = listeners.get(key);
    if (!current || current.size === 0) {
        enqueuePending(key, command);
        return;
    }
    // Isolates each Core View command subscriber so one throwing view controller cannot stop the command's other
    // subscribers from observing it; Desktop mirrors `console.error` into `logs/desktop.jsonl`.
    notifyListeners(current, command, (error) =>
        console.error('coreViewCommands.dispatch listener failed', error),
    );
}

export function subscribeCoreViewCommands(
    viewId: string,
    contextKey: string,
    listener: CoreViewCommandListener,
): () => void {
    const key = scopedViewKey(viewId, contextKey);
    const current = listeners.get(key) ?? new Set<CoreViewCommandListener>();
    current.add(listener);
    listeners.set(key, current);
    const queued = pending.get(key);
    if (queued) {
        pending.delete(key);
        for (const command of queued) listener(command);
    }
    return () => {
        const active = listeners.get(key);
        if (!active) return;
        active.delete(listener);
        if (active.size === 0) listeners.delete(key);
    };
}

export function resetCoreViewCommandsForTests(): void {
    listeners.clear();
    pending.clear();
}
