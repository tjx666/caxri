import { describe, expect, it } from 'vitest';

import { zhCNResources } from '../locales/zh-cn';

/**
 * Docs/i18n.md renders Session, Chat, Project, and Workbench as 会话，对话，项目，and 工作台。A Chinese sentence that keeps one of
 * them in English splits a single concept across two names.
 */
const STANDALONE_TERMS = /(?<![\w-])(?:Sessions?|Chats?|Projects?|Workbench)(?![\w-])/gu;

/**
 * Keys whose English term is intentional, each with the reason it must stay. Keep this list empty unless the term names
 * a thing outside Caxri's own vocabulary.
 */
const ALLOWED_KEYS: ReadonlySet<string> = new Set();

describe('zh-CN terminology', () => {
    it('does not leave Session, Chat, Project, or Workbench untranslated in Chinese copy', () => {
        const offenders = Object.entries(zhCNResources as Record<string, string>)
            .filter(([key]) => !ALLOWED_KEYS.has(key))
            .flatMap(([key, value]) => {
                const hits = value.replaceAll(/\{\{[^}]*\}\}/gu, '').match(STANDALONE_TERMS);
                return hits ? [`${key}: ${hits.join(', ')}`] : [];
            });
        expect(offenders).toEqual([]);
    });
});
