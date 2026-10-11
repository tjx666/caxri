import { sql } from 'drizzle-orm';
import type { AnySQLiteColumn } from 'drizzle-orm/sqlite-core';

/**
 * Pins a `CHECK` value list to the protocol union it mirrors: omitting a member or naming a foreign one fails type
 * checking, so widening the union forces this list to change with it. The type check says nothing about the generated
 * SQL; `__tests__/schema-migration-drift.test.ts` is what fails until `drizzle-kit generate` has emitted the migration
 * that rebuilds the constraint.
 *
 * Open-ended columns (`terminals.kind`, `terminals.provider`, `agent_dispatch_receipts.provider`) deliberately carry no
 * `CHECK`: every new Agent provider would otherwise force a table rebuild for no integrity gain over the model-boundary
 * validation.
 */
export function closedValues<T extends string>() {
    return <const V extends readonly T[]>(
        values: V & ([T] extends [V[number]] ? unknown : never),
    ): V => values;
}

/**
 * SQLite evaluates `NULL IN (...)` to NULL, which a `CHECK` accepts, so nullable columns need no extra `IS NULL` arm.
 */
export function isOneOf(column: AnySQLiteColumn, values: readonly string[]) {
    return sql`${column} IN (${sql.raw(values.map((value) => `'${value}'`).join(', '))})`;
}
