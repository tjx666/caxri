import type { Rule } from 'eslint';

const schemaVersionName = 'CURRENT_SCHEMA_VERSION';

/**
 * Rejects `CURRENT_SCHEMA_VERSION - n` in tests. An upgrade test that starts from "the version before the current one"
 * silently changes meaning the moment another migration is appended: it then replays the newer migration onto a schema
 * that already has the older one. `.agents/skills/project-architecture/references/persistence.md` requires anchoring on
 * the migration's tag through `createDatabaseBeforeMigration('<tag>')` instead.
 */
const rule: Rule.RuleModule = {
    meta: {
        type: 'problem',
        schema: [],
        messages: {
            offset: "Anchor the upgrade start on its migration tag with createDatabaseBeforeMigration('<tag>') from apps/server/src/domains/db/__tests__/pre-migration.fixture.ts, not an offset from CURRENT_SCHEMA_VERSION.",
        },
    },
    create(context) {
        return {
            BinaryExpression(node) {
                if (node.operator !== '-') return;
                const { left } = node;
                const name =
                    left.type === 'Identifier'
                        ? left.name
                        : left.type === 'MemberExpression' &&
                            !left.computed &&
                            left.property.type === 'Identifier'
                          ? left.property.name
                          : undefined;
                if (name === schemaVersionName) context.report({ node, messageId: 'offset' });
            },
        };
    },
};

export default rule;
