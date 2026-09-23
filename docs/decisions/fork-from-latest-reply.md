# Fork from latest reply — decision (0.1.33)

**Decision: not implementing in 0.1.33.**

## What the feature would be

A per-message "fork here" action (Claudian's last-message fork button) that
creates a new native session whose history is truncated to the source
session's transcript up to the selected assistant reply.

## Why we are not doing it now

1. **The protocol has no anchor.** ACP `session/fork` (and co-ober's
   `AcpClient.forkSession`, used by `/fork` and side chat) forks the *whole*
   session — there is no message/checkpoint parameter to fork "through
   reply N". We verified the v2-alpha RFDs: the fork shape is unchanged.
2. **Native-side truncation is unsafe.** Rewriting or prefixing rows in
   opencode's storage (v1 `message`/`part` or v2 `session_message`) would
   mutate a database the agent owns while it may be live — risking corrupt
   mirrors on top of the fork migration we already have to defend against.
3. **Client-side replay is a lossy fake.** Replaying a prefix of the
   transcript into a fresh session loses native message ids (breaking the
   usage/turn-stats/tool-error enrichment added in 0.1.32/0.1.33), replays
   token cost for context the model never saw, and diverges from what the
   agent's own compaction/state tracking considers "this session".
4. **The existing equivalents cover today's needs.** Session-level `/fork`
   plus side chat (`/btw`, itself a fork) give branch-away-from-current-state;
   because OpenCode forks copy history through the *latest* reply, "fork from
   latest reply" is exactly what `/fork` already does. The gap is only
   forking from an *older* reply, which the protocol cannot express.

## Revisit trigger

Re-evaluate when ACP exposes a fork with a message/checkpoint anchor (watch
the v2 session RFDs) or when opencode ships a fork API that accepts a
`messageID` boundary. The hook points are already known: a per-message
action in `ChatRenderer` message wraps and a controller method alongside
`CoOberViewController.forkSession`.
