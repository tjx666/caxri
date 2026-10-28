# Caxri

Caxri is an Agent Development Environment (ADE): it organizes development work done through coding
Agents around independently deployed Servers, the Clients that connect to them, and durable
Projects, Sessions, Terminals, and Agent activity.

This glossary defines the current language after the architecture cutover. `_Avoid_` constrains new
design and code. It does not rename frozen public compatibility identifiers such as `host.status`;
those identifiers need a separate product and protocol change. For how a term's owning system
actually works, see the indexed living docs at [docs/README.md](docs/README.md).

## Execution environment

**Server**:
An independently deployable, single-tenant Caxri execution environment that owns authorized
Projects, durable work state, and managed processes.
_Avoid_: Host, backend, Local Server, Remote Server

**Client**:
A Desktop, CLI, Web, Mobile, or Agent Endpoint that connects to a Server under an explicit grant.
_Avoid_: Frontend, UI owner

**SSH Host**:
A Linux machine Desktop reaches with the user's OpenSSH configuration and runs its own Server on.
Desktop shows it in a separate window titled `SSH: <destination>`; its Projects, Terminals, and
Agents live on that machine.
_Avoid_: Remote, remote machine, Remote Server, Remote SSH, Remote Environment

**Environment**:
The Server a Workbench window is attached to: the Server on this machine, or the Server of one SSH
Host. A window has exactly one Environment, and features that cannot work across machines are
offered only in the matching one.
_Avoid_: Remote Environment, backend, Host

**Session View**:
One Client's presentation of a Session, including its pane layout, open resources, active resource, and
an optional Workbench Root override. It never owns the resources it presents. Which Session a window
shows is separate: see Open Session.
_Avoid_: Session state, Desktop state

## Work

**Project**:
A folder accessible to and explicitly authorized for a Server. A Project owns exactly one root,
regardless of whether the connecting Client runs on the same machine.
_Avoid_: Workspace, repository, directory (except for filesystem primitives)

**Session**:
A durable unit of work within one owning Project that owns Terminals, the shared Workbench Root,
and Agent activity and Attention.
_Avoid_: Conversation, tab, Session View

**Open Session**:
The one Session a window shows, persisted per window. Selecting another Session replaces it. It is
not proof of existence: archived, deleted, and hidden Sessions leave every window. A Session is the
Open Session of at most one window: choosing Open in New Window moves it into a new window, and
selecting it from another window brings that window forward.
_Avoid_: Open tab, Preview entry, selected Session

**Workbench Root**:
The currently selected authorized Project whose Files, Editor, Search, and Git surfaces a Session
operates on. A Session View may temporarily override it without changing the Session's owning
Project.
_Avoid_: Session Project, Terminal root, Client root

**Draft**:
Unsaved Editor content of a document, kept on the device where it was typed until it is saved,
reverted, or discarded, and offered back after a crash or reload.
_Avoid_: Dirty flag, tab content, Client buffer

**Terminal**:
One Shell or Agent CLI process surface inside a Session.
_Avoid_: Session, pane

**Chat**:
An Agent Terminal created with the chat surface: the same Agent CLI driven through its vendor's
structured protocol and shown as a conversation instead of a terminal grid. The same Agent
Terminal can switch between the chat and terminal surfaces and keep its Agent Session.
_Avoid_: Conversation, chat mode, Agent panel

## Agents and attention

**Agent Session**:
A provider-owned conversation identity that may continue across more than one Agent Run. User-facing
copy calls it a "conversation" (as in "Start New Conversation"), because a bare "session" in a label
reads as a Session.
_Avoid_: Session, Caxri Session

**Agent Run**:
One Agent CLI process lifecycle inside a Terminal. Resuming the same Agent Session in a new process
starts a new Agent Run.
_Avoid_: Conversation, Terminal, generation

**Conversation**:
A read view of one Agent Session's prompts, replies, and tool activity, such as the Conversation
segment of a mobile Session screen. It presents an Agent Session; it is never a Session, Chat, or
Agent Run.
_Avoid_: Chat history, Agent log

**Primary Agent**:
The first Agent Terminal in a Session, which owns that Session's generated title, activity, and
attention signals.
_Avoid_: Active Terminal, selected Agent

**Session Activity**:
The latest content-free, Server-persisted evidence that work in a Session meaningfully progressed.
Creation, submitted Terminal input, and allowlisted Primary Agent lifecycle transitions advance it;
visits, arbitrary row writes, output chunks, metadata reconciliation, and recovery do not.
_Avoid_: Agent Activity, Attention, last opened, updated timestamp

**Agent Activity**:
The Primary Agent's current reported state, independent of whether the user has seen it.
_Avoid_: Session Activity, notification, unread state

**Attention**:
A reliable Primary Agent event that tells the user a Session is waiting, completed, or failed.
_Avoid_: Output, activity

**Caxri Bot**:
The Agent built into Caxri that turns the user's requests into tasks, dispatches them to coding
Agents in visible Sessions, and reports what needs the user. It is a feature of Caxri, never the
product itself; "Bot" alone is its short form inside Caxri.
_Avoid_: Agent Commander, Commander, Caxri Agent, assistant

**Bot Inbox**:
The items Caxri Bot explicitly raised for the user to act on: pull requests it verified as
ready to merge and questions only the user can answer, shown as "Needs you" in the Caxri Bot
window. An item exists only because Caxri Bot reported it.
_Avoid_: Commander Inbox, Peer Inbox, Agent Inbox, notifications, to-do list

**Handed-over Session**:
A Session the user gave to Caxri Bot after starting it themselves, or one created from an
Agent conversation begun outside Caxri. Caxri Bot manages it like a Session it created and first
continues the existing conversation; typing into it takes it back.
_Avoid_: transferred Session, adopted Session, imported Session

**Peer Inbox**:
The Server-mediated, text-only channel through which managed Agents send, wait for, and reply to
short Peer Messages (`caxri agent message`). A message the user must approve is held, and the user
decides on it from the Desktop; a message is never typed into a Terminal.
_Avoid_: Caxri Inbox, Agent Inbox, Bot Inbox, chat

**Airplane Mode**:
A Workbench-wide state the user enters before going offline: Caxri interrupts the running turns,
compacts the conversations worth compacting, stops every Agent, and keeps Agents stopped until the
user picks which of those Sessions to resume. Agents that were working continue once resumed.
Shell tabs keep running.
_Avoid_: offline mode, flight mode, pause all

**Unread Attention**:
Attention whose current generation has not been acknowledged by any Client. Visibly focusing the
Session is one acknowledgement path, a hook-reported new Agent turn superseding it is another, and
acknowledgement is shared across all Clients.
_Avoid_: Activity, per-device notification count

## Benchmark

**Benchmark**:
One prompt run against several Entries so the user can compare what each produced, how long it took,
and what it cost. Each start of a Benchmark is one run, kept in the Benchmark history.
_Avoid_: eval, arena, leaderboard (the ranked table is one view of a Benchmark)

**Entry**:
One contestant in a Benchmark: an Agent, the model it runs, and optionally a reasoning effort.
_Avoid_: config, contestant, variant

**Attempt**:
One execution of an Entry on the Benchmark's prompt, in its own throwaway folder. An Entry has as many
Attempts as the Benchmark's repeats.
_Avoid_: trial, sample, Agent Run

**Judge**:
The model that scores every completed Attempt of a Benchmark from 0 to 100 without knowing which Entry
produced it.
_Avoid_: grader, reviewer
