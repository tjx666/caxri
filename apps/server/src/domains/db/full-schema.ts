/**
 * Every table of the Server database. drizzle-kit (`drizzle.config.ts`), the schema drift guard, and the connection's
 * query builder read this module, so a table defined in any schema file reaches migrations and queries alike.
 */
export * from './schema';
export * from './schema-agent-chat';
export * from './schema-benchmark';
export * from './schema-bot';
export * from './schema-claude-windows';
