import { asc, eq, inArray, sql } from 'drizzle-orm';

import {
    agentDispatchFailureSchema,
    agentDispatchLaunchSchema,
    agentDispatchReceiptSchema,
    type AgentDispatchFailure,
    type AgentDispatchLaunch,
    type AgentDispatchOperation,
    type AgentDispatchReceipt,
    type AgentDispatchStatus,
} from '../../../shared/ipc/agent-dispatch-contract';
import {
    agentEndpointRefSchema,
    type AgentEndpointRef,
} from '../../../shared/ipc/agent-endpoint-contract';
import { CaxriError } from '../../../shared/ipc/errors';
import type { AgentProvider } from '../../../shared/types';
import type { CaxriDrizzleDatabase } from '../connection';
import { agentDispatchReceipts } from '../schema';

const MAX_DISPATCH_RECEIPTS = 1_024;
const ACTIVE_STATUSES: AgentDispatchStatus[] = ['requested', 'starting', 'running'];

interface DispatchRow {
    dispatchId: string;
    requestFingerprint: string;
    operation: string;
    status: string;
    projectId: string;
    sessionId: string;
    terminalId: string | null;
    provider: string;
    requestedLaunchJson: string;
    effectiveLaunchJson: string;
    endpointJson: string | null;
    failureJson: string | null;
    revision: number;
    createdAt: number;
    updatedAt: number;
}

export interface StoredAgentDispatchReceipt {
    receipt: AgentDispatchReceipt;
    requestFingerprint: string;
}

export interface NewAgentDispatchReceipt {
    dispatchId: string;
    requestFingerprint: string;
    operation: AgentDispatchOperation;
    projectId: string;
    sessionId: string;
    terminalId?: string;
    provider: AgentProvider;
    requestedLaunch: AgentDispatchLaunch;
    effectiveLaunch: AgentDispatchLaunch;
    now: number;
}

export interface AgentDispatchReceiptPatch {
    status: AgentDispatchStatus;
    terminalId?: string;
    endpoint?: AgentEndpointRef;
    failure?: AgentDispatchFailure;
    now: number;
}

function parseJson(source: string, label: string): unknown {
    try {
        return JSON.parse(source) as unknown;
    } catch {
        throw new CaxriError('INTERNAL', `Stored Agent dispatch ${label} is invalid`);
    }
}

function mapRow(row: DispatchRow): StoredAgentDispatchReceipt {
    return {
        requestFingerprint: row.requestFingerprint,
        receipt: agentDispatchReceiptSchema.parse({
            dispatchId: row.dispatchId,
            operation: row.operation,
            status: row.status,
            projectId: row.projectId,
            sessionId: row.sessionId,
            ...(row.terminalId ? { terminalId: row.terminalId } : {}),
            provider: row.provider,
            requestedLaunch: agentDispatchLaunchSchema.parse(
                parseJson(row.requestedLaunchJson, 'requested launch'),
            ),
            effectiveLaunch: agentDispatchLaunchSchema.parse(
                parseJson(row.effectiveLaunchJson, 'effective launch'),
            ),
            ...(row.endpointJson
                ? {
                      endpoint: agentEndpointRefSchema.parse(
                          parseJson(row.endpointJson, 'endpoint'),
                      ),
                  }
                : {}),
            ...(row.failureJson
                ? {
                      failure: agentDispatchFailureSchema.parse(
                          parseJson(row.failureJson, 'failure'),
                      ),
                  }
                : {}),
            revision: row.revision,
            createdAt: row.createdAt,
            updatedAt: row.updatedAt,
        }),
    };
}

/** Pure bounded CRUD for durable Agent dispatch idempotency and lifecycle receipts. */
export class AgentDispatchReceiptsModel {
    constructor(private readonly db: CaxriDrizzleDatabase) {}

    get(dispatchId: string): StoredAgentDispatchReceipt | undefined {
        const row = this.db
            .select()
            .from(agentDispatchReceipts)
            .where(eq(agentDispatchReceipts.dispatchId, dispatchId))
            .get();
        return row ? mapRow(row) : undefined;
    }

    insert(input: NewAgentDispatchReceipt): StoredAgentDispatchReceipt {
        this.db
            .insert(agentDispatchReceipts)
            .values({
                dispatchId: input.dispatchId,
                requestFingerprint: input.requestFingerprint,
                operation: input.operation,
                status: 'requested',
                projectId: input.projectId,
                sessionId: input.sessionId,
                terminalId: input.terminalId ?? null,
                provider: input.provider,
                requestedLaunchJson: JSON.stringify(input.requestedLaunch),
                effectiveLaunchJson: JSON.stringify(input.effectiveLaunch),
                endpointJson: null,
                failureJson: null,
                revision: 1,
                createdAt: input.now,
                updatedAt: input.now,
            })
            .run();
        this.prune();
        return this.get(input.dispatchId)!;
    }

    update(dispatchId: string, patch: AgentDispatchReceiptPatch): StoredAgentDispatchReceipt {
        const current = this.get(dispatchId);
        if (!current) throw new CaxriError('NOT_FOUND', 'Agent dispatch receipt was not found');
        this.db
            .update(agentDispatchReceipts)
            .set({
                status: patch.status,
                terminalId: patch.terminalId ?? current.receipt.terminalId ?? null,
                endpointJson: patch.endpoint
                    ? JSON.stringify(patch.endpoint)
                    : patch.status === 'starting'
                      ? null
                      : undefined,
                failureJson: patch.failure
                    ? JSON.stringify(patch.failure)
                    : patch.status === 'failed'
                      ? current.receipt.failure
                          ? JSON.stringify(current.receipt.failure)
                          : null
                      : null,
                revision: current.receipt.revision + 1,
                updatedAt: patch.now,
            })
            .where(eq(agentDispatchReceipts.dispatchId, dispatchId))
            .run();
        return this.get(dispatchId)!;
    }

    active(): StoredAgentDispatchReceipt[] {
        return this.db
            .select()
            .from(agentDispatchReceipts)
            .where(inArray(agentDispatchReceipts.status, ACTIVE_STATUSES))
            .all()
            .map(mapRow);
    }

    forTerminal(terminalId: string): StoredAgentDispatchReceipt[] {
        return this.db
            .select()
            .from(agentDispatchReceipts)
            .where(eq(agentDispatchReceipts.terminalId, terminalId))
            .orderBy(asc(agentDispatchReceipts.createdAt), asc(agentDispatchReceipts.dispatchId))
            .all()
            .map(mapRow);
    }

    private prune(): void {
        const count = this.db
            .select({ value: sql<number>`count(*)` })
            .from(agentDispatchReceipts)
            .get()!.value;
        const overflow = count - MAX_DISPATCH_RECEIPTS;
        if (overflow <= 0) return;
        const removable = this.db
            .select({ dispatchId: agentDispatchReceipts.dispatchId })
            .from(agentDispatchReceipts)
            .where(inArray(agentDispatchReceipts.status, ['stopped', 'interrupted', 'failed']))
            .orderBy(asc(agentDispatchReceipts.updatedAt), asc(agentDispatchReceipts.dispatchId))
            .limit(overflow)
            .all()
            .map(({ dispatchId }) => dispatchId);
        if (removable.length > 0)
            this.db
                .delete(agentDispatchReceipts)
                .where(inArray(agentDispatchReceipts.dispatchId, removable))
                .run();
        if (count - removable.length > MAX_DISPATCH_RECEIPTS)
            throw new CaxriError('CAPACITY', 'Too many active Agent dispatch receipts');
    }
}
