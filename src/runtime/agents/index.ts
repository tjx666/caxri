export { type AgentEnvironment, defaultAgentEnvironment } from './contract';
export { AgentCoordinator } from './coordinator';
export { discoverExecutable, readVersion } from './discovery';
export { AgentHookManager } from './hooks';
export type { AgentLifecyclePhase, AgentLifecycleSignal } from './hooks/contract';
export { type AgentAdapter, AgentService, createLocalAgentAdapters } from './service';
export { readAgentTranscript, resolveAgentTranscriptLocation } from './transcript';
export { AgentTranscriptWatcher } from './transcript-watcher';
