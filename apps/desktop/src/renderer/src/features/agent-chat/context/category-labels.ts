import type { Translate } from '../../../i18n';
import { isTranslationKey } from '../../../i18n';

/**
 * Stable ids for the context rows a provider names in English: Claude Code's `/context` categories and the Codex usage
 * breakdown. The provider's label is wire data, so the renderer maps it onto a closed id and translates that; a label
 * missing here (a row a newer CLI adds) keeps the provider's own name rather than disappearing.
 */
const CONTEXT_CATEGORY_IDS: Readonly<Record<string, string>> = {
    'System tools': 'systemTools',
    'System tools (deferred)': 'systemToolsDeferred',
    'MCP tools': 'mcpTools',
    'MCP tools (deferred)': 'mcpToolsDeferred',
    'Custom agents': 'customAgents',
    'System prompt': 'systemPrompt',
    'MCP server instructions': 'mcpInstructions',
    'Memory files': 'memoryFiles',
    'Skills': 'skills',
    'Messages': 'messages',
    'Autocompact buffer': 'autocompactBuffer',
    'Compact buffer': 'compactBuffer',
    'Free space': 'freeSpace',
    'Cached input': 'cachedInput',
    'New input': 'newInput',
    'Output': 'output',
};

/**
 * The closed id of a provider's context row label, or `undefined` for a label this build does not know.
 */
export function contextCategoryId(label: string): string | undefined {
    return Object.hasOwn(CONTEXT_CATEGORY_IDS, label) ? CONTEXT_CATEGORY_IDS[label] : undefined;
}

/**
 * The row's display name in the active locale, falling back to the provider's raw label for an unknown row.
 */
export function contextCategoryLabel(t: Translate, label: string): string {
    const id = contextCategoryId(label);
    const key = `agentChat.contextCategory.${id}`;
    return id !== undefined && isTranslationKey(key) ? t(key) : label;
}
