import type { AppLocale } from './language-settings-spec.js';
import type { AppSettings } from './settings-schema.js';

/**
 * Caxri's built-in Session instructions: what an ordinary Agent needs to know to start work in another Session, added
 * to its context at launch: through the `UserPromptSubmit` hook in a Terminal, and through the system or developer
 * instructions in an Agent Chat.
 *
 * Without it an Agent only learns about the Caxri CLI when the `caxri-cli` skill happens to be installed, so asking it
 * to "open a new Session for this" ends in a background process the user cannot see (issue #2061). It also limits
 * Sessions to an explicit request: "batch these issues" once read as "parallelize" and filled the sidebar with Sessions
 * the user never asked for (issue #2612). Changes to another repository are the exception: they go to a Session in that
 * repository's Project, since only there do its own agent files and skills load (issue #3572). The last sentence names
 * the typed asks, so an Agent reaches for them without a separate dispatcher installed. It stays a short pointer: the
 * version-matched guide behind `skills get` owns the commands, so this text never drifts from them. It is never stored
 * in settings, so every profile follows the installed version's text (issue #4058). Caxri Bot gets its own workspace
 * instructions instead.
 */
export const BUILT_IN_AGENT_SESSION_INSTRUCTIONS = `You are running inside Caxri, a desktop workbench that lists every Agent Session in the user's sidebar. Work in this repository stays in this Session: batching, parallelizing, or delegating it means subagents and workflows, not new Sessions. Create another Session for this repository only when the user asks for one; for an unrelated new task you may suggest one. Changes to another repository belong to a Session in that repository's Project, where its own agent files and skills apply; reading it for reference needs no Session. Start and manage Sessions with the Caxri CLI, never a background process: run \`"$CAXRI_CLI" skills get caxri-cli --full\` and follow its "Start work in another Session" section. For a second opinion, a code review by another Agent, operating a signed-in browser or desktop app when you have no computer-use tools of your own, or a live X (Twitter) search, run \`"$CAXRI_CLI" agent delegate create --type second-opinion|review|computer-use|x-search\` as its "Ask another Agent" section describes.`;

/**
 * Upper bound for `agents.sessionInstructions.custom`. Every launch pays for this text in context, and Codex reads hook
 * `additionalContext` as one entry, so a page of text is plenty.
 */
export const MAX_AGENT_SESSION_INSTRUCTIONS_LENGTH = 4_000;

/**
 * What the user chose to add to each Agent's context: Caxri's built-in instructions, their own text appended after
 * them, both, or neither.
 */
export interface AgentSessionInstructionSettings {
    includeBuiltIn: boolean;
    custom: string | null;
}

export function agentSessionInstructionSettings(
    settings: Pick<
        AppSettings,
        'agents.sessionInstructions.includeBuiltIn' | 'agents.sessionInstructions.custom'
    >,
): AgentSessionInstructionSettings {
    return {
        includeBuiltIn: settings['agents.sessionInstructions.includeBuiltIn'],
        custom: settings['agents.sessionInstructions.custom'],
    };
}

/**
 * English names of each {@link AppLocale}, for an Agent that reads its instructions in English.
 */
const AGENT_LOCALE_NAMES: Record<AppLocale, string> = {
    'en': 'English',
    'zh-CN': 'Simplified Chinese',
};

/**
 * Names Caxri's interface language for the text an Agent writes for the user to read in Caxri. A delegated task file is
 * the new Session's first message, shown in the user's Chat; without this line an Agent wrote it in English, the
 * language of its code and agent files, while the rest of the page spoke the user's language.
 */
export function agentDisplayLanguageInstruction(locale: AppLocale): string {
    const name = AGENT_LOCALE_NAMES[locale];
    return `Caxri's interface language is ${name}. Write the task file and title of every Session you create in ${name}, since the new Session shows the task file as its first message; keep code, identifiers, paths, and commands as they are.`;
}

/**
 * The instructions to add to an Agent's context: the built-in text with {@link agentDisplayLanguageInstruction} for
 * `locale` when `includeBuiltIn` is on, then the user's own text. The language line follows only the built-in text,
 * since it only matters to an Agent told how to start Sessions. `undefined` means there is nothing to add.
 */
export function agentSessionInstructions(
    settings: AgentSessionInstructionSettings,
    locale?: AppLocale,
): string | undefined {
    const parts: string[] = [];
    if (settings.includeBuiltIn) {
        parts.push(BUILT_IN_AGENT_SESSION_INSTRUCTIONS);
        if (locale) parts.push(agentDisplayLanguageInstruction(locale));
    }
    const custom = settings.custom?.trim();
    if (custom) parts.push(custom);
    return parts.length > 0 ? parts.join('\n\n') : undefined;
}
