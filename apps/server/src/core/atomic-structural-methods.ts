import type { DurableCaxriMethod } from '@caxri/protocol';

import type { CoreForwardedMethod } from './core-methods';

/**
 * Pure SQLite structural commands whose handler, content-free changefeed record, and durable reply receipt can share
 * one synchronous transaction. Commands that cross filesystem, PTY, configuration, or Desktop boundaries use their
 * owning idempotency protocol instead of pretending those external effects are database-transactional.
 */
const atomicStructuralMethods = [
    'project.reorder',
    'project.setIcon',
    'project.setChatDefault',
    'session.markRead',
    'session.reorder',
    'session.reorderPinned',
    'session.setPinned',
    'session.unarchive',
] as const satisfies ReadonlyArray<CoreForwardedMethod & DurableCaxriMethod>;

type AtomicStructuralMethod = (typeof atomicStructuralMethods)[number];

const atomicStructuralMethodSet = new Set<string>(atomicStructuralMethods);

export function isAtomicStructuralMethod(method: string): method is AtomicStructuralMethod {
    return atomicStructuralMethodSet.has(method);
}
