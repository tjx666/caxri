/**
 * Error messages the Server's desktop router raises when it cannot resolve a path to a Project and Session. The CLI
 * matches them by prefix to replace the technical text with a next step, so both sides import these constants instead
 * of repeating the strings.
 */
export const PATH_OUTSIDE_PROJECTS_MESSAGE = 'Path is outside every added Project';

export const SESSION_SELECTION_REQUIRED_MESSAGE = 'Select a Session explicitly for this Project';
