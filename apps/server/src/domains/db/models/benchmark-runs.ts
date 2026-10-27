import type { BenchmarkRun } from '@caxri/protocol';
import { benchmarkRunSchema, MAX_BENCHMARK_LISTED_RUNS } from '@caxri/protocol';
import type Database from 'better-sqlite3';
import { desc, eq } from 'drizzle-orm';
import { drizzle } from 'drizzle-orm/better-sqlite3';

import type { CaxriDrizzleDatabase } from '../connection';
import * as schema from '../schema';
import { benchmarkRuns } from '../schema';

/**
 * Pure persistence for Benchmark runs. Scheduling and Attempt lifecycle live in the Benchmark domain. A document that
 * no longer parses (written by an older development build) is skipped rather than failing the whole history.
 */
export class BenchmarkRunsModel {
    private readonly database: CaxriDrizzleDatabase;

    /**
     * Takes the Server's open SQLite handle; the migration runner has already created the table on it.
     */
    constructor(connection: Database.Database) {
        this.database = drizzle(connection, { schema });
    }

    save(run: BenchmarkRun): void {
        const documentJson = JSON.stringify(run);
        this.database
            .insert(benchmarkRuns)
            .values({ id: run.id, status: run.status, createdAt: run.createdAt, documentJson })
            .onConflictDoUpdate({
                target: benchmarkRuns.id,
                set: { status: run.status, documentJson },
            })
            .run();
    }

    get(id: string): BenchmarkRun | undefined {
        const row = this.database
            .select({ documentJson: benchmarkRuns.documentJson })
            .from(benchmarkRuns)
            .where(eq(benchmarkRuns.id, id))
            .get();
        return row ? parseRun(row.documentJson) : undefined;
    }

    /**
     * Newest first, bounded.
     */
    list(): BenchmarkRun[] {
        return this.database
            .select({ documentJson: benchmarkRuns.documentJson })
            .from(benchmarkRuns)
            .orderBy(desc(benchmarkRuns.createdAt))
            .limit(MAX_BENCHMARK_LISTED_RUNS)
            .all()
            .flatMap((row) => parseRun(row.documentJson) ?? []);
    }

    listRunning(): BenchmarkRun[] {
        return this.database
            .select({ documentJson: benchmarkRuns.documentJson })
            .from(benchmarkRuns)
            .where(eq(benchmarkRuns.status, 'running'))
            .all()
            .flatMap((row) => parseRun(row.documentJson) ?? []);
    }

    delete(id: string): void {
        this.database.delete(benchmarkRuns).where(eq(benchmarkRuns.id, id)).run();
    }
}

function parseRun(documentJson: string): BenchmarkRun | undefined {
    try {
        const parsed = benchmarkRunSchema.safeParse(JSON.parse(documentJson));
        return parsed.success ? parsed.data : undefined;
    } catch {
        return undefined;
    }
}
