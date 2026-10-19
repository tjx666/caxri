/**
 * Bounds for one Agent Chat projection. Server Core keeps only the current conversation window in memory; the
 * provider's own record remains the source of truth, so a truncated projection can always be rebuilt by resuming the
 * Agent Session.
 */
export const MAX_AGENT_CHAT_ITEMS = 1_000;
export const MAX_AGENT_CHAT_TEXT_LENGTH = 64 * 1024;
export const MAX_AGENT_CHAT_OUTPUT_LENGTH = 16 * 1024;
export const MAX_AGENT_CHAT_DIFF_LENGTH = 64 * 1024;
export const MAX_AGENT_CHAT_FILE_CHANGES = 100;
/**
 * Sum of every diff in one file-change item, kept well under the aggregate budget below.
 */
export const MAX_AGENT_CHAT_FILE_CHANGE_DIFF_TOTAL = 1024 * 1024;
export const MAX_AGENT_CHAT_PLAN_STEPS = 50;
export const MAX_AGENT_CHAT_MESSAGE_LENGTH = 100_000;
export const MAX_AGENT_CHAT_PATCH_OPERATIONS = 200;
/**
 * Aggregate budget for every item's text. Oldest items are dropped (and `truncated` set) once it is exceeded, so many
 * individually valid items cannot add up to an unbounded snapshot.
 */
export const MAX_AGENT_CHAT_TOTAL_TEXT_LENGTH = 4 * 1024 * 1024;
/**
 * Bounds for one `agentChat.readHistory` page: the items older than what a Client holds, read from the history Server
 * Core keeps beyond the live projection. A page always carries at least one item, so a single large item still pages.
 */
export const MAX_AGENT_CHAT_HISTORY_PAGE_ITEMS = 200;
export const MAX_AGENT_CHAT_HISTORY_PAGE_TEXT_LENGTH = 2 * 1024 * 1024;
/**
 * Images one message may attach. Each is bounded by the smaller per-image limit the hosted providers accept (the
 * Anthropic API's 5 MB), so Caxri rejects an oversized image up front instead of letting the provider fail the turn.
 * The count stops at 20 because the Anthropic API lowers its per-image dimension limit from 8000 to 2000 pixels once a
 * request carries more than 20 images, which would fail an ordinary full-resolution screenshot.
 */
export const MAX_AGENT_CHAT_IMAGES = 20;
export const MAX_AGENT_CHAT_IMAGE_BYTES = 5 * 1024 * 1024;
/**
 * Combined bytes of one message's images. It keeps the worst-case payload where four 5 MB images already put it, so a
 * message stays inside the Anthropic API's 32 MB request limit once base64 adds a third, and the Desktop, Server Core,
 * and provider pipes carry no more than they did before the count rose.
 */
export const MAX_AGENT_CHAT_IMAGES_TOTAL_BYTES = 20 * 1024 * 1024;
/**
 * Combined bytes of the images one `dialog.selectPaths` pick reads for the composer. Larger than
 * {@link MAX_AGENT_CHAT_IMAGES_TOTAL_BYTES} because the composer resizes an oversized screenshot under the per-image
 * limit after the pick; an image past what is left of it is cited by path instead.
 */
export const MAX_AGENT_CHAT_PICKED_IMAGES_BYTES = 64 * 1024 * 1024;
/**
 * The default `agentChat.longPasteThreshold`: pasted text longer than this (in UTF-16 code units, what the input
 * counts) is saved to a file the message cites instead of landing in the input, following T3 Code's 32 KiB pasted-text
 * attachment. A paste that would push the message past {@link MAX_AGENT_CHAT_MESSAGE_LENGTH} is saved too, whatever the
 * setting, since the input would otherwise cut it.
 */
export const AGENT_CHAT_LONG_PASTE_THRESHOLD = 32 * 1024;
/**
 * A sent image's preview is a small Renderer-made thumbnail, not the image itself, so the projection stays bounded.
 */
export const MAX_AGENT_CHAT_THUMBNAIL_LENGTH = 48 * 1024;
export const MAX_AGENT_CHAT_MODELS = 50;
/**
 * Background work a Chat lists at once (subagents and background shells). Older ended tasks drop first.
 */
export const MAX_AGENT_CHAT_TASKS = 50;
/**
 * Items one task projection keeps, and its aggregate text budget. A chatty subagent evicts only its own history, never
 * the parent conversation's.
 */
export const MAX_AGENT_CHAT_TASK_ITEMS = 500;
export const MAX_AGENT_CHAT_TASK_TOTAL_TEXT_LENGTH = 512 * 1024;
/**
 * Follow-up messages a Chat holds while a turn runs, and their combined text, so the queue cannot grow without bound.
 */
export const MAX_AGENT_CHAT_QUEUE = 20;
export const MAX_AGENT_CHAT_QUEUE_TEXT_LENGTH = 256 * 1024;
