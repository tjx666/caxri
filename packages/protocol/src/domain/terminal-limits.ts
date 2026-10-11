export const MAX_TERMINAL_INPUT_LENGTH = 65_536;
/**
 * Allows a 1 MiB paste plus xterm's 12-character bracketed-paste envelope. The private Terminal Host frame stays
 * independently smaller and is chunked before delivery.
 */
export const MAX_TERMINAL_INPUT_PAYLOAD_LENGTH = 1_048_576 + 12;
export const MAX_TERMINAL_LINK_LENGTH = 16_384;
export const MAX_TERMINAL_LINK_ROWS = 16;
export const MAX_TERMINAL_OSC_LINKS = 1_000;
export const MAX_TERMINAL_OSC_LINK_CELLS = 256 * 1_024;
export const MAX_TERMINAL_OSC_LINK_TARGET_CHARACTERS = 256 * 1_024;
