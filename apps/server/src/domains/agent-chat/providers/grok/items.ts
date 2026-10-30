import type { AgentChatModel, AgentChatRequest, AgentChatSnapshot } from '@caxri/protocol';
import { MAX_AGENT_CHAT_QUESTIONS } from '@caxri/protocol';

import { clip, isRecord, stringField } from '../../chat-items';
import type { AcpToolCall, AcpToolPresentation } from '../acp/items';
import { acpContentText, acpListedModels, acpToolSubject, acpUsage } from '../acp/items';

/**
 * Grok Build's dialect of ACP: its tool titles, `_meta` fields, reasoning efforts, and `_x.ai/ask_user_question`.
 * Inputs are untrusted JSON.
 */

type Json = Record<string, unknown>;

/**
 * The text Grok Build reports for a tool call the user rejected, e.g. `User rejected the execution for tool
 * `run_terminal_command` `. Grok Build marks such a call `failed`, the same status as a call that broke, both live and
 * in a `session/load` replay; this text is the only trace of the decline once the live session that saw the user's
 * answer is gone. Verified against Grok Build 1.0.50.
 */
const GROK_REJECTED_TEXT = /^User rejected the execution for tool `[^`\n]{1,200}`$/u;

/**
 * Grok Build titles a file tool by its action and subject (`Read `/repo/app.ts` `, `List `/repo/src` `), and names it
 * by its own identifier (`read_file`, `list_dir`) when it replays a conversation. Both become the tool names every Chat
 * surface already presents (`Read app.ts`), because a raw title holding a path otherwise reads as an MCP
 * `<server>/<tool>` name. Verified against Grok Build 1.0.62.
 */
const GROK_TOOL_NAMES: Readonly<Record<string, string>> = {
    Read: 'Read',
    read_file: 'Read',
    List: 'LS',
    list_dir: 'LS',
    get_command_or_subagent_output: 'BashOutput',
};

const GROK_TITLE_SUBJECT = /^([A-Z][A-Za-z ]{0,40}) `([^`]+)`$/u;

/**
 * How Grok Build's tool calls read in a Chat. A title of the form `Verb `subject` ` splits into a name and a subject,
 * even for a verb the table does not know yet, so its subject never lands in the name.
 */
export const grokToolPresentation: AcpToolPresentation = {
    nameAndSubject: (call) => {
        const inputSubject = acpToolSubject(call.rawInput);
        const titled = GROK_TITLE_SUBJECT.exec(call.title);
        if (titled) {
            const [, verb = '', subject = ''] = titled;
            return {
                name: GROK_TOOL_NAMES[verb] ?? verb,
                subject: inputSubject ?? clip(subject, 1_000),
            };
        }
        const title = call.title || call.kind;
        return {
            name: GROK_TOOL_NAMES[title] ?? title,
            ...(inputSubject && { subject: inputSubject }),
        };
    },
    /**
     * Grok Build titles a shell call `Execute `command` `; the raw input carries the command itself.
     */
    shellCommand: (call) =>
        stringField(call.rawInput.command) ?? call.title.replace(/^Execute `(.*)`$/su, '$1'),
    isRejected: (call: AcpToolCall) =>
        call.status === 'failed' && GROK_REJECTED_TEXT.test(acpContentText(call.content).trim()),
};

/**
 * The context window Grok Build lists for `model`, from a `models` record's `availableModels`.
 */
export function grokContextWindow(models: unknown, model: string): number | undefined {
    const available: unknown[] =
        isRecord(models) && Array.isArray(models.availableModels) ? models.availableModels : [];
    const entry = available.find((candidate) => isRecord(candidate) && candidate.modelId === model);
    const window =
        isRecord(entry) && isRecord(entry._meta) ? entry._meta.totalContextTokens : undefined;
    return typeof window === 'number' && window > 0 ? Math.trunc(window) : undefined;
}

/**
 * The current model and its context window from a `session/new` or `session/load` result's `models`.
 */
export function grokModelState(models: unknown): { model?: string; contextWindow?: number } {
    if (!isRecord(models)) return {};
    const model = stringField(models.currentModelId);
    if (!model) return {};
    const contextWindow = grokContextWindow(models, model);
    return { model: clip(model, 200), ...(contextWindow && { contextWindow }) };
}

/**
 * What the user typed, from a replayed `user_message_chunk` that Grok Build wrapped for the model: an `_x.ai/interject`
 * replays with the wrapper as `text` and the original in `content._meta.displayText`. Absent for an ordinary prompt.
 * Verified on Grok Build 1.0.62 (#1705, #1721).
 */
export function grokDisplayText(content: Json | undefined): string | undefined {
    const meta = content && isRecord(content._meta) ? content._meta : undefined;
    return meta ? stringField(meta.displayText) : undefined;
}

/**
 * The reasoning efforts a model entry lists in `_meta.reasoningEfforts`, lowest first (Grok Build lists the highest
 * first), with the entry's `_meta.reasoningEffort` default when it is one of them. Verified on Grok Build 1.0.62.
 */
function grokEfforts(entry: Json): Pick<AgentChatModel, 'efforts' | 'defaultEffort'> {
    const meta = isRecord(entry._meta) ? entry._meta : undefined;
    const listed: unknown[] =
        meta?.supportsReasoningEffort === true && Array.isArray(meta.reasoningEfforts)
            ? meta.reasoningEfforts
            : [];
    const efforts = listed
        .flatMap((effort) => {
            const id = isRecord(effort) ? stringField(effort.id) : undefined;
            return id && /^[\w-]{1,40}$/u.test(id) ? [id] : [];
        })
        .toReversed()
        .slice(0, 10);
    const defaultEffort = stringField(meta?.reasoningEffort);
    return {
        efforts,
        ...(defaultEffort && efforts.includes(defaultEffort) && { defaultEffort }),
    };
}

/**
 * The models a `models` record lists, for the Chat's model picker, each with the reasoning efforts it accepts.
 */
export function grokModels(models: unknown): AgentChatModel[] {
    return acpListedModels(models, grokEfforts);
}

/**
 * The reasoning effort a `configOptions` list (a `session/new` or `session/load` result, a `session/set_config_option`
 * result, or a `config_option_update`) reports as current.
 */
export function grokEffort(configOptions: unknown): string | undefined {
    const options: unknown[] = Array.isArray(configOptions) ? configOptions : [];
    const option = options.find(
        (candidate) => isRecord(candidate) && candidate.id === 'reasoning_effort',
    );
    const value = isRecord(option) ? stringField(option.currentValue) : undefined;
    return value && /^[\w-]{1,40}$/u.test(value) ? value : undefined;
}

/**
 * An `_x.ai/ask_user_question` request as a question request keyed by the tool call that asked it. Grok Build keys
 * answers by question text, so the question ids are positional and {@link grokQuestionAnswers} maps them back.
 */
export function mapGrokQuestion(
    id: string,
    questions: unknown,
): Extract<AgentChatRequest, { kind: 'question' }> {
    const list: unknown[] = Array.isArray(questions) ? questions : [];
    return {
        id,
        kind: 'question',
        questions: list.slice(0, MAX_AGENT_CHAT_QUESTIONS).flatMap((question, index) => {
            const text = isRecord(question) ? stringField(question.question) : undefined;
            if (!text || !isRecord(question)) return [];
            const options: unknown[] = Array.isArray(question.options) ? question.options : [];
            return [
                {
                    id: `q${index}`,
                    header: '',
                    question: clip(text, 2_000),
                    options: options.slice(0, 20).flatMap((option) =>
                        isRecord(option)
                            ? [
                                  {
                                      label: clip(stringField(option.label) ?? '', 200),
                                      description: clip(
                                          stringField(option.description) ?? '',
                                          1_000,
                                      ),
                                  },
                              ]
                            : [],
                    ),
                    // Grok Build accepts any answer text, like its terminal UI's free-form reply.
                    allowsOther: true,
                    ...(question.multiSelect === true && { multiSelect: true }),
                },
            ];
        }),
    };
}

/**
 * The `_x.ai/ask_user_question` response for the Client's positional answers: answers keyed by question text, a list
 * for a multi-select question and one string otherwise. No answer at all is a cancelled question, so the turn goes on
 * without the user's choice.
 */
export function grokQuestionAnswers(
    questions: unknown,
    answers: Readonly<Record<string, readonly string[]>>,
): Json {
    const list: unknown[] = Array.isArray(questions) ? questions : [];
    const entries = list.slice(0, MAX_AGENT_CHAT_QUESTIONS).flatMap((question, index) => {
        const text = isRecord(question) ? stringField(question.question) : undefined;
        const chosen = Object.hasOwn(answers, `q${index}`) ? answers[`q${index}`] : [];
        if (!text || chosen.length === 0 || !isRecord(question)) return [];
        return [[text, question.multiSelect === true ? [...chosen] : chosen.join(', ')]];
    });
    return entries.length > 0
        ? { outcome: 'accepted', answers: Object.fromEntries(entries) }
        : { outcome: 'cancelled' };
}

/**
 * How long xAI's prompt cache is assumed to survive an idle Grok Build Chat, in minutes. xAI publishes no lifetime (its
 * guide says entries can be evicted at any time) and Grok Build reports no expiry, so this is an estimate: local Grok
 * Build sessions still read most of their prompt from the cache after 30 to 60 idle minutes, and stopped doing so after
 * a few hours. It drives the composer's cache notice and idle compaction only.
 *
 * @see https://docs.x.ai/developers/advanced-api-usage/prompt-caching/best-practices
 */
const GROK_CACHE_TTL_MINUTES = 60;

/**
 * Context usage from a `session/prompt` result's `_meta.totalTokens`, the conversation's token count after the turn.
 * `respondedAt` is when the turn's last response arrived, which starts the estimated cache lifetime.
 */
export function grokUsage(
    result: unknown,
    contextWindow: number | undefined,
    respondedAt = Date.now(),
): AgentChatSnapshot['usage'] {
    const meta = isRecord(result) && isRecord(result._meta) ? result._meta : undefined;
    return acpUsage(meta?.totalTokens, contextWindow, GROK_CACHE_TTL_MINUTES, respondedAt);
}

/**
 * Parameters shared by `session/new` and `session/load`. `askUserQuestion: true` lets Grok Build ask through its
 * `_x.ai/ask_user_question` extension, which the Chat shows as a question card.
 */
export function grokSessionParameters(cwd: string): {
    cwd: string;
    mcpServers: [];
    _meta: Json;
} {
    return { cwd, mcpServers: [], _meta: { askUserQuestion: true } };
}
