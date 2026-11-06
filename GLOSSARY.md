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
Desktop lists its Projects in the same window as this machine's, marked with the Host's icon; its
Projects, Terminals, and Agents live on that machine.
_Avoid_: Remote, remote machine, Remote Server, Remote SSH, Remote Environment

**Host mark**:
The icon, and when two machines would otherwise look alike the name, that shows which SSH Host a
Project heading or Session row belongs to. Rows on this machine carry none.
_Avoid_: Host badge, remote tag, machine label

**Relay**:
A separately deployed rendezvous service that lets a paired phone reach a Server from outside its
network by joining the two connections without being able to read them.
_Avoid_: Gateway, tunnel, proxy, relay server, 中转服务器

**Route**:
The network path one Mobile connection took to its Server: direct (LAN or Tailscale) or Relay.
_Avoid_: Transport, channel, path

**Environment**:
One Server a Workbench window reaches: the Server on this machine, or the Server of one SSH Host.
A window reaches every connected Environment at once; each Project and Session belongs to exactly
one, and features that cannot work across machines are offered only for the matching one.
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

**Delegated Session**:
A Session an Agent creates for a task it then waits on and reads the result of. The Session records
the Session that created it, and the sidebar lists it under that Session. A Hand-off, a Consult, or an Independent
Session is not one, and neither is a Session Caxri Bot dispatches a task to.
_Avoid_: Child Session, sub-Session, subagent

**Redirect**:
A Delegated Session's delegator changing the direction of a task that is running now, as one message
steered into the task's current turn or refused. It is never queued and never starts a turn, and it
is not the user taking the Chat over.
_Avoid_: Interrupt, steer (as a noun), mid-task follow-up

**Parent approval**:
An Agent's one-shot decision (accept or decline) on a permission request of a Session it delegated a
task to, allowed only when the request falls within the permission that Agent has applied to its own
Chat. Anything beyond it, and any request the Agent does not decide within 90 seconds, goes to the
user.
_Avoid_: Auto-approve, proxy approval, child approval

**Hand-off**:
A Session's work carried on in a new Session instead of waiting on a task there; the new Session
reads as continued from the first. It starts from the Chat `/new-session` command or from continuing
a Chat in another Agent, and both use the first Session's Project; an Agent that hands off on its
own may name another Project. It is not a Handed-over Session, which the user gives to Caxri Bot.
_Avoid_: Transfer, fork, hand-over

**Consult**:
A question or review an Agent asks another Agent in a new Session, not meant to change any files.
The Session records the Session that asked, and the sidebar gives it no row while the Session that
asked is listed. It is neither a Delegated Session nor a Hand-off.
_Avoid_: Side Session, review Session, Delegated Session

**Independent Session**:
A sibling Session an Agent starts because the user asked for a separate, parallel Session for its
own task, which the Agent does not wait on. The Session records the Agent's Session as its creator,
which may still rename and archive it, but the creator is sent no notice when it settles, is rolled
up none of its cost or attention, and is not asked its questions or approvals: they go to the user.
The sidebar gives it an ordinary row with a "Started from" line. It is not a Delegated Session, and
unlike a Hand-off the creator's own work does not move there.
_Avoid_: Sibling Session, detached Session, spin-off

**Delegation history**:
The durable record of tasks that settled: who created them, how they ended, a title and summary to
search, and provider token counters. It outlives the pruning of task records and the deletion of
their Sessions, and an Agent reads only its own. It also keeps the Session that created each
delegated, consulted, or handed-off Session, which is how a Chat states the estimated cost of
everything below it.
_Avoid_: delegation log, task archive

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

**Pending Attention**:
Attention the user has not resolved yet. Reading does not resolve it; marking the Session done, a
new Agent turn, or the question being answered elsewhere does. It decides whether the Activity view
lists a Session under Needs attention, while Unread Attention only decides how the row looks.
_Avoid_: Unhandled, todo

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
