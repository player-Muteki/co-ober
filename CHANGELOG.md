## 0.2.91 - 2026-10-20

0.2.90 stopped listing the empty shell a new tab leaves behind. This round went after the number the footer prints for a session that is *not* empty, and found the v2 usage read had been summing the wrong book all along.

### Fixed

- **Native usage reports what the kernel booked, not what the visible messages carried.** `buildSessionUsageSqlV2` never looked at the session row: it summed `$.tokens.*` over every `assistant` row of `session_message`, took cost from `step-finish` parts inside `$.content`, and took the context size from `$.tokens.total`. Measured on 2.0.28 against the real database, both derived clauses read a shape this kernel does not write — of its 1,389 assistant events **0 carry a step-finish part and 0 carry `tokens.total`** (the part types that appear at all are `tool` 1,371, `reasoning` 779, `text` 438), and only `assistant` events carry tokens anywhere — so cost read 0 and context read *absent* for every session on the host, while the token sum was wrong in **both** directions. Across the 16 real sessions of the two working vaults the sum understated the registry's own `tokens_input` by 19…4,136 (849,163 against the kernel's 852,017 on one session), whereas the one session whose events are all still present (13 events, `max(seq)+1 == count(*)`) answers 21,235 from both sources — the natural control that shows the registry is the fuller of two accounts, not an inflated one. A live rig (`session/new`, three prompts, one `session/fork`, both rows deleted afterwards, residue 0, the database back at 22 sessions and 1,740 events) settled the fork case: the kernel **copies the ancestor's assistant events into the new thread** while the new thread's registry row starts at zero, so a side chat that had not spoken yet summed its parent's whole lifetime (11,527 copied input tokens against a row reading 0/0) and, after its own single turn, read 13,994 against the 2,467 it had actually spent. That reverses the reason 0.2.89 recorded for choosing the event sum — "the legacy `session` bookkeeping may lag the event log after a fork" — on a database that today holds **zero** rows with a `parent_id` or `fork_session_id`, so no fork thread had ever been read against real data: the event log is the ledger that lags, and it is the one contaminated by ancestry. The same rig located where the lifetime difference is born: a session's **first** turn moved the registry 452 input/5 output more than the events, while its second turn moved both books by the identical 420/5. The v2 read now takes the six `cost`/`tokens_*` columns from the registry row itself — `session_v2` when that table is the registry, `session` for an older fork that still shares the legacy one — the source the v1 read already trusts, reusing the cached schema probe so no extra query runs; and it derives the context size from the newest assistant event that actually has a `tokens` object as `input + output + reasoning + cache.read`, the kernel's own identity, satisfied by 12 of the 12 legacy `message` rows that carry a `total` and every one of which has `cache.write` 0 — so write stays out of the sum rather than being guessed in. An event with no `tokens` object is skipped instead of read as a zero context, which keeps the meter's "not reported" distinct from an empty window. Through the plugin's own pipeline over the same real database, six sampled sessions now match the registry on all six columns (849,163 → 852,017) and answer a context number (472,253 on that session) where they previously answered nothing.

### Validation

- 86 test files / 2,598 tests (2,595 baseline plus three new). The 19 pre-existing, platform-bound failures in `NativeSessionReader.test.ts` and `commandResolution.test.ts` are unchanged; TypeScript (`tsc --noEmit`) and ESLint are clean. The real-SQLite fixture gained the **measured** 2.0.28 event shape — assistant rows with a top-level `tokens` object, no `total`, no step-finish part — beside registry rows chosen so the two books cannot agree by accident: a live session whose registry reads 12,000 input against an event sum of 11,948, and a fork whose registry reads 0/0 while its events carry the copied ancestor's 11,527. Each new test asserts the competing sum alongside the number it expects, so the measurement is in the test, not just in the doc. Revert-check: the production reader alone backed out fails exactly five tests (`23 = 18 + 5`) — the three new ones, the rewritten SQL-shape assertion (which now pins `step-finish` and `$.tokens.total` *out* of the query so the dead clauses cannot be written back), and the pre-existing `returns fork-correct results`, whose usage expectation moved from the event sum to the registry row. One new test only half discriminates: the context clause of `leaves context unreported when no assistant turn gave tokens` returns NULL on both sides, so that test discriminates on the token source alone. No user-facing string changed, so no i18n keys were added.

### Still open

Cost has no numeric evidence: every `cost` in this database is 0 in both books because the host runs free models, so the fix is proved on shape (0 of 1,389 step-finish parts) and not on value. `buildMessageStatsSqlV2` carries the identical two dead clauses into per-message replay footers — cost from step-finish, `total_tokens` from `tokens.total` — which is why `attachNativeUsage` hangs `cost: 0`/`totalTokens: 0` on every restored assistant message; both are falsy and the footer does not print them, so it is the same defect waiting, not a lie yet. The context number only reaches the meter once the live wire has supplied a window size: a restored session with no new turn still reads "—", which is honest but no longer necessary. Whether the extra first-turn booking is the session-title call is an inference; whether deleted event rows (up to 1,828 sequence holes on one session) also contribute is unresolved; and `cache.write`'s place in the kernel's `total` cannot be decided from 12/12 zero samples. 0.2.90's queue is unchanged.


## 0.2.90 - 2026-10-20

0.2.89 made the native listing read the registry the kernel actually writes, and that put a previously invisible row back in front of the user. This round went to the real database for the evidence 0.2.89 §6 had asked for and could not find.

### Fixed

- **Native history no longer lists a session nobody ever spoke into.** Measured on 2.0.28 against the real `~/.local/share/opencode/opencode.db`: of 22 `session_v2` rows, 21 carry at least one `user` event and one — `ses_ec5edcbb4…` — carries exactly one `agent-switched` event, no title, no model, an empty `path`, and `time_updated` 14 ms after creation; the next registry row appears 1.3 s later and is the one that got the message. Read through the plugin's own pipeline over the working vault, that row was one of 16 listed entries labelled with its raw `ses_…` id (title falls back to the id), and restoring it produced a transcript of **0 messages** — an empty pane for a conversation that never happened. The registry read now requires, for the `session_v2` registry only, `exists (select 1 from session_message sm where sm.session_id = s.id and sm.type = 'user')`. The same readout fixes the condition's shape: two other untitled rows are *kept* because their user event survives a failed turn (`idle_outcome: "failed"`, `provider.auth` 403) — so `title is not null` would have hidden real questions — and `time_idle` would hide a session typed into but not yet run. The filter is not attached to the legacy registry at all, because a database whose registry is `session` is not promised a `session_message` table; 0.2.89 is precisely the lesson in naming a table that may not be there. Same call, same database after the change: 15 entries, the two errored conversations still there, content search unchanged at 4 hits.

### Validation

- 86 test files / 2,595 tests (2,592 baseline plus three new). The 19 pre-existing, platform-bound failures in `NativeSessionReader.test.ts` and `commandResolution.test.ts` are unchanged; TypeScript (`tsc --noEmit`) and ESLint are clean. The new tests extend the real-SQLite fixture suite with rows copied from the measured shapes and assert both premises in one database: the listing is `['ses_now','ses_errored']` with the shell (newest timestamp in the registry) absent, the shell's transcript is empty, and the untitled session restores its question and is still found by searching the Chinese text. Revert-check with the production reader backed out entirely: `20 = 18 baseline + 2` — one failure is the behaviour test, one is a SQL-shape assertion added to 0.2.85's filter test (it pins that the user-event clause rides `session_v2` and never the legacy registry); the search test passes on both sides, so it is recorded as a boundary guard rather than a discriminator. Backing out only the `exists` line, after the rig added the third test: `21 = 18 + 3`, with the bare-row test failing alongside it and the search test still passing. No user-facing string changed, so no i18n keys were added.
- 0.2.89's second open item is closed with a measurement, and it says less than it looks: `session_v2` **does** carry `agent` and `model` (36 columns; 22/22 rows with an agent, 18/22 with a model, `model` holding a JSON object, not an id), but a repo-wide read for `SessionMeta.agent` / `.model` finds no consumer at all, so the v2 listing not selecting them was never a user-visible gap. The code comment claiming forked databases "do not guarantee the columns" is corrected in place, and the 0.2.89 research doc's open item is annotated as measured.

### Still open

How the shell is born was inferred in the first pass and is now measured, and the inference was wrong in a way that made the premise stronger: a rig running `session/new` twice against a scratch directory with no prompt at all wrote two registry rows carrying `title null`, `agent null`, `model null` and **zero** `session_message` events (the abandoned row in the user's own database additionally had one `agent-switched` event, so its agent was written after creation); the plugin listed none of it for that cwd while the raw registry held 2 rows, and `session/delete` removed both rows and all their events with no residue (22 → 24 → 22). Whether co-ober should offer to clean up never-used sessions is still a product decision, but the delete path needed no new work. Untitled sessions still display as raw ids even though the kernel's `slug` column is non-empty on 16/16 of this vault's rows (13 of them also titled); no evidence yet that a generated name is the label users want. A reconstructed transcript still opens with the plugin's own persona prompt because the kernel stores it as the first `user` event (7,339 characters here, with the user's actual sentence at the end). The panel-level integration test (0.2.86 §8), branch-tab history visibility and the ghost disposition entry point remain in the queue.

## 0.2.89 - 2026-10-20

0.2.88 closed the restart path for a thread's id. This round found, on the same real database, that the gate deciding *which session registry to read* has been answering wrong on this host the whole time — and it was invisible because the failure is caught.

### Fixed

- **Native history reads the kernel's current sessions again.** The fork-evidence read asked for three counts in one query, and one of them named `data_migration`. Measured on 2.0.28 against the real `~/.local/share/opencode/opencode.db`, **that table does not exist** (the kernel's migration bookkeeping is `migration`, 50 rows); SQLite rejects a query over a missing table at prepare time, so the whole evidence read threw, its catch returned the documented default — registry `session` — and the listing read the fossilized legacy table. The measured readout: 2 legacy rows database-wide against 22 in `session_v2` (16 of them in the working vault), so `listNativeSessions` answered **one** session, titled "提交并推送 Dashboard 更改" and last touched 2026-10-02, for a vault whose newest conversation was from the afternoon of the day the measurement ran. After the fix the same call over the same database returns 16, the newest first, and content search, transcript (234 messages) and usage read through the ids it lists. The evidence read now asks **existence first, in forms that cannot fail** — `sqlite_master` is a list and `pragma_table_info` of an absent table is empty, both measured — then counts rows only for the tables it proved present, so a renamed or dropped table costs an honest `0` rather than the listing. Two more anchors moved with it: the registry is taken from `session_v2` only when that table holds all ten columns the listing selects, `session_message` exists, and it actually has rows (a `session_v2` without the lineage column now falls back to the legacy registry instead of throwing, and an empty one cannot answer "no sessions" to a full database); and the legacy `session` shape is no longer the sole proof that a database is readable, so a kernel that dropped `session` outright is read through a complete `session_v2` instead of being declared incompatible and switching native history off.

### Validation

- 86 test files / 2,592 tests (2,588 baseline plus four new). The 19 pre-existing, platform-bound failures in `NativeSessionReader.test.ts` and `commandResolution.test.ts` are unchanged; TypeScript (`tsc --noEmit`) and ESLint are clean. The new fixtures are **real SQLite files**, because "a query over an absent table is an error" is the one thing a stub can lie about: the 2.0.28 shape (fossilized `session`, current `session_v2`, no `data_migration`) must list and search the current session while hiding the lineage-owned scratch row; a `session_v2` missing `fork_session_id` classifies as v1 and lists the legacy row rather than rejecting; a database with no legacy `session` at all classifies as forked and lists; and a database with neither registry still classifies incompatible and refuses. Each fixture deletes the file it wrote (including `-wal`/`-shm`) and touches no real database. Test doubles that identified the fork-evidence read by `data_migration` now identify it by `registry_v2_rows` and answer the measured shape. Revert-check: the production reader alone backed out, this test file fails exactly the three discriminating tests (21 = 18 baseline + 3, and the same 18 come back with the fix restored); the fourth new test — neither registry readable — passes on both sides by design and is a boundary guard, not a discriminator. No user-facing string changed, so no i18n keys were added.

### Still open

Whether any OpenCode version actually shipped a `data_migration` table is still unverified — the older code comment claiming it does not reproduce on this host, and it is recorded as unsupported rather than reinterpreted. 0.2.85's filter comparison was also re-read and corrected in place: it ran raw SQL against the database rather than the plugin's own read pipeline, so it evidenced the `where` clause, not the registry the plugin was choosing. `agent` and `model` are still absent from native history entries on a forked database: the v2 listing never selected them, and whether `session_v2` carries them is unmeasured. The panel-level integration test (0.2.86 §8), zero-message shell sessions, branch-tab history visibility and the ghost disposition entry point remain in the queue.

## 0.2.88 - 2026-10-20

0.2.87 closed the delete path's leak while explicitly leaving the crash/restart path open: the side-chat id lived only in memory. A restart this round measured the two facts that make closing it both necessary and safe.

### Fixed

- **The tab shell now carries its `/btw` thread's id across restarts, so the delete path can still forget it.** Measured on 2.0.28 (`fork-restart` rig): a fork row survives the kernel process being killed — the between-processes database read showed both parent and fork intact — and a fresh process loads and deletes the old fork id normally. So the leak is not transient: every restart without the id strands another thread that no gesture can ever name (no parent-delete cascade, 0.2.87; the lineage filter hides the rows, 0.2.85). The same rig showed the fix is silent-safe: `session/delete` answers `ok {}` for an already-deleted id **and** for an id that never existed, so a persisted stale id can never produce a false `sideChatDeleteUnconfirmed`. `TabShell` gains an optional `sideChatSessionId`; `persistTabShell` writes it, `startSideChat` persists the shell the moment the fork exists, `endSideChat` persists again the moment the id is let go (a released thread must not come back as a name on disk), and `restoreTabShells` hands the id back to the runtime before the shell is rewritten. `migratePluginDataTabs` — which rebuilds shells field by field and would otherwise strip an unknown key — carries the field through, accepting only a non-empty string. Downstream needed no change: `deleteSession` already reads `rt.sideChatSessionId` (0.2.87), an idle restored close is the silent release (0.2.86), and a re-asked `/btw` reuses the thread (fork continuity).

### Validation

- 86 test files / 2,588 tests (2,584 baseline plus four new). The 19 pre-existing, platform-bound failures in `NativeSessionReader.test.ts` and `commandResolution.test.ts` are unchanged; TypeScript (`tsc --noEmit`) and ESLint are clean. Boundaries: the sanitizer carries the id and drops a number or empty string without dropping the tab; `startSideChat` lands the id on the shell; `endSideChat` takes it off (the test first asserts it was on, so it cannot pass unfixed); and the restart case — `restoreTabShells` handed only a shell carrying the id, then `deleteSession` — asks `client.deleteSession` for parent and thread, exactly two calls, claiming nothing. Revert-check: the three production files backed out fails exactly the four new tests (23 = 19 baseline + 4) and nothing else. No user-facing string changed, so no i18n keys were added.
- The 0.2.87 research doc's open item naming the crash/restart leak is annotated as closed with the measured answer.

### Still open

Orphans created **before** this version cannot be retroactively adopted — their ids were never on disk, and the database rows they forked still await the cleanup entry point (0.2.87 §7) that no gesture owns yet. The restart brings the thread's identity back, not its panel: the user re-asks `/btw` to continue it, which is deliberate — a shell should not remember UI openness. A side thread still has no title or history entry of its own. And 0.2.86's idle-audit question (`hasSubmittedPrompt` firing meaningless requests against idle threads) remains unaudited.

## 0.2.87 - 2026-10-20

0.2.85 hid forked rows from the native history with the lineage filter and left one question unmeasured: what happens to a fork when its parent is deleted? A full-lifecycle rig deleted the parent first this time, and the answer turned the product question "keep or delete ghosts?" into a leak the plugin is now responsible for.

### Fixed

- **Deleting a conversation now forgets its side chat with it.** Measured: `session/delete` does not cascade — after the parent's row and transcript are taken, each fork survives with its messages intact, still wearing a `fork_session_id` that names the row no longer there, and the kernel keeps serving it: `session/load` and `session/prompt` answered the orphans normally (even the one closed earlier), and ACP `session/list` still showed them. The plugin's own lineage filter (0.2.85) hides those rows from every listing, a `/btw` fork was never in the session mirror, and the id lived only in `rt.sideChatSessionId` — which the teardown clears. If the delete gesture does not take the thread, no gesture ever can. `deleteSession` now captures the tab's side id **before** `closeTab` releases it, and after the parent's confirmed delete asks the kernel to forget the thread through the same gate (capability advertised, session addressable). Parent confirmed but thread unconfirmed says so on the new line (`error.sideChatDeleteUnconfirmed`, en+zh); no delete capability means no ask and no claim, the same silence the parent keeps. Deleting child-first or parent-first both work — the earlier rigs deleted child-then-parent and this one parent-then-child; the code keeps parent-first so the headline fact lands before the annex.

### Validation

- 86 test files / 2,584 tests (2,581 baseline plus three new). The 19 pre-existing, platform-bound failures in `NativeSessionReader.test.ts` and `commandResolution.test.ts` are unchanged; TypeScript (`tsc --noEmit`) and ESLint are clean. Boundaries: both ids reach `client.deleteSession` exactly once (and the thread's id must survive being read before teardown — a late read would silently miss every thread); a confirmed parent with an unconfirmed thread speaks only the new line; an agent without the delete capability is asked for neither and hears no claim; the 0.2.82 delete semantics and the 0.2.86 idle-release behavior regress unchanged. Revert-check: restoring the controller to its committed state fails exactly the two discriminating tests (21 = 19 baseline + 2); the third test is an over-claim guard, green on both sides by design. The rig deleted all of its own rows in the same run: the final read showed every id null and every message count zero.
- The 0.2.85 research doc's open item 4 (parent-delete cascade) is annotated as closed with the measured answer.

### Still open

The crash/restart path still leaks: `sideChatSessionId` lives only in memory, so after an Obsidian restart the plugin cannot remember a living fork's id and `deleteSession` cannot take it — plugging that needs persisting the id, a separate single point. Orphans created outside the plugin remain unreachable by definition. And the user-facing branch fork (`forkSession` to a new tab) carries the same `fork_session_id` the 0.2.85 filter hides, so branch tabs vanish from the native section of the history (they stay findable in the plugin's own mirror) — whether they should be visible natively is a product decision, untouched this round.

## 0.2.86 - 2026-10-20

0.2.80 gave the side chat's stop answer an owner, and along the way wrote the doctrine that an unconfirmed stop must be spoken. But every answer that path weighs is an answer about a *running* turn, and 0.2.80 had no way to know whether a thread had a turn at all. This round adds that witness.

### Fixed

- **Closing an idle side-chat thread no longer asks it to stop, and no longer claims a stop it never watched.** Measured facts, all from prior rounds (no new rig): the kernel's `session/cancel` is unimplemented on 2.0.28 and maps to `'unsupported'` (0.2.74, `acp.ts:1218`); a close taken mid-turn ends that live turn and can confirm the stop (0.2.81); a close of an *idle* session only releases it (0.2.85). Before this fix `endSideChat` asked `cancelSideChat` for any thread that held an id, idle or not, then composed stop-evidence from the answer. On the main path the false `'unsupported'` is masked — the release close is accepted and answers `'closed'` — but on the paths where the release close is skipped (the parent session unaddressable after a reconnect, or the agent not advertising `close`) an idle thread printed "the side chat may still be answering" about a turn that never existed, and `cancelAllStreams` folded that same phantom into its "stopped N turns that may still be running" count. Even where masked, every idle close fired a doomed `-32601` request and awaited it. The fix: `SessionRuntime` gains a `sideChatBusy` flag — the controller's own witness — raised synchronously before the ask wrapper's first `await` and cleared in its `finally` (normal settle or throw). `endSideChat` records `wasBusy` before releasing the id; the release `closeSession` still fires for an idle thread (that release is legitimate and prevents a leaked fork on the agent side), but with `!wasBusy` it returns `null` without cancelling, composing evidence, reporting to the tab, or feeding the view-close count. `abortSideChat` stays ungated: the panel only aborts a busy turn, so reaching it already means a live turn.

### Validation

- 86 test files / 2,581 tests (2,577 baseline plus four new). The 19 pre-existing, platform-bound failures in `NativeSessionReader.test.ts` and `commandResolution.test.ts` are unchanged; TypeScript (`tsc --noEmit`) and ESLint are clean. Boundaries: an idle close sends no `cancel`, still sends the release `closeSession`, resolves `null`, and speaks no stop line; the busy witness is raised while a send is in flight and cleared on both settle and throw; a multi-tab view-close leaves the idle thread out of the unconfirmed-stop toast. The 12 existing "close a busy side chat" tests now state their live-turn precondition directly (`rt.sideChatBusy = true`) because the mocked panel never runs the real ask — they stay green across the change, and all prior stop-evidence semantics regress clean (`stopped` quiet, accepted close overriding an `unsupported` cancel, thrown cancel unconfirmed, broken close not swallowing the answer, one shared cancel per gesture). Revert-check: restoring the two production files to their pre-fix state fails exactly the four new tests (23 = 19 baseline + 4) and nothing else. No user-facing string changed (this only suppresses a false line), so no i18n keys were added.

### Still open

The busy witness is synchronous, and the real `SideChatPanel.open(question)` starts `send()` with `void`; the guard-refusal window between Enter and the flag raise is reasoned from code, not measured on a panel-level integration harness. Whether other "ask the kernel for evidence" paths (e.g. `hasSubmittedPrompt`) also fire meaningless requests against an idle thread was not re-audited this round. If the kernel ever implements `cancel`, the `'unsupported'` line disappears but the "no turn, no stop claim" gate is answer-independent and stays correct.

## 0.2.85 - 2026-10-20

0.2.83 §7.1 handed forward a finding: `session/fork` records no parentage, so a side-chat ghost is an ordinary session and the history cannot tell it apart. A full-lifecycle rig this round ran the fork's row column by column and found the claim was wrong — and wrong in the direction that makes the honest fix available.

### Fixed

- **The native history listing and search now hide forked sessions, using the column the kernel actually writes.** Measured: a rig `session/fork` on 2.0.28 stores its parent's id in `fork_session_id` while `parent_id` stays null. The 0.2.83 "NULL across the entire database" readout was a zero-sample generalization — the surviving 21 rows contained no fork at all (rig rows were deleted on use, and side chat had never been exercised on a real conversation); re-checking the same database reproduced the all-null counts and explains why the error looked true. The listing has intended "top-level sessions only" ever since it wrote `parent_id is null`; the lineage filter now reads `parent_id is null and fork_session_id is null` — but only when the registry is `session_v2`, because the legacy `session` table has no such column and naming it there would break every read on a shared-registry fork. The side-chat ghost goes back into being what the design says it is: a scratch thread, not untitled litter wearing a `ses_…` name in the history dropdown. Deliberately not delete-on-close: the same rig showed the ghost's transcript is fully readable from `session_message` and its id stays addressable after an idle close (load and even prompt answered `ok`) — silently deleting the archive would burn the last window before the product decision is made with user evidence. The two facts refine 0.2.81's record too: close interrupts and kills a live turn, close of an idle session only releases.

### Validation

- 86 test files / 2,577 tests (2,575 baseline plus two new). The 19 pre-existing, platform-bound failures in `NativeSessionReader.test.ts` and `commandResolution.test.ts` are unchanged; TypeScript and ESLint are clean. Boundaries: both v2 builders carry `s.fork_session_id is null` exactly when the registry is named `session_v2` and never otherwise — defaults and v1 output stay byte-identical; a fake database with the forked-registry evidence shows the executed listing and search queries both carry the filter. Revert-check: collapsing `v2RegistryWhere` back to the unbranched where fails exactly the two new tests (20 = 18 + 2). Live proof on the real database: with a ghost present the old listing returned 18 rows including it, the filtered listing returned 17 without it and kept the parent; `fork_session_id` equalled the parent's id. Both rig rows were `session/delete`d in the same run.
- The 0.2.83 research doc carries an inline correction note at the wrong claim (its §3.2.2 and §7.1), so the record shows what was measured, what was over-generalized, and what fixed it.

### Still open

Ghosts are hidden, not gone: the data stays in the kernel, and a recovered side chat would need an entry point that remembers the fork id, because the listing no longer shows it — the delete/keep decision waits for user evidence, not another rig. A registry in `session_v2` without a `fork_session_id` column would make the filtered query throw, and the reader would honestly report "unavailable" — an unmeasured shape. The close live-vs-idle boundary's middle case (close racing a turn's natural end by milliseconds) was not probed. Parent-delete cascade for forks remains unmeasured — this round's rigs deleted child-then-parent. And four existing rows carry null title and null update time (shell sessions from never-used `session/new`s, no lineage); whether history should hide zero-message shells waits on knowing what creates them.

## 0.2.84 - 2026-10-20

0.2.83 §7.5 left one question open: the kernel stores forward slashes, and nobody had positive evidence that the cwd the plugin hands its own directory filter matches that shape. On this Windows host the answer was no — and it silently undid half of last release's fix.

### Fixed

- **Native history filters now compare in the shape the kernel stores.** Measured with a live rig: `session/new` handed the Obsidian-shape cwd `D:\ObsidianVaults\kys-in-whu-cs` writes the row as `directory = 'D:/ObsidianVaults/kys-in-whu-cs'` — the kernel normalizes separators at sqlite write time, while ACP `session/list` still echoes the raw backslash shape, so matching through the protocol's own echo is not an option. Every `session_v2.directory` row in the real database is slash-shaped (16 + 1 + 4 across three directories; the fossil `session` table too), and the plugin's predicate built from the raw backslash cwd matched 0 of them — the `=` arm is exact, and the `like` arm escapes doubled backslashes into literal backslashes, so neither can hit. On Windows this meant the 0.2.83 table fix changed nothing visible: the dropdown's native section kept rendering zero sessions for a vault with 16 live sessions. All four directory-filter builders (v1/v2 listing and search) now run the cwd through a new `normalizeNativeDirectory` (backslash → slash) before embedding it. Normalization is deliberately chosen over matching both shapes: §3.2 shows the write side has exactly one shape, and a slash-through filter is the identity for every input that was already working — POSIX vaults, slash-shaped `getBasePath`, and the whole existing test suite are byte-for-byte unchanged.

### Validation

- 86 test files / 2,575 tests (2,571 baseline plus four new). The 19 pre-existing, platform-bound failures in `NativeSessionReader.test.ts` and `commandResolution.test.ts` are unchanged; TypeScript and ESLint are clean. Boundaries: the helper's three input shapes; all four builders emit `= 'D:/vault'` and `like 'D:/vault/%'` for a backslash input and no backslash literal in the predicate; a fake database that answers only the stored slash shape still lists and still content-finds the session through `listNativeSessions`/`searchNativeSessions` called with a backslash cwd. Revert-check: un-normalizing the four builders fails exactly the three predicate-carrying tests (21 = 18 baseline + 3) and nothing else; the helper's own unit test survives by design — it is not what the revert touches.
- The end-to-end proof ran against the user's real database: the same vault, the same predicate, 16 rows in the normalized shape and 0 in the raw backslash shape. The rig's probe session was deleted via `session/delete` in the same run; no leftover rows. The normalization claim is measured on 2.0.28 alone; the research doc records the un-observed edges (trailing separators from `getBasePath` — not observable outside a running Obsidian, so no preventive trim was added; drive-letter case; UNC paths; whether v1 kernels normalized at write or the fossil rows were normalized by migration).

### Still open

With both fixes stacked, the Windows vault's native history will for the first time actually render — which promotes the 0.2.83 ghost-fork question from theoretical to visible: spent side-chat sessions now appear in the list with their id as title. Their disposition (delete on close, the capability having existed since 0.2.82) remains a product decision pending measurement. The compatibility gate is still anchored on the `session` table's existence; parent-delete cascade for forks is still unmeasured; and the directory filter's exact-match case sensitivity waits on evidence, not on this fix.

## 0.2.83 - 2026-10-20

0.2.82 §7 asked whether side-chat forks pollute the native history with ghost sessions. Answering that required knowing which table the history actually reads — and the forensic rig found a worse fact first: on the installed `opencode v2.0.28` the `session` table is a fossil (2 rows, a week old, both duplicated in `session_v2`) while every new session, including today's, lands only in `session_v2` (25 rows). The plugin's native listing and content search had been reading the fossil table all along.

### Fixed

- **Native session listing and search now read the registry the kernel actually writes.** Measured against the real `~/.local/share/opencode/opencode.db`: a same-directory filter through the old SQL (`from session`) returns 0 rows, through the new one (`from session_v2`) returns 4 real sessions — every modern conversation was unlistable and unsearchable while the fossil rows sat there looking like history. The fork-evidence probe gained a third readout, `pragma_table_info('session_v2')` row count, and the schema cache now holds `{kind, registry}` alongside the kind. The registry choice is deliberately conservative: non-forked databases keep reading `session` byte-for-byte as before; a forked database switches to `session_v2` only when that table actually has rows; a forked database whose evidence read fails or comes back empty stays on `session` — "no evidence" is not evidence of the new location, and answering "there are no sessions" from an empty or missing table would be worse than reading a fossil. Older forked kernels (v1.18 shape: shared registry, only messages migrated) are explicitly guarded and keep their old behavior. The two SQL builders take the registry as a parameter defaulting to `'session'`, so their no-argument output is identical to before. A second measured fact rides along: `session/fork` on 2.0.28 records no parentage at all (`parent_id` and `fork_session_id` are NULL across the entire database), so the side-chat ghosts 0.2.82 worried about are ordinary sessions at the data layer — `where parent_id is null` cannot filter them, and they were invisible only because the listing was reading the wrong table.

### Validation

- 86 test files / 2,571 tests (2,567 baseline plus four new). The 19 pre-existing, platform-bound failures in `NativeSessionReader.test.ts` and `commandResolution.test.ts` are unchanged; TypeScript and ESLint are clean. Boundaries, each confirmed to discriminate: a forked database with registry rows lists the current id, not the fossil one; search executes `from session_v2 s` with the `like` filter; a forked database without registry rows keeps reading the shared `session` table (guarding against the over-fix "saw forked, switch tables"); the builders default to `from session s` and honor the registry argument. Revert-check: dropping the registry argument at the two call sites fails exactly the two wiring tests (20 = 18 baseline + 2) and nothing else; restoring returns to 19. The new tests pass an explicit `databasePath` so they bypass the host-dependent path discovery that makes the 18 baseline failures platform-bound — the discrimination holds on any platform.
- The database forensics above are the user's real kernel database, and the rig's 4 leftover rows were cleaned at release time via `session/delete`. The 0-vs-4 same-directory readout was reproduced at release time. The registry inference is measured on 2.0.28 alone; the research doc records the extrapolation boundary (a dual-write kernel would be right either way; a kernel that moved the registry to a third table falls back to the fossil, which needs new measurement, not a guess).

### Still open

Fixing "modern sessions invisible" makes "ghost forks now visible" a real product question — whether `endSideChat` should `session/delete` the spent fork (the capability exists since 0.2.82) needs a measurement of whether users ever want a side chat back, not a code decision. The compatibility gate itself is still anchored on the `session` table's existence — a future pure-`session_v2` database would be judged incompatible and degrade the whole native reader, which is the honest 0.2.50 degradation path but the wrong gate. Parent-delete cascade for forks is unmeasured again (the rig's first readout was a confound: the fork had already been closed, and close-kills-id is 0.2.81's measured fact). Directory slash semantics between the kernel's stored paths and a Windows cwd remain unevidenced on the real vault.

## 0.2.82 - 2026-10-20

0.2.81 found that a closed session stays in the list, loadable, back after a restart. That fact indicts the delete button: a user deleting a session was getting a `close` plus a local mirror removal — the kernel's row was never asked to forget. A new live rig measured what `session/delete` actually does, and the two `{}` acks turned out to mean completely different things.

### Fixed

- **Deleting a session now asks the kernel to forget it, and says so when the promise fails.** Measured on the installed `opencode v2.0.28`: `initialize` advertises `sessionCapabilities.delete`; `session/delete` answers `{}` and the session vanishes from `session/list`, later prompts and loads against the id answer `-32602 session not found`, and the id is still gone after a reconnect — while a control session closed instead of deleted remains listed and loads with full `configOptions`. A second rig confirmed a previously-closed session is still addressable for delete (`close` releases, it does not unaddress). `deleteSession` was doing neither: it closed the tab (stop, 0.2.81), removed the local mirror and said nothing about the row left behind — history that returns after a restart is a fact the reader needs. The view now gates the ask on three things the measurement backs — the agent advertises `delete`, the client implements the call, the id is addressable (0.2.78) — and awaits the answer. An accepted delete is silent, because it is simply done; a delete the promised agent failed confirms nothing, and the transcript says the session left this vault while its history may still be kept inside the agent; an agent that never advertised a delete is not accused of lacking one — silence, exactly as before. Client-layer plumbing: the `deleteSession` logical method maps to `session/delete`, `AcpClient.deleteSession` returns whether the agent acknowledged and clears its local metadata either way, `AgentCapabilities.sessionCapabilities` gained `delete`.

### Validation

- 86 test files / 2,567 tests (2,562 baseline plus five new). The 19 pre-existing, platform-bound failures in `NativeSessionReader.test.ts` and `commandResolution.test.ts` are unchanged; TypeScript and ESLint are clean. Boundaries, each confirmed to discriminate: an acked `session/delete` returns `true`, clears session metadata and puts `session/delete` + `{ sessionId }` on the wire; the client wrapper delegates; an advertised-and-addressable session gets the forget ask and the mirror removal; a delete answering `false` speaks `sessionDeleteUnconfirmed`; an agent without the capability is never asked and never blamed. The discrimination was run at both layers at once — gating the view off and neutering the client call fails exactly the three move-carrying tests and nothing else.
- Both rigs were re-run at release time and reproduced the first session's readouts line for line; the research doc records the reruns. The forget claim is measured on 2.0.28 alone and gated on the capability advertisement — the same extrapolation boundary 0.2.81 recorded, now for delete.

### Still open

What `session/delete` removes beyond the ACP-visible state (files, logs, storage outside the row the list reads) is unmeasured; the claim is limited to what the protocol shows. `NativeSessionReader` reads the same database and should stop seeing a deleted session, but that cross-check was not rigged. Side-chat forks still only get closed, never deleted — whether a spent side chat should be forgotten is a product decision awaiting measurement of what users can recover. And any real agent implementing `session/cancel` — `stopped` on evidence — remains unobserved through three releases.

## 0.2.81 - 2026-10-20

0.2.80 closed with a promise: the next round would measure, not route — specifically what `session/close` does to a live turn. A new live rig against the installed `opencode v2.0.28` answered, and the answer indicts the other kind of dishonesty: a pessimistic claim with no evidence behind it.

### Fixed

- **A close the agent accepted is stop evidence, and the unconfirmed-stop reports now treat it that way.** Measured: `initialize` advertises `sessionCapabilities.close`; a `session/close` sent while a turn is verifiably live (chunks still arriving in the half-second before the gesture — a first run whose turn had ended on its own was discarded as non-discriminating, not reinterpreted) answers `{}` in 39 ms, resolves the live prompt `stopReason: "cancelled"` in the same millisecond, emits zero updates after, and kills the id (`-32602 session not found` for a later prompt, while a control `session/new` on the same connection succeeds). This kernel has no cancel method (0.2.74) — close is how it stops turns. Yet `closeSession` swallowed its ack, `closeTab` and `endSideChat` fired it without awaiting, and the reader was still told the turn "may still be running in the kernel" seconds after the agent had confirmed the opposite. `closeSession` now returns whether the agent acknowledged; `endSideChat` combines the two answers into a new evidence value `'closed'` (cancel confirmed nothing, close did); `closeTab` awaits the release it already performs, and stays silent when it is confirmed; `cancelAllStreams` does not count a `'closed'` side turn. A close that fails, is refused or throws confirms nothing — the unconfirmed claim survives it, and the two are separated by discriminating tests in both directions.

### Validation

- 86 test files / 2,562 tests (2,554 baseline plus eight new). The 19 pre-existing, platform-bound failures in `NativeSessionReader.test.ts` and `commandResolution.test.ts` are unchanged; TypeScript and ESLint are clean. Boundaries: an acked close returns `true` and a failed one returns `false` without throwing; a side close accepted after an `unsupported` cancel returns `'closed'` and says neither side-chat line (the old code discarded the ack and still spoke — reverting fails this); a close answering `false` keeps the claim (guards against suppressing on mere attempt); a close that throws cannot swallow the cancel's answer; closing a busy tab whose session-close was accepted leaves the survivor silent, while an unaccepted close still reports; a main-plus-side close confirms both lines away; a view close over a running side chat cancels, closes and produces no notice. The suppression's discrimination was verified by removing `!sessionReleased` and watching the test fail.
- The rig run that produced §3 of the research doc is this release's kernel evidence. `stopped` remains exercised only against the mock contract; the close-as-stop inference is measured on 2.0.28 alone, which the research doc states as an open boundary rather than a universal claim.

### Still open

`session/cancel` implemented by any real agent is still unobserved; an agent that advertises `close` without ending live turns would inherit this inference wrongly — the capability gate is the only shield. View close still cannot confirm main turns, because it deliberately does not close their sessions.

## 0.2.80 - 2026-10-20

Closes the last of the cancel paths 0.2.74 listed: the side chat. Closing a busy side panel did not merely forget the answer — it asked twice, from two different callers, and forgot both.

### Fixed

- **A closed side chat's stop result went nowhere, and its cancel went out twice.** `SideChatPanel.close()` calls `abort()` when the turn is in flight, then its `onClose` hook calls `endSideChat`, which called `abortSideChat` again — two `cancel()` requests for the same fork, each `.catch`-logged or dropped. The panel is then removed, so even the first answer had no surface left. On the installed `opencode v2.0.28` cancel is unimplemented (0.2.74 measured `-32601` for all nine spellings; 0.2.76 measured the round trip), so both asks were being told the turn could not be stopped and neither answer reached the reader. There is now one shared cancel per side session (`sideCancels`), the panel's abort and the close hook receive the same promise, and `endSideChat` returns the outcome: `unsupported` and `unknown` are written into the parent tab's transcript, `stopped` is silent, and a cancel that throws is `unknown` rather than a warning on the console. The report survives the panel because the tab does.
- **The same result is carried through the two closes that remove the tab itself.** `closeTab` awaits the side outcome before deleting the runtime and writes an unconfirmed side stop into the tab that inherits the slot, alongside the tab's own turn — the two are reported separately because the agent can answer differently about each. `cancelAllStreams` now ends each runtime's side thread before it counts, so a view closed over a running side chat adds it to the same `Notice`; previously that cancel happened later in `dispose`, after the notice had already been decided, and was silent.

### Validation

- 86 test files / 2,554 tests (2,547 baseline plus seven new). The 19 pre-existing, platform-bound failures in `NativeSessionReader.test.ts` and `commandResolution.test.ts` are unchanged; TypeScript and ESLint are clean. Seven boundaries, each confirmed to discriminate: an `unsupported` side stop is said in the owning tab; a throwing side cancel is said as `unknown` (the old code warned and said nothing); a confirmed stop says neither line; the panel's abort followed by its close issues exactly one `cancel()` and still reports; closing a tab with a main `unsupported` and a side `unknown` puts both lines in the survivor; a tab whose only running turn is the side chat reports the side line and not the tab line; and a view close over an idle main tab with a running side chat counts that side turn in its notice. Reverting to the old two-call shape fails the first and fourth; dropping the catch-to-`unknown` fails the second; reporting on `stopped` fails the third; not awaiting the side outcome in `closeTab` fails the fifth and sixth; leaving side cancels in `dispose` fails the seventh.
- The kernel facts routed here are the ones measured on 2.0.28 in 0.2.74 and 0.2.76; this release changes who asks and where the answer is said, not what the agent does with a cancel. No new live rig was needed, and the `stopped` branch remains exercised only against the mock contract.

### Still open

Every close surface now reports an unconfirmed stop: Stop, the idle watchdog, `/compact`, tab close, view close and the side chat. What remains is not another discard point but the measurement itself: `stopped` has never been observed on an agent that implements cancel, `session/close` is still unmeasured against a live turn, and every kernel fact here comes from 2.0.28. The note also waits in a background tab's transcript rather than pulling the reader to it, which is the same choice every other transcript message makes.

## 0.2.79 - 2026-10-20

Takes the view-close path of the 0.2.74 gap. Closing the panel cancels every running turn, and the panel — every surface the plugin owns — is destroyed in the same act, so the cancel results had nowhere to go and went nowhere.

### Fixed

- **Closing the view discarded every cancel result, then removed the only screen that could have shown one.** `cancelAllStreams` awaited each `cancel()` inside a `try` whose only consumer was `console.error`. On the installed `opencode v2.0.28` cancel is unimplemented (0.2.74 measured all nine spellings answering `-32601`; 0.2.76 measured the round trip at 545 ms and the live stream count at zero afterwards), so a panel closed mid-turn was telling the reader, by closing, that its turns had stopped — while the client had just been told it could not stop them. It now counts the outcomes it was discarding: every `unsupported` or `unknown`, and every cancel that throws, is one unconfirmed turn; `stopped` is not. If any remain, one Obsidian `Notice` outlives the panel and says how many may still be running. The wording picks the weaker claim: if any turn's stop went unconfirmed, the toast says exactly that rather than asserting the agent has no cancel method, because that stronger statement is not what every answer supports. A close in which every cancel was acknowledged stays silent.

### Validation

- 86 test files / 2,547 tests (2,543 baseline plus four new). The 19 pre-existing, platform-bound failures in `NativeSessionReader.test.ts` and `commandResolution.test.ts` are unchanged; TypeScript and ESLint are clean. Four boundaries, each confirmed to discriminate: one `unsupported` and one `stopped` produces a count of 1 with the unsupported line; one `unsupported` and one `unknown` produces a count of 2 with only the weaker "not confirmed" line (asserting the unsupported line is absent); a cancel that throws counts as one unconfirmed turn; two confirmed stops produce no toast at all. Reverting to a discarded await fails the first three; reporting on `stopped` fails the fourth; counting throws as stops fails the third; claiming "no cancel method" in the mixed case fails the second.
- The kernel facts routed here are the ones measured on 2.0.28 in 0.2.74 and 0.2.76; this release changes where the answer is said, not what the agent does with the cancel, so the boundaries are UI-level and no new live rig was needed. The `stopped` branch is exercised against the mock contract, not against an agent that implements cancel.

### Still open

The side-chat path (`abortSideChat`, reached both by closing the side panel and by `endSideChat` during tab close and view teardown) still discards its outcome. It has two different destinations to choose between: when only the side panel closes, the parent tab survives and could carry the note; when the parent tab or view closes too, it cannot. That distinction is the next release. The `stopped` branch and the question of whether `session/close` terminates a running turn remain measured only by mocks and only on 2.0.28.

## 0.2.78 - 2026-10-20

Takes the next of the cancel paths 0.2.74 left silently discarded: closing a tab mid-turn. The tab was the only surface that could have said what the cancel answered, and it was removed before anyone could read it.

### Fixed

- **Closing a running tab swallowed the stop result, and with it the only surface that could report it.** `closeTab` awaited `cancel()`, logged a rejection to the console and dropped every outcome, then disposed the tab's panel. On the installed `opencode v2.0.28` this is not a confirmed stop: 0.2.74 measured all nine cancel spellings answering `-32601 "Method not found"` while the submitted prompt stayed in the transcript, and 0.2.76 measured the cancel round trip at 545 ms before it reported `unsupported`. So a tab closed mid-turn kept running inside the agent while the client — which had just asked and been told it could not stop it — said nothing anywhere. `closeTab` now keeps the tri-state, and when it is `unsupported` or `unknown` says so as a system message in whichever conversation inherited the slot: the next tab, or the off-strip placeholder when the last tab was closed. `stopped` stays quiet, because the close already did what it claimed. A cancel that throws is recorded as `unknown` rather than swallowed — nothing came back, and nothing read is not evidence of a stop. A tab closed while idle makes no claim at all, since no cancel was asked and a cancel would answer for a turn that does not exist. `deleteSession` closes through the same path and inherits the report.

### Validation

- 86 test files / 2,543 tests (2,537 baseline plus six new). The 19 pre-existing, platform-bound failures in `NativeSessionReader.test.ts` and `commandResolution.test.ts` are unchanged; TypeScript and ESLint are clean. Six boundaries, each confirmed to discriminate: `unsupported` on a closed background tab is said in the surviving tab and not in the disposed one; a throwing cancel is said as `unknown` (the old code logged and said nothing); `stopped` produces neither line; an idle close never calls cancel and never speaks; closing the last busy tab lands the line in the replacement placeholder; and `deleteSession` mid-turn carries the same line into the surviving tab. Reverting to a discarded await fails the first and second; folding a throw into `stopped` fails the second; reporting on every close fails the third; reporting without a cancel attempt fails the fourth; painting into the closed tab's renderer fails the first and fifth.
- The kernel fact this release routes is the one already measured on 2.0.28: cancel is unimplemented and a live turn survives it. This release changes where that fact is said, not what the agent does with the cancel, so no new live rig was needed; the discriminating boundaries are UI-level and are covered above. The `stopped` branch is exercised against the mock contract from 0.2.76, not against an agent that implements cancel.

### Still open

View close (`cancelAllStreams`) and the side-chat close (`abortSideChat`, also reached by closing a tab that owns a side session) still discard the outcome. Their surfaces are removed by the same act — a view-close report has no surviving tab, and a tab close would dispose the panel a side-chat note was written into — so each needs a destination chosen before it can speak. That is the remaining piece of the 0.2.74 gap: the Stop button, `/compact` and tab close now report; these two paths still stop watching without establishing that the kernel stopped.

## 0.2.77 - 2026-10-20

Takes the first of the cancel paths 0.2.74 left silently discarded — and the only one where the client itself would send the next prompt. `/compact` interrupted the running turn, threw away whether it stopped, and sent the compact prompt anyway.

### Fixed

- **`/compact` could be sent into a session whose previous turn was never confirmed stopped.** `cancelActiveGeneration` awaited `cancel()` and discarded its tri-state; `compactSession` then sent `/compact` unconditionally. Measured against the installed `opencode v2.0.28`: hold a turn, cancel it (`unsupported`), then send `/compact` on the same session — the kernel rejects it **in 2 ms** with `-32603 "Internal error: Session already has an active ACP prompt: ses_…"`. The same prompt on a fresh, idle session was accepted and returned `end_turn`. So the old path was a guaranteed internal error on this kernel, and would have stacked two instructions on any agent that accepts concurrent prompts. `cancelActiveGeneration` now returns `idle` / `stopped` / `unsupported` / `unknown` (a cancel that throws is `unknown`, never a stop), and `compactSession` sends `/compact` only on `idle` or `stopped`. The other two are refused with a line that names the reason: no cancel method, or no confirmation of a stop.

### Validation

- 86 test files / 2,537 tests (2,531 baseline plus six new). On this Windows host 2,518 pass; the other 19 are the same pre-existing, platform-bound failures in `NativeSessionReader.test.ts` and `commandResolution.test.ts`, both untouched. TypeScript and ESLint are clean. Six boundaries, each confirmed to discriminate: a confirmed stop still sends `/compact`; `unsupported` refuses and names the missing method; `unknown` refuses and names the absent confirmation; a throwing cancel is reported as `unknown` by `cancelActiveGeneration` and refuses the send; an idle tab sends without cancelling anything; and the compact text reaches `sendMessage` exactly once when allowed. Reverting `compactSession` to always send fails the middle three; dropping the `unknown` assignment in the catch fails the direct `cancelActiveGeneration` assertion; treating `idle` as blocked fails the idle case.
- Live rig with the actual bundled `AcpClient`, a stub provider holding its response: after `cancel` returned `unsupported` in 2 ms, `/compact` was rejected in 2 ms with the `-32603` above, with no new provider request. A control `/compact` on a fresh session returned `{ stopReason: "end_turn" }`; that session was empty, so this establishes acceptance rather than a successful summary. The first turn's local promise rejected with `AcpAbortError` after the cancel, exactly the race 0.2.76 made the watchdog own for its own path.

### Still open

`closeTab`, `cancelAllStreams` (view close) and `abortSideChat` still discard the cancel result. Unlike `/compact`, they have no surviving surface to report into: the tab/panel is being removed, and a message written there would vanish with it. Closing a tab mid-turn therefore still stops watching without establishing that the kernel stopped — the 0.2.74 gap narrowed, not closed. On an agent with no cancel method, `/compact` during a live turn is now refused rather than attempted; the turn has to finish (or the session be replaced) before compaction is possible. Measured against OpenCode 2.0.28 only.

## 0.2.76 - 2026-10-20

Takes the idle watchdog path 0.2.75 left open. The watchdog fired a cancel and threw the answer away, so a turn the agent had confirmed stopped, a turn on an agent with no cancel method, and a cancel nobody answered all produced the same "it may still be working" line. This round keeps the answer, and keeps the local stream abort from erasing it.

### Fixed

- **The idle watchdog reported a timeout without the one fact it had measured.** It fired `void this.acp.cancel(id)` and rejected immediately with `AcpTimeoutError('session/prompt', timeoutMs)`, discarding the tri-state cancel result the 0.2.74 client already returned. `AcpTimeoutError` now carries an optional `cancelOutcome`; the watchdog awaits the cancel (bounded by the existing 2 s `ACP_CANCEL_TIMEOUT_MS`) and reports `stopped`, `unsupported` or `unknown`. The reader-facing line changes with it: a confirmed stop no longer says the turn may still be working, and a missing cancel method is named as the reason rather than hidden behind a generic hedge. A cancel that throws is an unconfirmed stop, not a reason to leave the turn pending forever.

- **The local stream abort could settle the turn before the cancel answered.** `AcpClient.cancel()` aborts the local stream first and only then asks the agent, so the wrapper's `sendMessage` rejects with `AcpAbortError` while the cancel request is still on the wire. Awaiting the cancel naïvely would have let that abort win the outer promise — reporting "aborted" and losing the measured outcome, or worse, rejecting with the abort after the turn had already been classified. The watchdog now owns settlement from the moment it fires: a late resolve or reject from the wrapper is ignored, and only the cancel outcome settles the timeout. `activeStreamCount()` is 0 afterwards, so the next send is not blocked by "A stream is already active".

### Validation

- 86 test files / 2,531 tests (2,525 baseline plus six new). On this Windows host 2,512 pass; the other 19 are the same pre-existing, platform-bound failures in `NativeSessionReader.test.ts` (POSIX fixtures rewritten by win32 `path.join`) and `commandResolution.test.ts` (host PATH delimiter), both untouched by this release. TypeScript and ESLint are clean. Six boundaries, each confirmed to discriminate: the default timeout carries `stopped`; an unsupported cancel is preserved on the error; a stream abort that lands before the cancel answers does not win (`AcpTimeoutError`, not `AcpAbortError`); a throwing cancel reports `unknown` instead of hanging; `humanizeError` renders a confirmed stop without the word "still"; and the unsupported and unknown lines differ in what they say caused the doubt. Reverting the watchdog to `void cancel` drops the outcome from every one of the first four; letting the wrapper settle first fails the abort-race test; returning early on a rejected cancel fails the throwing test.
- Live rig against the installed `opencode v2.0.28`, with the actual bundled `AgentRuntime` + `AcpClient`, a stub provider that holds its response, and `idleTimeoutMs = 4000`: the watchdog settled at 4545 ms with `AcpTimeoutError.cancelOutcome = "unsupported"`, the rendered line named the missing cancel method, and `activeStreamCount()` was 0. A second `session/prompt` sent while the first was still held rejected in under 1.5 s with `-32603`, which is the live shape of the warning: the first turn is still running inside the agent. The 545 ms beyond the window is the cancel attempt's own round trip; without awaiting it, that fact is simply unknown.

### Still open

The watchdog's report is now honest, but on this kernel the underlying state is not fixed: `unsupported` means a timed-out turn can still be running, and the 0.2.75 transcript guard is what refuses the retry. Tab close, view close and the side-chat path still discard the cancel result (0.2.74). Awaiting the cancel delays the timeout line by up to 2 s beyond the idle window; a late answer arriving in that gap is discarded, as it already was, though the window is wider. Measured against OpenCode 2.0.28 only.

## 0.2.75 - 2026-10-20

Takes both retry paths 0.2.73 left open — timeout and rejection — and finds that the guard it shipped had never run. The runtime object the controller actually holds did not expose the probe, so every 0.2.73 restart retry resolved `unknown` and refused. That failed closed, which is why no duplicate was observed; it was not, however, checking anything.

### Fixed

- **A timed-out or rejected turn could be re-sent while the kernel still held it.** Measured against the installed `opencode acp` (2.0.28): with the provider holding its response, `session/load` on the same connection answered in 15 ms and replayed the submitted prompt (unique marker present) while the original `session/prompt` was still pending, and `session/cancel` still answered `-32601` — so the old "retry" stacked a second instruction on a live turn that cannot be stopped. With the provider returning 500, the prompt rejected after 12 upstream retries and 84.9 s (`-32603`), and an 18 ms load replayed the prompt and 24 frames. Every post-send failure that offers a retry now asks the transcript first and re-sends only on `'no'`; `'yes'` and `'unknown'` are refused with the reason. Failures before the prompt reaches the wire keep the plain retry: the containment probe could match an identical earlier turn, and a refusal there would be false.

- **0.2.73's guard was dead on arrival.** `submittedAlready` called `client.hasSubmittedPrompt` behind an optional check, but the controller's client is `AgentRuntime`, which never forwarded the method. Every probe resolved `unknown`, so the process-exit chip refused every retry — including safe ones — for a reason it had not measured. `AgentRuntime.hasSubmittedPrompt` now delegates to `AcpClient`, the object that actually reads the replay.

### Validation

- 86 test files / 2,525 tests (2,519 baseline plus six new). On this Windows host 2,506 pass; the other 19 are pre-existing, platform-bound failures in `NativeSessionReader.test.ts` (POSIX fixtures rewritten by win32 `path.join`) and `commandResolution.test.ts` (host PATH delimiter), both untouched by this release and left for the Linux CI runner. Six boundaries, each confirmed to discriminate: `'yes'` on the timeout chip re-sends nothing; `'unknown'` refuses to call an unreadable transcript safe; `'no'` re-sends; the restart chip reconnects before probing and refuses a held prompt; a pre-send failure retries without probing even when the probe would answer `'yes'`; and the runtime forwards the probe to the acp client. Restoring the blind retry fails the first; reading `'unknown'` as safe fails the second; removing the send-boundary split fails the fifth; dropping the forwarder brings the `unknown` constant back. Reference baseline: Claudian not re-fetched this round; prior record `8a7de7c6` (2.3.24).

### Still open

The idle watchdog still fires `void this.acp.cancel(id)` and discards the outcome — on this kernel that cancel answers `-32601`, so a "timed out" turn is reported while it may still be alive. Tab close, view close and the side-chat path still discard the cancel result (0.2.74). The containment match can refuse a legitimate retry, and `unknown` costs one extra click. Measured against OpenCode 2.0.28 only; the nine cancel spellings were measured on 2.0.32 and not re-probed here.

## 0.2.74 - 2026-10-18

Takes the last of the gap analysis' stage-3 acceptance criteria — 中断不留后台工作 — and finds it does not hold on this kernel. The kernel has no cancellation at all, and the plugin had been reporting a stop it never observed.

### Fixed

- **Stop reported a stop nothing confirmed.** `AcpClient.cancel()` dropped the local stream, fired the cancel into the void as a JSON-RPC *notification*, and returned `Promise.resolve()` unconditionally — so the turn looked stopped in the UI while the kernel carried on. The reason the old shape could never learn otherwise is structural: a notification carries no answer back. Measured against `opencode acp` (2.0.32), the agent implements **no cancellation method whatsoever** — `session/cancel`, `cancel`, `session/abort`, `abort`, `session/interrupt`, `interrupt`, `session/stop`, `stop` and `session/cancel_notification` each answer `-32601 "Method not found"`, while `session/set_mode` on the same connection at the same moment answers normally, which is what separates "the agent said no such method" from "the pipe was dead". A submitted prompt is still in the transcript after Stop, and the turn is still running. So the fourth acceptance criterion is measured as **not holding**: pressing Stop does not leave the kernel idle. The cancel now goes out as a *request* with a 2s deadline — Stop still returns promptly, and the result is finally observable — and `cancel` returns what was seen: `stopped` only when the agent acknowledged, `unsupported` when every candidate answered "no such method", `unknown` otherwise. Stop is silent only on `stopped`; the other two say plainly that the turn may still be running inside the agent. Stopping *watching* and stopping *the kernel* are now two claims, and only one of them is free.

### This also explains last release's open risk

0.2.73 flagged that the timeout path still offered an unverified re-send. It now has an explanation: a "timed out" turn is not a dead one. It is alive in the kernel and, per this release's measurement, **cannot be stopped**. A re-send there does not risk duplicating work by chance — it stacks a second instruction on a live turn. Guarding that path is now a matter of time; actually fixing it depends on the agent gaining a cancel.

### Validation

- 86 test files / 2,519 tests passed, with TypeScript and ESLint (baseline 2,517/86). Three boundaries, all confirmed to discriminate: an acknowledged cancel reports `stopped` and carries `ACP_CANCEL_TIMEOUT_MS` so Stop cannot hang; `-32601` reports `unsupported` after both aliases were tried; and any other failure reports `unknown` — **never `stopped`** — which is the half that stops the plugin crying wolf. Reverting to the old notify-and-always-resolve shape fails the first two. Three older tests asserted the previous behaviour, including `resolves.toBeUndefined()` and that the cancel travelled as a notification; they encoded the lie, and are rewritten against the new contract. Reference baseline: Claudian unchanged at `8a7de7c6` (2.3.24).

### Still open

Only the Stop button reports the outcome honestly. Tab close, view close and the side-chat path still discard it silently — that is this round's remaining gap. The 0.2.73 retry guard on the timeout path is also still not added. Measured against OpenCode 2.0.32 only; an agent that *does* implement cancel now works as before and reports `stopped`, which the old notification shape could never have known either way.

## 0.2.73 - 2026-10-18

Takes the third of the gap analysis' stage-3 acceptance criteria — 已提交请求不因 fallback 重复执行 — and closes a path where the agent could run the same instruction twice. This is the first criterion in the set whose failure is destructive rather than merely misleading.

### Fixed

- **A failed turn's retry could run the instruction a second time.** The error chip offered "Restart and retry" on a process exit, and "retry" otherwise; both re-sent the same text with no question of whether the agent had already run it. Measured: submit a prompt, SIGKILL the agent mid-turn, start a fresh one and `session/load` the same id — **the prompt is in the transcript**. The agent records an accepted submission durably whether or not the turn ever answers. Meanwhile the kill landed before any `user_message_chunk` reached the client, so the turn being watched saw exactly as little as the reader did. "No answer came back" was never evidence that "nothing ran", and re-sending on it meant a second pass at the same edits, commands and commits. The restart path — the one that already reconnects, and so already holds the reloaded transcript — now asks first, via a new `AcpClient.hasSubmittedPrompt` that scans replayed `user_message_chunk` frames through the existing `loadSession` replay seam. If the session already holds the prompt, nothing is re-sent and the reader is told why. Two deliberate choices: matching is by **containment**, because what goes on the wire is the reader's text plus any expanded context refs, and that can over-report — the direction it fails in is a refused retry, not a repeated edit; and a transcript that cannot be read returns **`unknown`, never `no`**, because nothing read is not evidence of absence, and reading it as `no` would rebuild the very double execution this removes.

### Validation

- 86 test files / 2,517 tests passed, with TypeScript and ESLint (baseline 2,515/86). Both boundaries confirmed to discriminate: without per-`messageId` chunk accumulation the already-submitted probe reports `no` for a prompt that arrived split across two frames — a long turn arrives in pieces, and looking only at the last one misses it; and returning `no` for an unreadable transcript fails the second. Reference baseline: Claudian unchanged at `8a7de7c6` (2.3.24).

### What is still open, stated plainly

The guard covers only the `AcpProcessExitError` path, because that is the one that reconnects and therefore the only one holding a reloaded transcript. The timeout and rejection paths still offer an unverified re-send chip — on those the connection is alive and there is no cheap "was it accepted" signal. That is the largest gap left by this round and the next one should close it.

The `'unknown'` branch refuses to resend, which is the safe side of the trade and costs the reader one extra click.

## 0.2.72 - 2026-10-18

Fixes a reported bug: changing the model from the toolbar failed with `"Method not found": setSessionModel`, and reverted. Measured against the running kernel — the method the plugin was calling does not exist.

### Fixed

- **Model changes called a method no ACP agent implements.** `setModel` tried `session/set_model`, then `setSessionModel`; the fallback surfaced the last error, so the reported name was the second one — meaning both had already been tried and both were absent. Probed directly against `opencode acp` (2.0.32): `session/set_model` → `-32601 "Method not found"`, `setSessionModel` → `-32601 "Method not found"`, while `session/set_mode` → `{}` and `session/set_config_option` → success. The model is not a verb in ACP at all: the agent advertises it the same way it advertises effort and mode, as a config option — `session/new` returns `{id:"model", category:"model", type:"select", currentValue, options}`, and `config_option_update` pushes the same shape. The agent's own error named the field (`configId`, not the `optionId` the plugin was sending). `setConfigOption` with `{configId:"model", value}` succeeds and comes back with `currentValue` already set to the new model. `AcpClient.setModel` now writes that option, and the `setModel` entry is gone from the alias table rather than left advertising two names that were measured absent. Model switching against OpenCode had never worked; this is the first version where it does.

- **A reply that omitted `configOptions` blanked the model.** `setConfigOption` applied its parse result unconditionally, and `parseConfigOptions(undefined)` returns `[]` — so "said nothing" was read as "this session has no options now" and wiped the current model id (observed: `null`). The agent never said that. It now applies only when the wire actually carried an array. This matters more now that the model travels this way: an agent that applied the change but did not echo the list back would have emptied the selector.

### Validation

- 86 test files / 2,515 tests passed, with TypeScript and ESLint (baseline 2,514/86). Both new boundaries confirmed to discriminate: restoring the old `setModel` fails the routing assertion, and removing the `Array.isArray` guard fails with `null` instead of the last id the agent reported. The landed case is pinned too — when the agent echoes a `currentValue`, the snapshot adopts the agent's id, not the one requested, which keeps the 0.2.44 A "accepted ≠ landed" rule and enforces it more strictly than a bare RPC result would. A controller comment that reasoned about this call is corrected: the concern it described could not have occurred, because the method did not exist.

### Still open

Measured only against OpenCode 2.0.32's ACP surface. If another agent does implement a dedicated `session/set_model`, this version no longer tries it — but keeping two measured-absent names is worse than dropping them. Any such agent should be re-added on evidence, not on guesswork.

## 0.2.71 - 2026-10-18

No new capabilities; the chat backend is unchanged. This release pays the measurement debt 0.2.70 declared: the mid-run disconnect is now reproduced against a real kernel, and the rig that does it turned up a sentence in 0.2.70 that claimed more than the reading could support.

### Added

- **The live disconnect rig works, and it confirms the 0.2.70 fix on the real kernel.** The previous attempt proved nothing for a specific reason worth recording: the probe spawns its *own* `opencode serve`, so the old rig killed a separately-started server that the probe was never talking to. Wrapping the probe's existing `deps.spawn` seam to capture that child — then SIGKILLing it — reproduces the situation properly. Stub provider holding its response for 25 seconds, server killed at 5 seconds: the fixed probe reports `disconnected` with `enqueued`, `delivered` and `started` all true. Reverting the guard and running the identical rig reports `unavailable` with all three false. So the lie was real — a run that had been enqueued, delivered and started was reported as a setup that never completed, with its own proven facts erased — and it is now a measurement rather than an assertion.

- **The `leftover` flag survives a disconnect honestly.** Worth checking rather than assuming, since a dead server makes "could not delete the session" look like a generalisation. It is not: `OPENCODE_DB` is SQLite, and after the server was killed `session_v2` still held the row (and `session_message` still held the turn). A later `opencode serve` over that database finds the abandoned session, so `leftover=true` names something that is genuinely still there.

### Fixed

- **A disconnect no longer claims execution began when it did not.** A disconnect can land after the prompt is admitted but before any `session.execution.started` frame arrives — reachable on the measured path, and the rig exercises it. `started` is then false while the status is still `disconnected`. The title 0.2.70 wrote for that row said the kernel "took the prompt **and began executing**, then stopped answering", and the three legs it prints directly beneath that title then read `execution started: no`. The row contradicted itself, in its own headline, about the one fact it had not observed. The title now says only what `disconnected` itself means — the prompt was taken, then the server stopped answering — and whether execution started is left to the leg that reports it truthfully. No new status: the kernel does not distinguish these cases and the reader's next move is the same either way, so a new bucket would have invented a distinction that is not there.

### Validation

- 86 test files / 2,514 tests passed, with TypeScript and ESLint (baseline 2,512/86). Two boundaries, both confirmed to discriminate: at the probe level a disconnect landing before `execution.started` reports `disconnected` with `started` still false; at the Settings level that reading renders without `began executing` and with `execution started: no` — restoring the old sentence makes the second fail. One latent test-harness gap closed alongside: `fakeSlice`'s status union in `settings.test.ts` was missing `disconnected`, so the test environment could not even construct this row's reading. Reference baseline: Claudian at `8a7de7c6` (still 2.3.24), with `src/providers/opencode` untouched in source and `AGENTS.md` — no new constraints to carry.

### Still open

Two acceptance criteria remain unmeasured: an interrupt must leave no background work, and a submitted request must not execute twice through a fallback. The chat backend is still ACP.

## 0.2.70 - 2026-10-18

No new capabilities; the chat backend is unchanged. This release takes the second of the gap analysis' stage-3 acceptance criteria — 失联不伪装正常完成 — and closes a defect that made a lost connection indistinguishable from a kernel that never ran.

### Fixed

- **A run that lost the connection mid-flight no longer reports as one that never began.** The slice probe's transcript poll called `requestFn` unguarded, so when the server stopped answering the exception escaped `run()` and the caller substituted `DEFAULT_SLICE` — `unavailable`, with `enqueued`, `delivered` and `started` all false. A run that had been enqueued, delivered and started was therefore reported as a setup that never completed, **and the three facts it had already proven were erased with it**. The panel sentence said the kernel "did not complete setup", which is false and points at the wrong thing: setup completed, execution began, and the link dropped. That is the same class 0.2.63 retired on the catalog, where a stated 401 was folded into "did not answer" — a nameable observation crushed into a bucket the reader cannot act on differently. `sliceStatus` gains `disconnected`, ordered after `failed` (a failure the kernel itself named is still `failed`) and before `admitted`. The poll now catches a connection-level failure locally; an **HTTP status does not count as a disconnect**, because the server is still there and answered. Whatever legs were already observed stay on the reading, because a dropped link does not un-earn them, and Settings shows them alongside the new sentence.

### Validation

- 86 test files / 2,512 tests passed, with TypeScript and ESLint (baseline 2,510/86). Two boundaries, pinned in both directions: a mid-run disconnect reports `disconnected` with all three legs still true, and a kernel that never came up still reports `unavailable` with `started` false — so the fix cannot turn every failure into "the link dropped". Reverting the guard makes the first fail with `unavailable`. Reference baseline: Claudian unchanged at `1e432bef` (2.3.24).

### What was *not* measured, stated plainly

The live measurement for this criterion was attempted — a stub provider holding its response for 20 seconds with the server killed at 3 seconds — and the harness did not produce a clean result. So **the mid-run disconnect has not been reproduced against a real kernel**; what this release establishes is the defect and its fix on the code path, which is deterministic and does not need a live server. The research doc says the same rather than implying a measurement that did not happen. The next round should close it with a working rig.

Two acceptance criteria remain unmeasured: an interrupt must leave no background work, and a submitted request must not execute twice through a fallback. The chat backend is still ACP.

## 0.2.69 - 2026-10-18

No new capabilities; the chat backend is unchanged. This release discharges the first of the gap analysis' four stage-3 acceptance criteria — "多个标签不串流" — by measuring it, and fixes a defect the measurement exposed.

### Added

- **The native event stream is multiplexed, and multi-tab isolation is therefore a client responsibility.** One `opencode serve`, two sessions, both prompted on the **same** directory-scoped `GET /api/event` connection: both prompts' markers appeared on that one stream, their frames arrived interleaved, and each session's filtered assembly contained none of the other's words. The endpoint multiplexes by directory and does not separate channels per session — so "多个标签不串流" holds only because the client filters on `sessionID`. Both reducers already did (`OpencodeStreamProbe.reduceNativeStream`, `OpencodeV2SliceProbe.reduceV2SliceEvents`), so the criterion was already satisfied; what was missing was any test pinning it. Two boundaries now hold it, one per reducer, built from the frame layout the running kernel actually produced — delete either filter and both fail.

### Fixed

- **A neighbouring session could truncate this one's answer.** The slice probe's event watcher bounded itself with `collected.join('').length > SLICE_READ_MAX_CHARS` — a budget counted **per connection**. Since the stream is shared, a busy conversation elsewhere in the same vault could exhaust the budget first, `break` the watcher before this session's own answer was read, and leave a reading that silently lost its evidence while the panel showed no answer at all. The budget is now spent per session: `ownFrameChars` charges only frames whose `sessionID` matches, so another session's traffic and the directory-scoped hydration noise (which carries no `sessionID` at all) cost nothing. The per-frame cost is an estimate on purpose — the budget exists to stop an endless stream, and being slightly off changes when the watcher gives up, not what it concluded. Confirmed against the old shape: reverting the call site makes the boundary fail with `streamed: false`, i.e. the answer really was squeezed out.

### Validation

- 86 test files / 2,510 tests passed, with TypeScript and ESLint (baseline 2,505/86). New boundaries: `ownFrameChars` unit coverage for own/foreign/sessionless frames, the multiplexed interleaving case for both reducers, and the flooding case that reproduces the truncation. Reference baseline: Claudian unchanged at `1e432bef` (2.3.24), read through a mirror because github.com HTTPS remains unreliable here.

### Note on a mistake worth recording

The flooding boundary was wrong twice before it was right: 1,200 frames is only ~144k characters and never reached the 400k cap, so the test passed against the *broken* implementation too. It only began discriminating at 5,000 frames. The rule this restates is the one the release process keeps restating — a boundary that passes against the behaviour it exists to reject is not a boundary. The same round also reproduced a footgun fixed one release earlier: asserting `toEqual({ __proto__: 'kept' })` sets a prototype rather than naming a key, so that assertion now uses `Object.hasOwn`.

### Still open

Three of the four stage-3 acceptance criteria remain unmeasured: disconnection must not be disguised as normal completion, an interrupt must leave no background work, and a submitted request must not execute twice through a fallback. The chat backend is still ACP.

## 0.2.68 - 2026-10-18

No new capabilities. This release transfers a defect fix found by reading the reference repository's newest code, and corrects one of its own claims after measuring.

### Fixed

- **An un-answered elicitation field can no longer be satisfied from the prototype chain.** Claudian moved 18 commits to `1e432bef` (2.3.24) and its OpenCode provider changed for the first time in three rounds — in its form-answer path, swapping a plain read for `Object.hasOwn` and a plain assignment for `Object.defineProperty`. The same shape was live in `AcpRequestHandler.ts`, under a comment promising otherwise: "Echo only keys the agent actually asked for, so a caller that hands back more than the schema requested cannot inject answers." That promise did not hold. `answer.content[field.key]` walks the prototype chain, so an agent naming a field `toString` — which the reader never answered — matched the **inherited function**, passed the `value !== undefined` guard, and was sent to the agent as something the reader had typed. That key survives the schema parse, so the path is genuinely reachable. Both halves now go through `src/utils/ownKeys.ts`: `readOwnKey` decides reads with `Object.hasOwn`, `writeOwnKey` assigns with `Object.defineProperty` as an own, enumerable property so the key survives `__proto__` and still serialises. The banner's own `content[field.key] = value` had the same write shape and now shares the helper. Confirmed against the pre-fix code: reverting the two lines makes the boundary fail with `['target', 'toString']` — a prototype function returned to the agent as the reader's answer.

### Corrected, not claimed

- **This is a key-handling bug, not a prototype-pollution vulnerability — and measuring said so before the fix was written.** The obvious guess is pollution. Testing the path first showed `z.record()` **drops the `__proto__` key while parsing**, so it never becomes an own key, and the parser does not touch `Object.prototype` either. So the reachable half is the read inheritance (fixed); the write half is unreachable through this path and is kept as cheap defence in depth; and no pollution was possible at all. Writing this up as a security hole would have overstated it by an order of magnitude, so the release note, the code comment and the research doc all say what was measured.

### Validation

- 86 test files / 2,505 tests passed, with TypeScript and ESLint (baseline 2,494/85). Nine boundaries in a new `ownKeys.test.ts`, and two in `acp.test.ts` placed beside the existing "echoes only the keys the schema asked for" test they qualify. One of those asserted own-key absence rather than value, because every object inherits a `toString` and the value itself proves nothing either way; another asserts that a schema key the parser drops yields **no answer at all** rather than a phantom one, with the field the reader really did answer still passing through. Reference baseline: Claudian `1e432bef` (2.3.24), reached through a read-only mirror because github.com was repeatedly unreachable.

### Note on method

github.com failed this round with repeated TLS resets, and a naive `git fetch` failure would have been indistinguishable from "the reference has not moved". Fetching through a mirror immediately returned a HEAD this machine had never seen. Absence of evidence was not evidence of absence, and the release is built on a 18-commit delta rather than on a failed fetch.

### Still open

A schema key dropped by `z.record()` is invisible to the reader: `__proto__` ends up in neither `fields` nor `omitted`, so nobody is told an item was skipped. Fixing that means preserving own keys at the schema layer, which is separate work — this round only guarantees no answer is invented for such a key.

## 0.2.67 - 2026-10-17

No new capabilities; the chat backend is unchanged. This release completes the terminal vocabulary 0.2.66 recorded as still unmeasured, and fixes a session leak two rounds of cleanup had missed.

### Added

- **The last unmeasured terminal name is now measured.** 0.2.66 stated plainly that `session.execution.failed` had never been observed, because a failing provider retries and no terminal arrived inside the probe window. Reading the kernel's own source first (`packages/core/src/session/runner/retry.ts`) showed the budget is **hardcoded** — exponential from 2s capped at 10s per gap, 10 retries, about 84s of waiting (67–101s with jitter) — so it cannot be configured shorter, only waited out. A single 170-second measurement run therefore closes it: after 10 retries the kernel emits `session.step.failed` and then **`session.execution.failed {sessionID, error}`**, and the transcript's `idle` row carries `outcome: "failed"` with the error inline. The terminal vocabulary is now complete — `session.execution.succeeded {sessionID}`, `session.execution.failed {error}`, `session.execution.interrupted {reason}` — and, usefully, the three carry **different** payloads. The reducer now reads whichever of `reason` / `error` is present instead of assuming one shape, which is what lets a terminal failure be named at all.
- **Verified against the real kernel that a failure is reported without waiting out the retry budget.** With a stub provider that always refuses, the probe reports `{"status":"failed", …, "errorType":"provider.internal","errorMessage":"always refused","retries":3,"leftover":false}` inside a **6-second** window. That is the design 0.2.66 argued for and had not yet seen confirmed end to end.

### Fixed

- **The turn and stream probes were leaking a session on every single run — and two rounds of cleanup missed it.** 0.2.64 and 0.2.65 each recorded "the fork probe's teardown hits a 405 route" as the outstanding item, and 0.2.66 fixed exactly that one. Checking the other probes showed they were worse: they **interrupted and stopped**, never deleting at all, so each run left its throwaway session in OpenCode's history with nothing on the panel to say so. All three now delete on whichever route the generation has and carry a `leftover` flag, with Settings text for each. Rather than paste the same route-fallback logic a third time, it lives in `OpencodeServeSession.deleteOpencodeServeSession`: the 2.x route first, the 1.x route as fallback, **404/405 treated as "this route does not exist"** and the search continues, while a 5xx or a dead socket is **not** walked past as a missing route — "the server refused to delete this" and "this server has no such route" send the reader to different places.

### Validation

- 85 test files / 2,494 tests passed, with TypeScript and ESLint (baseline 2,485/84). Five new boundaries in a new `OpencodeServeSession.test.ts` for route preference, 405 fallback, 500 refusal, dead-socket handling and directory encoding; two per probe for the delete and the leftover; one reducer boundary for the inline error on a failed terminal. Eight existing assertions (turn, stream, fork) were widened by `leftover: false` rather than loosened — they still pin the whole object. Reference baseline: Claudian unchanged at `31dd256b` (2.3.22). **No real credential was used and no billed model turn was spent**; the 170-second terminal measurement ran against a loopback stub.

### Still a constraint, and now on the record

The retry budget is **hardcoded** in the kernel (`retry.ts`: 10 retries, ~84–101s) with no configuration knob, so a *failing* run cannot complete inside a settings probe's window. That is precisely why `failed` is claimed the moment the kernel names the failure rather than on a terminal event — and if this ever becomes a product execution path rather than a measurement, that latency is a real constraint to design around. The chat backend is still ACP.

## 0.2.66 - 2026-10-17

No new capabilities; the chat backend is unchanged. This release drives the two paths 0.2.65 left undriven — a failing provider and an interrupt — and fixes the throwaway-session leak that made the fork probe's cleanup a silent no-op on this kernel generation.

### Added

- **A named failure is now the earliest honest signal, not a terminal event.** Measured against a stub provider returning 500: the kernel does not fail, it **retries** — `session.retry.scheduled` fired eight times with an interval that grows on every attempt (+2.2s, +9s, +10s, +10s, +8s, +10s, +11s as observed), and **no terminal event arrived inside the probe window**. Waiting for one would report a machine that is visibly failing as merely "in flight". Each retry carries a named error anyway — `{type: "provider.internal", message: "fake upstream refused", status: 500}` — so `failed` is claimed the moment the kernel names the failure, and the reading reports `errorType` / `errorMessage` / `retries`. The **first** named failure is the one kept: a reader shown the eighth retry's error has lost the one that started the trouble.
- **An interrupt is measured, and kept apart from a failure.** Driving a stub that holds its response for 25s and interrupting at 3s yields `session.step.failed {error: {type: "aborted"}}`, **`session.execution.interrupted {reason: "user"}`**, an `idle` row with `outcome: "interrupted"`, and an assistant row with `finish: "error"`. The probe reports `interrupted` as its own status carrying `reason`. It is deliberately not merged into `failed`: the kernel names the two apart and the remedies differ — an interrupt is something the reader did, a failure is something to go fix. That is the same separation 0.2.46's `terminalUnknown`/`terminalGone` and 0.2.47's exhausted/retrying established. `sliceStatus` is a pure function so the whole five-bucket ordering is testable: an answer outranks a terminal, a terminal outranks a mid-flight observation, and a run that finished without saying anything is neither an answer nor a failure.

### Fixed

- **The fork probe stops leaving throwaway sessions behind in silence.** Its teardown deleted through `DELETE /session/{id}?directory=`, which **2.0.32 answers 405** — the error was swallowed by an empty `catch`, so both the forked child and its source session stayed in the kernel's history while the panel implied the measurement had cleaned up after itself. Teardown now tries the route this generation has (`DELETE /api/session/{id}?directory=…`, 204) first and keeps the 1.x form as a fallback, so a 1.x install still gets cleaned up; the observation carries `leftover`, and Settings says so when a throwaway survived. This is the item 0.2.64 and 0.2.65 both recorded as outstanding.

### Validation

- 84 test files / 2,485 tests passed, with TypeScript and ESLint (baseline 2,474/84). Verified against a real running kernel with a deliberately slow stub: an in-flight run reports `{"status":"admitted","enqueued":true,"delivered":true,"started":true,"streamed":false,"confirmed":false,"retries":0,"leftover":false}` — a run that has not finished is not dressed up with any terminal. Reference baseline: Claudian unchanged at `31dd256b` (2.3.22). **No real credential was used and no billed model turn was spent.** Three existing fork assertions were widened by `leftover: false` rather than loosened — the observation now carries one more fact, and the assertions still pin the whole object.

### Still unknown, and deliberately not invented

`session.execution.failed` as an **event name** remains unmeasured: on the 500 path the kernel kept retrying and never reached it. The failure information was read from the `error` carried by `retry.scheduled` and by the assistant row, not from an event name, and the reducer still records any unseen `session.execution.*` name verbatim rather than mapping it onto a meaning this build has never watched. The chat backend is still ACP.

## 0.2.65 - 2026-10-17

No new capabilities; the chat backend is unchanged. This release closes the two measurements 0.2.64 recorded as unobserved — a real assistant answer, and the terminal state of a run — using a local OpenAI-compatible provider instead of credentials.

### Added

- **A real turn, a real answer, and a named terminal — measured without credentials.** 0.2.64 could only report `admitted` and could say nothing about *why*, because `OPENCODE_SIMULATE` is a network gate rather than a fake model: it parks the run in a named `provider.transport` retry. OpenCode also accepts an OpenAI-compatible provider declared in its config with its own `baseURL`, so a loopback chat-completions endpoint gives the kernel a model to actually answer with. Against that, the full lifecycle was observed end to end for the first time: `session.inbox.enqueued` → `session.execution.started` → `session.inbox.delivered` → `session.step.started` → `session.text.started` → `session.text.delta` → `session.text.ended` → `session.step.streamed` → `session.step.ended` → **`session.execution.succeeded`**. Three facts this closes: the streaming channel on this generation is **`session.text.*`** keyed by `assistantMessageID` and an `ordinal` — not the `session.next.text.*` the 0.2.56 stream probe encodes, which would have matched nothing even if admitted; the terminal event is **`session.execution.succeeded`**; and a successful run appends an **`idle` row carrying an `outcome`** to the transcript. That last one is the more robust terminal source, because it reads a *field*: an outcome this build has never seen still reaches the reader verbatim instead of being rounded into "succeeded".
- **The slice reading now covers the whole loop, in four non-merging buckets.** `failed` joins `unavailable`, `admitted` and `answered`: it is claimed only when the kernel itself recorded a terminal that is not a success, and it carries that outcome by name (`sliceFailed` renders `{outcome}`, falling back to "an unnamed outcome" when there is none). `streamed` and `confirmed` split "rebuilt from live delta frames" from "the kernel's own ended frame agreed", the same separation 0.2.56 established for the 1.x stream probe — disagreement between two independent reads of one run is reported, never smoothed. `modelId`, `finish`, `cost` and output tokens are carried from `session.step.started` / `session.step.ended`, with "unreported" wherever the frame did not carry them. Only the **answer channel** (`ordinal === 0`) is assembled: splicing a later ordinal into the answer would fabricate words in a channel the model never put them in.

### Fixed

- **A reading can no longer say "no answer was read back" while displaying an answer.** The status was derived from the transcript read while the `answer` field was derived from the transcript *or* the delta assembly, so a run whose answer had streamed but not yet landed on the transcript produced both at once — one field contradicting the other about the same run. The answer is now resolved once and both the status and the payload use it, pinned by a boundary that reads an answer out of the stream alone.

### Validation

- 84 test files / 2,474 tests passed, with TypeScript and ESLint (baseline 2,466/84). Verified against a real running kernel driven by a loopback OpenAI-compatible provider: `{"status":"answered","enqueued":true,"delivered":true,"started":true,"streamed":true,"confirmed":true,"answer":"OK","modelId":"fakeprov/fake-model","outcome":"succeeded","finish":"stop","cost":0,"outputTokens":0,"leftover":false}`. Reference baseline: Claudian is unchanged at `31dd256b` (2.3.22), confirmed via the GitHub API after local `git fetch` failed repeatedly with TLS resets. **No real provider credential was used and no billed model turn was spent** — the answering model was a loopback stub.

### Still unknown, and deliberately not invented

The specific terminal **event names** for failure and interruption remain unmeasured: only the success path was driven. `provider.transport` and friends were observed as `outcome` *field values* on the transcript's `idle` row, not as event names, and the reducer records any unseen `session.execution.*` name verbatim rather than mapping it onto a meaning this build has never watched. The fork probe's teardown still deletes on the 405 route and may leave throwaway sessions on this generation. The chat backend is still ACP — the probe measures the loop, it does not wire one.

## 0.2.64 - 2026-10-17

No new capabilities, and the chat backend is unchanged: ACP still carries every conversation. This release measures the execution leg on the kernel generation this install actually runs, and stops the three 1.x-era probes from calling a live, healthy kernel one that "did not answer".

### Added

- **A probe that drives the vertical slice on the wire the kernel actually speaks** (stage A): `OpencodeV2SliceProbe` runs one bounded path — create → prompt → execution start → steer delivery → read-back → interrupt → delete — against the contract read off a running 2.0.32 server with an isolated database and `OPENCODE_SIMULATE=1`, never copied from another reference. Every shape was measured: the prompt body is **top-level** `{id, text}` (the 1.x nested `{id, prompt:{text}}` is refused `400 {"_tag":"InvalidRequestError","message":"Missing key at [\"text\"]"}`); the lifecycle lives on the same `GET /api/event` stream under `session.inbox.enqueued` / `session.execution.started` / **`session.inbox.delivered`** / `session.step.started` / `session.retry.scheduled` rather than the `session.next.*` namespace; the user row carries `text` at the top level; the read-back envelope gained `cursor`; and teardown is `DELETE /api/session/{id}?directory=…` (**204**) because the 1.x `DELETE /session/{id}?directory=…` answers **405**. Three buckets stay apart — `unavailable` (setup failed, the kernel said nothing about execution), `admitted` (the kernel took the prompt and began executing, no answer read back), `answered` (a non-empty assistant text part actually observed). The three lifecycle facts are reported individually, because a steer that was only *enqueued* has not been consumed by the run — the reason a caller must wait for `session.inbox.delivered`. **This probe does not claim a successful answer**: producing one needs working provider credentials, so on this install the observed terminal was a named transport failure rather than an assistant text part. `answered` is therefore unobserved in this release and is kept as a distinct bucket precisely so a future credentialed run can fill it without merging into `admitted`. Teardown reports `leftover` rather than silently leaving a throwaway session behind.

### Fixed

- **A refused request shape is no longer reported as silence** (stage B). The three 1.x probes encode a dialect this generation refuses, and every one of them folded that refusal into `unavailable` — so on a 2.0.32 install three rows read "the kernel did not answer" about a kernel that answered `400` with a reason, or `405` on a route it does not have. `isOpencodeServeProtocolRefusal` names that class (400/404/405/422), each probe gains an `unsupported` status, and the panel speaks a distinct sentence for each: the turn row now says the kernel refused *this probe's request shape* and that nothing was observed about whether it can execute; the fork row says the kernel has no fork route this probe speaks, and that this says nothing about whether checkpoint fork is buildable. A transport that died is still `unavailable` — a socket that closed observed no refusal at all, and the anti-remerge guard pins refused / unreachable / not-run as three different sentences in en and zh.
- **Two lies the new probe's own fields caught, before any reader could see either one.** `leftover` was first computed in a `finally` block, after the reading it belonged to had already been returned — the field could never reach the reader, which is decoration rather than evidence. Moving teardown ahead of the return immediately exposed the second: `response.json()` throws on the **204 with no body** a successful delete answers, so the probe would have reported a leftover session it had just removed — the same class of lie pointed the other way. `parseOpencodeServeBody` now tolerates an empty body, and both directions are pinned.

### Validation

- 84 test files / 2,466 tests passed, with TypeScript and ESLint (baseline 2,457/84 after stage A, 2,444/83 at 0.2.63). Verified against the real 2.0.32 kernel: the 1.x turn probe returns `unsupported` where it used to return `unavailable`, and the slice probe returns `{"status":"admitted","enqueued":true,"delivered":true,"started":true,"leftover":false}` on the same server. Reference baseline: Claudian is unchanged at `31dd256b` (2.3.22). **No model turn was spent** — `OPENCODE_SIMULATE=1` is a network gate, not a fake model, so the run ended in a named `provider.transport` retry rather than an answer, and no real credentials were used. A side finding recorded in the research: `OPENCODE_SIMULATE` is the "fake LLM" seam Claudian's own `AGENTS.md` rule asks verifications to use, and this is how the slice could be measured end to end without one.

### Deferred, and why

The chat backend is **not** rewired onto HTTP: the gap analysis' stage-3 precondition ("tool/permission coverage is incomplete, so the backend's open range must be limited") is not met, and a probe measuring a slice is not the same claim as a session that can run on it. The three 1.x probes are kept as the record of what that wire did; they gained an honest `unsupported` bucket but their dialects were not rewritten, so the fork probe's teardown still deletes on the 405 route and may leave throwaway sessions on this generation — visible in its `unsupported` reading, fixed in its own round. No `session.execution.succeeded/failed/interrupted` event was observed at all: the simulation gate parks the run in retry, so the terminal-event names remain unmeasured.

## 0.2.63 - 2026-10-17

No new capabilities. This release answers a class of lie the last two cycles had not reached, because the premise behind it had not been re-measured: the native probes were written against OpenCode 1.18.33, and the install they run against is now **2.0.32**.

### Fixed

- **The native reads authenticate — stage A**. Every `opencode serve` this plugin spawns now carries a credential the plugin chose itself, and presents it on every request, including the fork probe's raw fork-route read and the stream probe's SSE event stream. Measured on the real install: an unauthenticated `GET /api/{model,command,agent}` answers **401** with `{"_tag":"UnauthorizedError","message":"Authentication required"}`, while the same routes with Basic credentials answer 200. `OpencodeCatalog.defaultRequest` threw a bare `Error` on `!response.ok`, `Promise.allSettled` folded all three rejections into `unavailable`, and the panel said **"Could not read the native catalog — `opencode serve` did not answer"** about a server that was alive and holding 19 models, 2 commands and 7 agents. Run against that same live server through the shipped bundle, the 0.2.62 code returned `{status: "unavailable", routes: {models/commands/agents: "unavailable"}}`; after this stage the same call returns `observed` with real models and context windows. The contract is not inferred: `packages/server/src/auth.ts` (username `opencode`), `packages/cli/src/server-process.ts:86-92` (a password is *required* outside service mode) and `:202-203` (the password is printed only when the caller did not supply one) are read at v2.0.32. `OpencodeServeAuth` therefore mints the password rather than scraping it, so the credential never reaches stdout, logs or the panel. Both `OPENCODE_PASSWORD` and `OPENCODE_SERVER_PASSWORD` are written, because v2 prefers the first (`env.ts:10-11`) while the 1.x line reads only the second — verified empirically against both binaries (200 with credentials, 401 without). An inherited value from the host is overwritten rather than inherited, so a stale `OPENCODE_PASSWORD` in the desktop environment cannot win the lookup and lock out the read with a credential the reader never chose.
- **A refused read is its own sentence — stage B**. `OpencodeCatalogStatus` gains `unauthorized`, and `classifyCatalogRoute` separates a refusal the server *stated* (401/403) from a route that simply never answered — a connection failure, a malformed body, an HTML catch-all all stay `unavailable`. The two send the reader to different places (the credential vs. the install), so the Settings catalog surface and the Diagnostics row each gained a distinct localized line, and only an `observed` route's payload is ever mapped, so a refusal can list nothing. `OpencodeCatalogService.refresh` needed the matching fix: it treated every non-`observed` result alike, kept no observation and set `unavailable: true` — which is precisely where the new status would have been swallowed back into the old sentence. Upstream reached the same ruling independently in Claudian `c5ed1a3b` (#1649, "distinguish discovery failures from empty catalogs"), whose `#runProbe` had been swallowing every exception into `null`; this release adopts that ruling on the co-ober side. Three boundaries pin the split from both directions — a 401 says "refused this read" and never "did not answer", an unreachable route still says "did not answer" and never "refused", and a partial read keeps the routes that answered while naming the one that refused. An anti-remerge guard pins that the refusal sentence differs from both "did not answer" and the per-route unavailable caption, in en and zh.

### Validation

- 83 test files / 2,444 tests passed, with TypeScript and ESLint (baseline 2,429/82). Seventeen new boundaries: a new `OpencodeServeAuth.test.ts` for the password width, both env names, the inherited-value overwrite and the Basic credential shape; catalog boundaries for the spawn env, the whole-catalog refusal, the still-unavailable route, the partial read, and a pure `classifyCatalogRoute` table; three Settings boundaries for the two sentences and the anti-remerge guard. Reference baseline: Claudian was fast-forwarded 34 commits to `31dd256b` (2.3.22) and its OpenCode provider was reviewed — `c5ed1a3b` is the upstream counterpart of stage B. Real-kernel evidence was gathered with an isolated `OPENCODE_DB` and `OPENCODE_CONFIG`; **no model turn was run, no prompt submitted and no session created**, and `OPENCODE_SIMULATE` was not enabled. A side measurement worth recording: `/api/command` and `/api/agent` contents follow the server's own working directory rather than the `location[directory]` parameter (2 commands / 7 agents from a scratch cwd, 0 / 0 from the vault cwd, identical query parameters), so the empty command and agent rows this release reports for the vault are that vault's real state and not a dropped mapping. V2 HTTP execution, native skills/compact/steer, shared server leases and checkpoint fork remain outside this release; ACP remains the chat backend. The turn/stream/fork probes gained authentication but **not** a refusal status — they still fold any failure into `unavailable`, deferred to a later round now that the authentication path no longer makes it the common case.

## 0.2.62 - 2026-10-14

No new capabilities. This release gives the three opt-in native probes — turn execution, turn streaming, and checkpoint fork — the same owned, cancellable, source-fenced lifecycle that 0.2.60 gave the catalog read and 0.2.61 gave Diagnostics, closing the gap 0.2.61's own research recorded: "turn/stream/fork explicit probes, which may consume model turns, still run on the old independent lifecycle; this round does not claim they have obtained cancellation/source fences."

### Fixed

- **The three model-spending probes can be cancelled, and are fenced to the source they measured.** `runNativeTurnProbe` / `runNativeStreamProbe` / `runNativeForkProbe` (`settings.ts`) each held a `running` flag and a last-reading field on the tab and simply `await`ed the probe, so: `hide()` cancelled only the catalog and Diagnostics services — closing the panel left an `opencode serve` child and a real model turn running out a 20–30s deadline; changing `opencodePath` mid-probe let a reading captured from the *previous* CLI publish as though it described the one now configured; and each probe's `finally` called `this.render()`, which empties the whole settings container and rebuilds every section — discarding the connection input the reader may have been editing, and repainting a panel that was already closed (`redrawNativeCatalog` / `redrawDiagnostics` both guard on `shown`; `render` does not). None of the three `detect*` functions even accepted a `signal`, so a caller that wanted to cancel had nothing to pass. A new `OpencodeProbeService<T>` owns each probe's running flag, reading, and source key, with the same constructor-injected reader shape as `OpencodeCatalogService`: it captures CLI/cwd/env up front, cancels on source change, keeps a reading the reader already saw but marks it stale rather than blanking it, and resolves `false` for any cancelled, superseded, or moved-source run so a late answer cannot publish. `hide()` cancels all three; a CLI change fences all three. Each probe gained a localized cancel button while it runs.
- **The probes accept an external signal, and a pre-cancelled reader starts no server.** `OpencodeTurnDeps` / `OpencodeStreamDeps` / `OpencodeForkDeps` gain `signal?: AbortSignal`, mirroring the version probe's 0.2.61 treatment. An already-aborted signal returns the honest default before `spawn` — these probes fork real sessions and spend real model turns, so starting a server after the reader gave up is work they did not ask for and cannot be taken back. An in-flight cancel aborts the internal controller, SIGKILLs the child (now guarded, so a throwing `kill` cannot block the reader), settles without waiting for a request helper or stream that ignores the signal it was handed, and still runs teardown. Cancellation stops the probe *reporting*; it is not a claim that the already-admitted turn stopped on the machine, and the teardown comments say so where the interrupt and the deletes are attempts rather than proofs.
- **The probe deadline no longer collapses into the cancel path.** The cancel arm races the work so cancellation settles on its own, but only the *reader's* cancel arms it. The internal deadline deliberately keeps its original path: a turn whose poll window expires is `admitted` — the kernel took the prompt and no answer came back inside the window — and racing the deadline through the same short-circuit would answer `unavailable` instead, merging the two buckets 0.2.55 separated and trading one lie for another. A boundary pins it by holding the poll open past the deadline: the correct design reports `admitted`, the racing design reports `unavailable`.

### Validation

- 82 test files / 2,429 tests passed, with TypeScript and ESLint. Twenty-two new boundaries: eleven in the new `OpencodeProbeService.test.ts`, three per-probe cancellation and never-spawn boundaries, and four in `settings.test.ts` for hide-cancels, the cancel affordance, the stale marking after a CLI change, and the scoped redraw. Each of the four load-bearing boundaries was confirmed to fail against the pre-fix behaviour before being kept. Reference baseline: Claudian was fast-forwarded 28 commits to `6c0c9587` (2.3.20); `git diff 630bfec9..6c0c9587 -- src/providers/opencode` is empty, and `OwnedProbeRegistry` / `ProviderTransitionFence` are unchanged, so the OpenCode provider still publishes the same ownership discipline this release mirrors. V2 HTTP execution, native skills/compact/steer, shared server leases and checkpoint fork remain outside this release; ACP remains the chat backend.

## 0.2.61 - 2026-10-11

### Added

- **Owned, cancellable diagnostics**: Settings now offers a localized cancel action. One service captures the CLI, working directory and launch environment for the entire run, fences each stage and final publication, and withdraws old diagnostic passes when the source changes. Cancel, Settings close, CLI changes and locale changes suppress late results; retries do not wait for an uncooperative collector. Diagnostics redraw only their own container, preserving edited connection controls.

### Fixed

- **Version probe shutdown**: pre-cancelled operations no longer launch a process. Cancellation, deadlines and excessive output settle promptly even if termination throws or close never arrives; environment snapshots, bounded stdout, stderr draining and late-error handling keep the probe isolated. Cancelling diagnostics never closes a shared ACP chat session; already-started shared runtime requests may finish internally, but cannot publish or start later diagnostic stages.

### Validation

- 81 test files / 2,407 tests passed, with TypeScript and ESLint. A read-only check observed OpenCode 1.18.33; cancelling a real version subprocess returned a failed reading and observed its SIGKILL close without creating a session or invoking a model. Claudian was fast-forwarded by 38 exact, hash-verified commits to `630bfec9` (2.3.16) and its latest OpenCode changes were reviewed. V2 HTTP execution, native skills/compact/steer and turn/stream/fork probe cancellation remain outside this release; ACP remains the chat backend.

## 0.2.60 - 2026-10-11

### Added

- **Owned, cancellable native catalog discovery**: a dedicated read-only service captures CLI, working directory and launch environment, fences publication after source changes, and lets the reader cancel or close Settings without a late result restoring the old catalog. Existing rows remain visible with a stale-source warning until a successful explicit refresh; discovery never creates a chat session or changes the ACP model selection.

### Fixed

- **Catalog reachability is no longer fabricated as emptiness**: operation-level cancellation and deadlines settle even if a request ignores abort. Only the existing `{ data: [...] }` response dialect counts as a valid route; HTML catch-alls, malformed payloads and failed routes are unavailable, not empty. Partial catalogs carry per-route evidence in Settings and no longer pass diagnostics as a complete roster. Process shutdown also absorbs delayed spawn errors until close. Catalog updates redraw only their own settings container.

### Validation

- 80 test files / 2,389 tests passed, with TypeScript, ESLint and release checks. A read-only probe of the currently installed OpenCode 1.18.33 observed all three catalog routes (47 enabled models, 2 commands, 7 agents) without creating sessions or invoking a model. This does not certify V2 HTTP execution, model application, steer, or checkpoint fork; ACP remains the chat backend.

## 0.2.59 - 2026-10-11

### Added

- **Native database path binding without changing the ACP backend**: sessions now retain the database path resolved from the ACP subprocess's captured launch environment. Native history listing and search carry their source into the local mirror; transcript, usage, todo, tool-error and turn-stat reads use that saved path instead of rediscovering a database from a changed environment. Restore, resume, fork and send refuse a known source mismatch (including an unresolved current source), keep the conversation intact, and show a localized explanation rather than silently replacing it. Session and side-chat teardown also avoid addressing an old id through a different database. Legacy sessions acquire a binding only after a successful attach; malformed, relative and in-memory bindings are not persisted. This is path-based isolation using the existing resolver, not a new HTTP kernel, filesystem identity verification, or live CLI capability certification.

## 0.2.58 - 2026-10-06

### Fixed

- **Closing the last tab no longer spawns a new empty tab**: the strip used to answer a last close by minting a replacement badge — a tab with no session, no negotiable model and nothing selectable, which reads exactly as "an invalid empty tab appeared when I closed the last one." The runtime it creates is genuinely needed: the composer, send button, context arc and welcome screen are shared surfaces and must project onto *something* while no tab exists (0.2.5x's re-projection cure stays whole). What changes is that this projection anchor is no longer presented as a tab. `closeTab` now keeps the placeholder off the strip — `tabDescriptors()` answers empty, `persistTabShell()` records an empty shell list and a null front tab, so the invalid tab never reaches the bar and never returns on the next launch. The welcome screen with an empty strip remains fully operable: the `+` button, a typed prompt, an opened or resumed session are the actions that *earn* a tab, and each routes through a new `claimTab`, which promotes the placeholder to a real strip tab at the exact moment the reader asks a conversation of it (top of `send`, `ensureRuntimeSession`, and the adopt branches of `newSession`/`switchSession`/`resumeSession`) — before the agent work begins, so the `stillOpen` guards that protect every long await keep holding. When the reader chooses a real tab instead — `+` with a fresh session, a history open, a fork — `activateRuntime` retires the placeholder outright: its panel is disposed and its stream torn down, so invisible surfaces cannot accumulate across repeated close cycles, and a never-claimed placeholder's stream is disposed on view close too. The retirement is gated on an explicit `placeholderRuntime` marker, not on "not in runtimes," because a just-closed tab is also absent from the map — without the marker the strip's own close teardown would run twice on one panel. Five new boundaries in `CoOberViewController.multiTab.test.ts` pin the empty strip after a last close, the empty persisted shell with a null front tab, the send-claims and +-claims promotions, and the placeholder panel teardown; the 0.2.5x projection test was re-anchored from "the strip starts a fresh tab" to "the strip starts empty," keeping its re-projection assertions — *stop* off, send back, arc cleared — intact. The startup tab is untouched: a first launch still opens one conversation tab, because there the tab is the beginning, not the residue of a close.


### Added


- **The kernel's fork boundary is now measured, and it does not carry history** (stage F, gap-list #2): 0.1.33 declined per-message "fork from here" because "the protocol has no anchor," and set its revisit trigger as "when opencode ships a fork API that accepts a `messageID` boundary." That trigger has arrived — `opencode serve` 1.18.33 documents `POST /session/{id}/fork?directory=<cwd>` with `{messageID}` ("Create a new session by forking an existing session at a specific message point") — so the honest stage is to measure what the anchor actually delivers before any surface promises a truncation. The live measurement overturns the 0.1.33 reason and confirms its conclusion for a new one: the fork returns a child session (id, "(fork #N)" title) that reads back **zero rows** — through the v2 `.../message` API, the legacy API, and the kernel's own `session_message` SQLite table, the store co-ober's readers use — and the v2 JSON fork route other references call (`POST /api/session/{id}/fork`) does not exist as an API at all: it is caught by the server's single-page web UI and answers `200` with `text/html`, so a caller parsing `.data.id` would be reading a page. `OpencodeForkProbe.ts` encodes exactly that. It needs no model answer: two admitted prompts put two user rows on a throwaway transcript, and it forks at the first one, because an empty child, a whole copy, and a true truncation are distinguishable from row sequences alone. The pure halves say only what the readback showed — `forkRouteShape` classifies the v2 route by transport facts (content-type and a named child id), never by status code, so the HTML catch-all is named as the catch-all; `classifyForkCopy` claims `anchored` only when the child is exactly the source prefix ending at the anchor, says `child-empty` plainly instead of reading emptiness as truncation, and calls anything else `unexpected` rather than rounding it into a known shape. `detectOpencodeNativeCheckpointFork` never throws — every setup failure lands `unavailable` — interrupts the throwaway turns before forking so the child is read from a settled transcript, deletes the forked child and the source session during teardown (validated against the live kernel), and SIGKILLs the server. The reading is a fifth opt-in Settings button beside the other probes — it starts a server and forks sessions, so it never runs unasked — and its detail line carries the concrete counts the wire showed (`{parent} source rows · {child} child rows · /api fork route: {route}`), with `fork-from-here is buildable` reserved for an `anchored` reading this install does not produce. Nineteen boundaries (fifteen in `OpencodeForkProbe.test.ts`, four in `settings.test.ts`) pin the transport-fact route classification, the exact-prefix anchored gate versus whole-copy/empty/unexpected, the no-answer-needed transcript seeding, the child-and-source deletion, the teardown guarantees, and the surface keeping "could not fork" and "forked empty" as separate sentences. The decision record gains a re-check section: the anchor exists, the fork carries no transcript, and the per-message action stays unimplemented until a future install reads `anchored`.


### Added

- **The native kernel's live event stream is now proven to deliver a readable answer** (stage E, #280 remainder): 0.2.55 proved a turn executes, but read the finished message back by polling `GET .../message` — it never touched the `session.next.*` server-sent-event delta stream, which is the only channel a live streaming transcript could render from. Claiming the rewire's streaming half rested on a wire the plugin had not read, so this stage measures it first, the same probe-before-surface discipline that put 0.2.53's catalog probe ahead of 0.2.54's catalog surface. The event contract was watched on the running 1.18.33 install, not copied from another reference: `GET /api/event?location[directory]=<cwd>` returns `text/event-stream`, each frame a `data:` line whose JSON carries the event in a `type` field with the payload in `data`, heartbeat lines begin with `:`, and the answer lifecycle is `session.next.text.delta` (fragment in `data.delta`) followed by `session.next.text.ended` (whole in `data.text`). A real throwaway turn was driven end to end through the shipped module and observed streaming — 15 reasoning deltas then the answer "OK", assembled from the delta frames and matched by the kernel's own ended frame. `OpencodeStreamProbe.ts` keeps parsing pure and IO honest: `parseSseDataFrames` reads only `data:` frames and drops heartbeats and any frame whose JSON does not parse (a malformed frame is not evidence of a streamed word); `reduceNativeStream` folds events for one session into a reading, filtering by `data.sessionID` so the directory-scoped stream's hydration noise and any other session's frames cannot leak into the answer, concatenates text fragments in arrival order, and sets `confirmed` true only when the kernel's ended frame equals the assembly — agreement, not assumption. `detectOpencodeNativeTurnStream` opens the stream before admitting the prompt so fragments are watched live, never throws, and holds three distinct states — `unavailable` when setup itself failed, `admitted` when the kernel took the turn but streamed no answer text (channel live, streaming NOT confirmed), `streamed` only when a non-empty answer was assembled from delta frames; its iterator finishes cleanly on abort so a partial answer is still reported, and the throwaway session is interrupted and SIGKILLed in a `finally`. It reuses the catalog's loopback-only origin guard. The reading is a fourth opt-in Settings button, not a Diagnostics row, because it spends one real model turn and must never run unasked; its agreement line is kept a separate claim from its streamed line, so an answer that streamed but whose ended frame disagreed reports "kernel agreed: no" and the panel can never launder "I saw fragments" into "the kernel confirmed them." Twenty-two boundaries (seventeen in `OpencodeStreamProbe.test.ts`, five in `settings.test.ts`) pin the data-frame-only parsing, the per-session filtering that drops foreign deltas, the delta assembly, the confirmed/unconfirmed distinction, the three buckets kept distinct, the open-before-prompt ordering, the directory-scoped event URL, the guaranteed teardown, and the never-spawn path. This stays a measurement, not the rewire: with both the execution and streaming channels now honestly observed, the full contract a send-path rewire needs is recorded and verified, and that rewire remains a separate deliberate decision rather than a silent swap of the ACP channel the plugin already drives faithfully.

## 0.2.55 - 2026-10-04

### Added

- **A native turn is now proven to execute here, and the probe reads its answer back** (stage D, #280 remainder): 0.2.54 deferred the HTTP send-path rewire on the recorded reason that this environment "cannot produce or observe a live native turn." Continuing the arc, that premise was measured against the real install instead of trusted, and it is false — `opencode serve` 1.18.33 runs a throwaway turn end to end here and the run was watched, so correcting a false blocker is the honest core of this stage. The measured live contract differs materially from Claudian's reference kernel, so copying that kernel would have shipped a probe against a wire this install does not speak; what was actually observed is now encoded. Session creation is `POST /api/session` with `{location:{directory},agent:'build'}`; the prompt is `POST /api/session/{sid}/prompt` with a **nested** `{id:'msg_<hex>',prompt:{text}}` — not Claudian's top-level text/files — the id must carry the `msg_` prefix, and `delivery` defaults to `'steer'` even for the first prompt; the event stream is the `session.next.*` namespace, not `session.execution.*`; and the message read-back `GET /api/session/{sid}/message` discriminates rows on `type` (`'user'`/`'assistant'`), not `role`, with the assistant answer in `content[].type==='text'.text`. Interrupt is `POST .../interrupt?resume=false`, a 204 with no JSON body. `OpencodeTurnProbe.ts` reads only that: `assistantTextOf` returns an answer solely from an assistant row carrying a non-empty text part, so a reasoning-only or empty turn is never counted as executed; `detectOpencodeNativeTurnExecution` never throws — a blank path, a spawn error, a server that exits before naming an address, a session with no id, or an un-admitted prompt all land `unavailable`, a prompt the kernel took but never answered lands `admitted` (the honest middle state: channel live, execution NOT confirmed), and only a read-back assistant text lands `executed`, carrying the model, finish and output-token count the row actually reported. It reuses the catalog's loopback-only origin guard, and SIGKILLs and interrupts the throwaway session in a `finally` so neither a server nor a turn leaks. The reading surfaces beside the catalog as a second Settings probe row, gated behind an explicit button because it spends one real model turn — it never runs on panel open — and its four states stay four distinct sentences, with an anti-remerge test pinning that `unavailable` ("could not run") and `admitted` ("channel live, execution not confirmed") can never collapse into each other or into the executed claim. This is still a measurement, not the send-path rewire: the full contract needed to rewire is now recorded and verified, so the rewire stays a separate, deliberate decision rather than a silent swap of the ACP channel the plugin already drives honestly. Seventeen boundaries (ten in `OpencodeTurnProbe.test.ts`, four in `settings.test.ts` alongside the three catalog rows) pin the assistant-text-only executed gate, the admitted/executed/unavailable buckets kept distinct, the directory scoping of session creation, the guaranteed interrupt-and-kill teardown, and the never-spawn paths.

## 0.2.54 - 2026-10-04

### Added

- **The native catalog leaves the diagnostic and becomes a surface you can read** (stage C, #280 remainder): 0.2.53 proved `opencode serve` lists a real catalog and put only its *counts* in Diagnostics, explicitly "not yet a picker wiring." This spends it — a new Settings section runs the same probe behind a button and lists what it observed: each model with its context window, each command, each agent with its description. Because the probe starts a throwaway loopback server it is never run on render; the reader asks, and the panel answers. The surface is read-only and marked separate from the connected session, so it reports the native install's catalog without ever implying a selection the ACP wire has not confirmed — the reconciliation hazard 0.2.53 named as the reason to hold the catalog back is met by not turning it into a control. The honest states stay distinct rather than collapsing: a panel that has not been asked says "not loaded" instead of guessing; a `serve` that never answers names itself a reachability failure, not "listed nothing"; a catalog that genuinely lists nothing names the emptiness, not a failure; and a model with no reported context or an entry with no reported description says so instead of inventing one. Four `settings.test.ts` boundaries pin each, with whole-container assertions that keep the empty and unreachable sentences from bleeding into each other.

### Deferred, and why (stage C's other two clauses)

- **Turn-steer over the HTTP kernel and the ACP→HTTP send-path rewire stay open.** Stage C was scoped as "turn-steer + HTTP-backend send-path rewire + spending the catalog on a surface"; only the last clause ships. A native mid-turn steer is `POST /api/session/{id}/prompt` with `delivery:'steer'` plus the SSE `session.inbox.delivered` signal, and native model/agent selection is a `POST .../model` the agent must then answer on — all observable only by running a real turn with real credentials and a live streaming read, which this environment cannot produce. Claiming it would repeat the laundering the earlier cycles refused. The honest ACP form of "steer" already exists and is not rebuilt: the per-tab prompt queue parks a follow-up behind the in-flight turn and releases it when idle — what the stdio channel actually offers. #280's remaining clause is gated on a demonstrable live turn, not on a version number.



### Added

- **The native OpenCode catalog is now read from a real server, not asserted**: #278 closed by proving co-ober already carries the honest channels (ACP `availableModels`, ACP `availableCommands` + vault `FileCommandStorage`), and recorded that the one thing it could not get honestly over V1 — an authoritative HTTP model/command catalog — had to wait for a live endpoint rather than be fabricated. #280 opened as the `opencode serve` HTTP backend where a real catalog can be observed; the stage before this one was blocked on the premise that it needed an OpenCode "v2" binary this environment lacked, and correcting that premise is the honest core of the work. Measured against the real install, the CLI here is 1.18.33 and its `opencode serve` already speaks `/api/model` · `/api/command` · `/api/agent` over a plain loopback GET with a `location[directory]` scope (45 enabled models, 2 commands, 7 agents observed). The version major and the catalog-API generation are not the same axis, so the catalog now gates on the observation itself, not on `generation === 2` — a gate that would have hidden a catalog that is genuinely observable today. `OpencodeCatalog.ts` reads exactly what was watched: a plain-text readiness line ("opencode server listening on http://127.0.0.1:PORT"), not the JSON a `--stdio` variant prints, and it refuses any origin that is not http on 127.0.0.1/localhost with no embedded credentials — a server announcing some other host is never contacted, because opening the plugin's first native read over an unverified origin is the untrusted channel this arc exists to refuse. The maps are pure and narrow: `mapNativeModels` keeps only rows the install marked `enabled === true` with both a provider and an id, naming each `providerID/id` / `providerID/name` and carrying the context limit, dropping a disabled or half-described row rather than rounding it up — the same refusal 0.2.49-C made when the Default Agent dropdown fabricated `build`/`plan`. `detectOpencodeNativeCatalog` never throws: a blank path, a spawn error, a server that exits before naming an address, or a killed timeout all land as `unavailable`; a server that answers but lists nothing lands as `observed` with empty lists, so a reachable-but-barren install is never laundered into "cannot read" and an unreachable one is never laundered into "has nothing", while a partial read reports `observed` with the lists it actually got. The child is SIGKILLed in a `finally` so no process leaks. The reading surfaces on the Diagnostics panel, one row under the version probe it shares a resolver with — a probe result, not a config echo — and Passes only when the server answered AND named something. This is a measurement row, not yet a picker wiring: the catalog is proven observable and read honestly before any stage spends it on a surface that must reconcile with the ACP channel above it. Seventeen boundaries (fourteen in `OpencodeCatalog.test.ts`, three in `settings.test.ts`) pin the URL parsing, the enabled/complete-only model filtering, the `unavailable`/empty/partial buckets kept distinct, the loopback + directory scoping, the guaranteed teardown, and the anti-remerge guard that the two catalog failure classes — carrying opposite remedies — can never collapse into one sentence.



This release opens the co-ober↔Claudian OpenCode feature arc that the honesty-pack cycles had been holding shut. The patch-only rule is lifted for this work: four capabilities land. Every one is still built only on signals the runtime actually reports — each either replaces a surface that claimed more than the wire showed, fills a gap the roadmap named, or adds a measurement so a later stage cannot certify behaviour the install never produced. Released together from the stage commits labelled 0.2.50, 0.2.51 and 0.2.52.

### Added

- **A spawned sub-agent renders as a sub-agent** (0.2.50 stage A, #276): co-ober carried a `renderSubagentBlock` method, a `'subagent'` ContentBlockType and a `SubagentInfo` interface — a whole rendering surface — yet no code path produced a subagent block; the method's own comment said "(stub)" and a reader watching OpenCode delegate saw a generic tool card indistinguishable from a `read`. The honest V1 signal (confirmed against Claudian's `opencodeToolNormalization.ts`) is the tool name: a sub-agent arrives as an ordinary `tool_call` whose ACP `kind` collapses to `other` and whose raw `name` is `task` or `subagent`. `isSubagentToolName` matches those names and nothing else, `streamController` derives the render kind from it once per frame and rides the existing persisted `toolKind`, so a reload re-renders the card with no new field and no restore-path change. `ToolCallRenderer` gained a `users` icon, a `toolKind.subagent` label (en 'Sub-agent' / zh '子智能体') and a `getSubagentSummary` naming the delegated agent and its task. The producer-less dead surface (type, interface, method, case, stub CSS) was deleted. Per-child native sessions and streamed sub-agent progress are OpenCode-V2 HTTP-kernel events that ACP stdio never reports, so they are deliberately not claimed here — that lives in the V2 backend stage.
- **A settled sub-agent stops downgrading to a plain tool** (0.2.50 stage A follow-up): stage A re-ran the name check on *every* frame, and OpenCode re-sends `raw.name` only on the first snapshot, omitting it on later updates. So the frames that carried the name certified `subagent` and the ones that did not re-derived back to `other` — a `task` call drew its card while pending, then its completing frame silently repainted that same card as an ordinary tool, and the downgraded kind was persisted so a reload agreed with the lie. One rule at both update sites: a kind a frame already certified outlives a frame that forgot the name. Nothing on the wire ever contradicts an earlier `task`, so the fix is a monotonic guard, not a new field — `subagent` still rides the persisted `toolKind` and `renderer.ts` needed no change.
- **A session the agent will not replay is read from OpenCode's own database** (0.2.50 stage B, #277): `switchSession(id, 'opencode')` reaches its notice line with an empty collector on three branches — the loaded early-return, the resume branch (which reconnects without replaying history), the sync-unsupported fallthrough — and each painted "no earlier turns were replayed" over an empty pane. That sentence was true, but a session started in the OpenCode terminal lives in `opencode.db` whether or not the agent streams it back, so the pane stayed blank in front of a conversation on disk. `readNativeSessionTranscript` reconstructs exactly the `SerializedMessage` shape the replay collector emits — text and thinking only, real `time_created` stamps, each message's own `nativeMessageId` — on purpose matching the replay's fidelity so the fallback never projects a richer transcript than the agent would have streamed. When the agent replayed turns, nothing is touched; when it replayed nothing, the database is asked, and a transcript that comes back is adopted under a NEW `restoredNativeHistory` notice ("Read this OpenCode session from OpenCode's saved history on disk"), not `loadedNative`, which would credit a load that never happened. An empty read — no database, degraded schema, no text parts — keeps the no-replay notice: an unavailable read is never dressed up as a restored conversation. `readNativeSessionTranscript` never throws.
- **Zen / focus mode** (0.2.51 stage A, #279): the pane can drop its own chrome so only the conversation and its composer remain. `setZenMode` toggles `co-ober-zen` on the view root (matching `setAutoScrollEnabled`'s surface-wide reading, so every open tab in the pane focuses at once); `onOpen` re-applies it from `settings.zenMode` because the setting is the plugin's and the class is DOM a close cannot survive; the Settings toggle and the `toggleZenMode` command fan out through the same sibling-repaint the permission and model dropdowns run. The CSS rule hides only the header and tab strip — the root's direct children — leaving transcript and composer untouched. This is pure client-side UI with zero runtime claim to launder: no option is offered that the agent never confirmed, no field is asserted as observed. The roadmap's other two #279 items were already shipped under other names — `sideChatPanel` is the /btw scratch thread (dual-pane), `aiEditSelection` + `inlineEditPanel` + per-tab `pendingSelection` already carry a selection into its own turn (selection→prompt).
- **An OpenCode version probe gates the V2 stages on a measurement** (0.2.52 stage A, #280): before any stage can claim V2 behaviour, the plugin has to know whether the install is V2 at all — otherwise the first act of the V2 backend is the oldest failure this project keeps retiring, certifying behaviour the runtime never reported. `detectOpencodeVersion(cliPath)` runs the configured binary's `--version` and reads back what it answered, reusing SqliteReader's proven one-shot spawn shape (Windows-resolving `getSpawnInfo`, SIGKILL timeout, output cap, injectable spawn). It never throws — a missing binary, a timeout or a non-zero exit all land as the honest "could not be read", never a version of zero or a guessed major. `parseOpencodeVersion` takes the first dotted-number token out of a decorated banner instead of trusting the whole line; `opencodeNativeGeneration` names a generation only for a major of 1 or 2 (the two this plugin has a wire for), and an unknown major is never rounded up into a supported one. The reading surfaces on the Diagnostics panel as a probe result, not a config echo, and later stages gate V2-only behaviour on `generation === 2` measured here — a fact, not a toggle.

## 0.2.49 - 2026-10-03

No new capabilities. This release answers three more faces of the same class of lie 0.2.42 through 0.2.48 refused on their own surfaces: a UI or wire claim that certifies a state the code has not observed. A third writer of `session.title` that reached the field from the wire without raising the fanout its two user-driven siblings already raise; a response schema that minted `end_turn` from a missing or malformed reason, letting the transport defeat the view's own verbatim-badge discipline; and a Settings dropdown that filled an unsurveyed agent list with `build`/`plan`, certifying a roster the runtime had never reported.

### Changed

- **An agent-side rename repaints the tab strip**: `streamController.ts:323-333`'s `case 'session_info'` writes `session.title = ch.title` and calls `scheduleSave()`, then returns. Two user-driven mutators of the same field — `renameSession` (`CoOberViewController.ts:3016`, its own comment names `tabDescriptors()` as the snapshot the strip reads and `notifyTabsChanged()` as the only way to rebuild it) and `maybeAutoTitle` (`:2988`, cured this exact shape in 0.2.47 stage B) — already raise the fanout. The wire-driven third did not, so `sessionDropdown` (which reads `list()` live) showed the new agent title while the tab strip kept the minted timestamp until some other branch's repaint. Same family as 0.2.42 stage B on the custom-agent rename, 0.2.43 stage A on the skill-rename, 0.2.45 stage C on the delete handler — a mutation into a shared field that repaints its own reader but not the sibling that reads it. The reader who never clicks is the one left out: an OpenCode-native title refinement, an assistant that starts calling the session something else after the plan lands — none of those reach the strip. `StreamControllerDeps` gains an optional `onTitleChanged?: (sessionId: string) => void` callback (a function, matching every other deps entry so a runtime with no controller wiring stays silent), fired only on the successful-write branch (missing sid, unknown session and missing title each keep their silent path so the fix cannot become a blanket repaint on a rename the store never accepted); `CoOberViewController.ts`'s StreamController construction wires `onTitleChanged: () => this.notifyTabsChanged()`. Six boundary tests: four in `streamController.test.ts` pin the fanout on the write branch and its absence on each silent branch; two in `CoOberViewController.test.ts` drive the chunk through the controller's own runtime and assert `onTabsChanged` fires once on the write branch, zero when the store has no such session.
- **A response with no reason stops pretending to say `end_turn`**: `AcpClient.sendMessage`'s schema (`acp.ts:1033`) read `stopReason: z.string().catch('end_turn')`. `.catch` is not a "field was absent" branch — it fires on any failure of the inner parser (missing key, `null`, a number, a non-object shape) and mints the same value for all of them. `CoOberViewController.surfaceStopReason` (`:2272`) is written to refuse this shape on any reason it does not recognize: unknown strings arrive as a verbatim badge (`:2295`, whose own comment reads "better a verbatim badge than a silent turn that looks like it completed normally"). Because the transport stamped `end_turn` on the frame's way up, the reason chain skipped in silence — the view's discipline defeated by the client that fed it. A result field arriving as JSON `null`, a `stopReason` that came through as `42`, a malformed object: each rendered as a clean completion. Same refusal as 0.2.44 A on the model switch ("asked", not "landed"), 0.2.48 C on `setModel`'s optimistic meta (accepted, not applied), and 0.2.48 B on transcript saves (resolved, not landed): one signal, one claim. The fix mirrors the sibling treatment the schema already uses for the same field on `state_update` (`acpSchemas.ts:335`, `.nullish().transform((s) => s ?? undefined)`); `z.string().optional().catch(undefined)` keeps well-formed strings unchanged, hands a non-string / null to `.catch(undefined)`, and lets a missing key pass through via `.optional()`. `AcpResponse.stopReason` widens to `string | undefined` (`types.ts:234`); `surfaceStopReason` grows an `else if (response && !reason)` branch that fires a new i18n key `stopReason.notReported` ("The agent finished the turn without reporting a stop reason — the answer may be incomplete." / "智能体结束本回合时未上报结束原因，回复可能不完整。"). Two existing transport tests that had pinned the laundering — "reads a prompt answer that carried no result at all as a finished turn" and its null-result sibling — reword to "...as no reason reported" and assert `undefined`; `acpRecovery.test.ts`'s "falls back to end_turn instead of discarding usage" rewords to "keeps its usage without claiming end_turn". Three new view boundaries and two new transport boundaries: absence fires notReported, a clean `end_turn` stays silent (so the fix does not become a blanket badge that speaks every turn), a valid `max_tokens` passes through unchanged (the schema must not swallow real strings), a wire `null` arrives as `undefined` rather than the laundered string, and the anti-remerge guard pins notReported differs from unknown-with-empty-reason.
- **The Default Agent dropdown stops fabricating a roster the runtime never reported**: `buildAgentOptions` (`settings.ts:954-964`) looped its `agents` argument and, whenever that loop left the map empty, wrote `options.build = 'build'; options.plan = 'plan'` unconditionally. On a Settings panel opened before any connection, or after a reconnect whose runtime fetch had not yet completed, `getAvailableAgents()` (`:868-875`) returned `[]` (no client, no snapshot, no survey) and the dropdown nonetheless offered two named agents. Listing an option asserts it will attach; the assertion was ours, not the runtime's. The same file already refused this exact shape twice at its `Loaded Skills` and `Common Models` sections (`:338-351`, `:394-404`) — "a survey that was never taken may not sign off on emptiness" — and `loadRuntimeOptions` at `:916-923` sets `unavailable` on precisely this state. The agent dropdown bypassed that machinery entirely. 0.2.45 stage B refused the same on the toolbar's model chip ("No model yet" / "尚未获得模型"); this is that ruling relocated to the settings side. The fix drops the fabricated pair and adds the `{'': '—'}` sentinel — the same none option `buildModelOptions` (`:967`) already carries, so the two siblings finally share a vocabulary. The stored-default fallthrough stays (`:971-973`): a persisted `defaultAgent` still surfaces in the list even under an absent survey, so the reader sees what their settings file holds; only the fabricated alternatives are gone. The prior curated roster at 0.2.5 stage 3 stripped `docs` (which no code path ever sent) while keeping `build`/`plan` as "modes the client can actually start"; 0.2.49 C refuses that certification too — the client does not start a mode, the runtime does, and the runtime has not been asked. Three new boundary tests pin the honest shape (empty survey yields only the sentinel, a stored `defaultAgent` under an empty survey still appears, a well-populated survey returns exactly its roster plus the sentinel) and one existing 0.2.5 stage 3 test is reworded to assert the new shape with the historical note preserved in its comment.

## 0.2.48 - 2026-10-03

No new capabilities. This release answers three more faces of the same class of lie 0.2.42 through 0.2.47 refused on their own surfaces: a UI or wire claim that certifies a state the code has not observed. A native-session attach that announced "earlier conversations loaded from OpenCode history" on the branches where the collector had replayed nothing; a transcript save that resolved into the never-rejects wrapper and left the tab painting as saved while its reply lived only in memory; and a mode/model RPC that rewrote the agent's session-meta on the strength of transport acknowledgment alone.

### Changed

- **The "earlier turns were loaded" line only earns itself on a real replay**: `switchSession` (`CoOberViewController.ts:1641-1647`) awaited the load/resume path, ran `collector.finish()`, and unconditionally spoke `session.loadedNative` — "Loaded OpenCode session. Earlier conversations live in OpenCode history; new replies continue here." Three sibling branches reach that sentence while the collector holds nothing: the `isSessionLoaded` early return at `:1359`, the `resumeSession` path at `:1364` (which never calls `onReplayUpdate`), and the `syncUnsupported` fallthrough at `:1372` (agent supports neither `session/load` nor `session/resume`, so we attach by name alone). In all three the reader is told a history has been re-opened that has not, and the sentence points them at OpenCode's own transcript for what is actually missing here. This is the same class 0.2.44 stage A refused on the model-switch RPC (accepted is not completed), 0.2.46 stage A refused on the MCP transport caption (a null client is not an agent that does not advertise), and 0.2.47 stage A refused on the settings Notice (a resolved save is not a landed save). The fix hoists `collector.finish()` into a named `replayed` variable and gates the system message on `replayed.length === 0`; a new i18n key `session.resumedNativeWithoutReplay` speaks the honest "Re-attached to this OpenCode session; no earlier turns were replayed" / "已重新挂载该 OpenCode 会话；未回放更早的对话。" in en and zh. Three boundary tests: the positive drives `loadSession` with an `onReplay` callback that fires a real chunk and pins `loadedNative` was said, `resumedNativeWithoutReplay` was not; the negative uses the plain `createMockClient` (which resolves without invoking `onReplay`) and asserts the pair flips; the anti-remerge guard pins the two strings differ so a future edit cannot re-collapse them.
- **A transcript save that resolves without landing lights the "not saved" badge**: `streamController.persist()` (`:659`) awaited `sessionStore.save()` and treated resolution as success; the `.catch` on that chain was the only path to `onPersistFailure`. 0.2.47 stage A had already documented that `sessionStore.save` wraps `plugin.savePluginData()`, whose contract is never-rejects — every disk failure folds into a throttled sticky alarm and the promise resolves identically whether the write landed or threw. So the `.catch` never fires in production: on a locked `data.json`, a read-only vault, a full disk, an EPERM mid-write, the reply stays on screen and the tab keeps painting as saved — exactly the failure the `notSaved` badge exists to say out loud. The sibling refusal was already mounted at settings.ts:292 (reads `plugin.lastSaveOk === true` before the "Saved" Notice) and at acp.ts setModel (0.2.44 A: accepted is not landed). The fix widens the controller's runtime contract (`ControllerRuntime` at `:110-118` gains `readonly lastSaveOk: boolean | null`), threads it through `StreamControllerDeps` as a getter (a getter, not a value — `persist()` runs long after construction and must see the flag the last save actually set), wires it at `CoOberViewController.ts:251`, and reorders the persist chain so `.then` checks the flag on the resolving branch and `.catch` handles the (test-only) rejecting branch. Four boundary tests: `lastSaveOk=()=>false` fires `onPersistFailure` once, `lastSaveOk=()=>true` stays silent, `lastSaveOk=()=>null` (no save observed) stays silent, and the pre-existing rejecting-save path with the same false flag fires exactly once — the double-fire guard on the `.then(onFulfilled, onRejected)`-shaped ordering.
- **A mode/model RPC that only acknowledged keeps the id the agent last reported**: `AcpClient.setMode` (`:921`) and `.setModel` (`:926`) awaited `requestWithFallback` and then unconditionally wrote `metaFor(id).currentModeId = modeId` / `.currentModelId = modelId` — a claim about what the agent's session now is, minted by us on the strength of the transport answering "OK, message received". 0.2.44 stage A ruled that the current id is written only by the agent's own config chunks; the sibling `setConfigOption` (`:935`) obeys — it applies only what the agent returned in the RPC payload, never the value it was sent. The two optimistic writes were the last callers that insisted on the value they had sent; a transport that accepted the request and then kept the old model on the agent's side (a fallback path, a pruned mode, a router-refused id) left `getSessionSnapshot().currentModelId` naming a switch the very next turn contradicted, and the toolbar re-projecting that snapshot told the reader their session was on `gpt-new` while the agent streamed a reply from claude. The fix drops both writes and leaves `applySessionUpdate` (`:1258-1268`) as the sole writer. Four boundary tests: for `setModel`, dispatch `current_model_update: 'claude-old'`, resolve the RPC with no chunk → snapshot still reads `claude-old`; for `setModel` positive, resolve alone → snapshot is null (the RPC paints nothing), then dispatch the chunk → snapshot reads `gpt-new`; same two halves on `setMode`/'plan'/'build'.

## 0.2.47 - 2026-10-03

No new capabilities. This release answers three more faces of the same class of lie 0.2.42 through 0.2.46 refused on their own surfaces: a UI claim that certifies a state the code has not observed. A settings Notice that promised the write landed while the save path had already folded the failure into a sticky alarm; a tab strip that kept the minted timestamp under a store that had already been re-titled by auto-title on the first exchange; and a welcome badge that spun "Connecting…" over a transport whose retry loop had already fired its last attempt and given up.

### Changed

- **The "Setting saved" Notice only promises a save that landed**: `savePluginData` (`main.ts:230`) swallows every disk failure into a throttled sticky alarm and resolves identically whether `super.saveData()` landed or threw; the boolean at `:240` was computed and then discarded, only reaching the outside world as the argument to `onPersistenceOutcome` — a callback no fire-and-forget call site can inspect. `settings.ts:292`'s maxNoteSize onChange awaited `save()` and unconditionally fired `new Notice(locale().settings.notes.saved)` on top of that. On a locked `data.json`, a read-only vault, a full disk, the plugin said "Setting saved", closed the panel, and reloaded to find the older value still in place — pointing the reader at a bug in their own memory rather than at the alarm already sitting in the same viewport. Same class 0.2.44 stage A refused on the model-switch RPC (accepted is not completed) and 0.2.46 stage A refused on the MCP transport caption (a null client is not an agent that does not advertise). The fix keeps the never-rejects contract intact and publishes the fact alongside it: `lastSaveOk: boolean | null` on the plugin, written inside `savePluginData` after the try/catch (null means no save has finished yet; true means the write landed; false means it was swallowed into the sticky alarm). The save callback reads it and only paints "Setting saved" when it is true. No signature change to `savePluginData`, no new surface beyond one field — every existing fire-and-forget caller keeps working unchanged, and `save()` stays `Promise<void>` so its thirty-plus `.onChange` sites compile without touching them. Three boundary tests: one pins that a throwing outcome callback cannot relabel a landed write as a failure; one pins that `lastSaveOk = false` prevents the Notice while the field itself still takes the reader's value; one pins the happy path still confirms.
- **Auto-title raises the tabs-changed signal, so the strip sees the rename the store already made**: `renameSession` (`CoOberViewController.ts:2954`) fires `notifyTabsChanged` after every successful store rename+save, and its own comment says why — the tab strip's badge tooltip reads through `tabDescriptors()`, a snapshot only rebuilt when the controller raises that signal. `maybeAutoTitle` (`:2971`) writes into exactly that field, from a branch the reader reaches on the very first exchange: `sessionStore.rename(sid, deriveSessionTitle(userMsgs[0].content))` replaces the minted "Chat 21:00:00" with the question that started the session. It used to save and return in silence. The sessionDropdown, which reads `sessionStore.list()` live on every open, already showed the derived name; the tab strip, which only speaks through the signal, kept the timestamp. Two adjacent widgets, one screen, two names for the same session — the same family 0.2.42 stage B refused on the custom-agent rename, 0.2.43 stage A on the skill-rename, and 0.2.45 stage C on the delete handler. The fix pulls the notifyTabsChanged call into the successful-rename branch, next to the save. Two boundary tests drive `maybeAutoTitle` directly (rather than through `controller.send`, which fires `onTabsChanged` twice for its own reasons and would blur the assertion): the positive pins `seq === ['rename', 'save', 'tabs']` in the exact order the branch emits them; the negative drives a rename that returns false and pins `seq === ['rename']` — the guard must save nothing and signal nothing, or the strip repaints on a title the store never accepted.
- **The welcome badge stops spinning on a transport the retry loop has already abandoned**: `connectionStatus` (`welcomeView.ts:13-16`) sampled a two-value world — no client, or client present — and spoke the second as "Connecting…" whether the handshake was in flight, a retry was in flight, or `AcpClient.scheduleReconnect` had just fired `onReconnectFailed` and given up (`acp.ts:1480-1483`). The controller's handler paints "the agent could not be reached after repeated reconnect attempts" into the transcript; the badge, sitting a scroll away, kept reading "Connecting…" because `handleDisconnect` does not null the client and `connectionStatus` had no way to see the difference. The next auto-repaint (tab switch, `/new`, restoreSession, rewind) flipped the greeting back to the connecting reading on a screen whose transcript already said the retry loop was done. The sibling reconnect button (`CoOberView.ts:895-900`) already speaks the three-way split (`reconnect.text` / `reconnect.connecting` / `reconnect.failed`) through its own `reconnectFailed` field; a badge-side duplicate field would have had to be written from every entrypoint of a fact the transport is the sole observer of. The fix moves the fact to the transport: `AcpClient.isReconnectExhausted` publishes the exact predicate the scheduleReconnect loop already uses to stop, `OpencodeClient` carries it as an optional method (only a transport with a retry loop can answer, and a runtime that never reconnects has nothing to exhaust), and `connectionStatus` widens its input to accept the optional predicate. No new i18n: `welcome.disconnected` was already the correct word for "the transport is gone and nothing is being tried" — the badge just never had access to the fact that made it the right one. Six boundary tests: three on `connectionStatus` pin the exhausted branch (returns disconnected), the unexhausted branch (returns connecting — the fix must not call every down client abandoned), and the anti-remerge guard (the two drop classes must speak different strings); three on `AcpClient` pin `isReconnectExhausted` false on a live connection regardless of the counter (a defensive guard against a future edit that forgets to clear the counter on a fresh connect), true at the exact ceiling the scheduleReconnect loop hits, and false one attempt under.

## 0.2.46 - 2026-10-03

No new capabilities. This release answers three more faces of the same class of lie 0.2.42 through 0.2.45 refused on their own surfaces: a UI or wire claim that certifies a state the code has not observed. An MCP transport caption that said "this agent does not advertise" for a situation where no agent existed to advertise anything; three terminal handlers that raised one "not found" sentence for two kinds of absence the sibling `output` path had already split one release ago; and a diagnostics row that turned any non-empty folder into a PASS while the sync engine still rejected it as a shape it could not write.

### Changed

- **The MCP disabled-transport caption names whether anything was connected at all**: `addMcpServerBlock` (`settingBlocks.ts:170-193`) painted the "disabled" suffix on the http/sse transport headers by looking only at `agentSupports(kind)`. Under a live agent whose handshake never advertised the capability, the caption "this agent does not advertise it" was the truth. With no agent at all — pre-connect, post-disconnect, mid-failure — `agentSupports` returned false for the same reason every capability check returns false on a null client, and the same caption told the reader to look for a connected agent that does not advertise http, when the true situation was that no agent had connected to advertise anything. `dragDropManager.ts:142-147` and the paperclip tooltip at 0.2.42 stage E both refused this exact class by consulting `isConnected()` before the capability. The block now receives `agentConnected: boolean` as its 7th argument and picks between two suffix builders — the transport-specific "does not advertise it" on a live agent, a shared "no agent is connected" otherwise. New i18n keys `mcpTransportNoAgent` in en and zh (`尚未连接任何 Agent`), and the older `mcpHttpDisabled` / `mcpSseDisabled` were rewritten to name the agent, not the merged class ("this agent does not advertise it") so the two sentences stay distinguishable when a reader compares them. `settings.ts:838-842` computes `agentConnected = Boolean(client?.isConnected())` at the call site. Three boundary tests pin both cases and the anti-remerge guard that the two strings differ.
- **Terminal kill/release/wait_for_exit name which kind of absence the manager saw**: `terminalManager` already carried a `releasedIds` Set since 0.2.44 stage C and used it inside `output()` to split "released" from "unknown". The three handlers flanking it (`AcpRequestHandler.ts:627`, `:643`, `:667`) still raised the collapsed `Terminal not found: <id>` on any miss — so a reader who released term-3 and retried `kill` on term-3 saw the same sentence as an agent who hallucinated term-99. One case points at a lookup that will never resolve; the other invites a reader to search transcripts for a release that never happened. The fix exposes the split through one public string on the manager — `absentTerminalMessage(id)` returns `Terminal released: <id>` or `Terminal unknown: <id>` — and the three handlers call it instead of their own literal. Placing the format on the manager means the output path (which builds the same sentence in-band) and the handler paths (which raise it as a wire error) cannot drift into naming the two absences differently. Seven boundary tests: six pin each handler's released/unknown pair with a matched `not.toMatch` on the opposite class, one pins that `absentTerminalMessage` returns byte-for-byte what `output().error` returns.
- **The diagnostics sync-folder row runs the sync engine's own validator**: `settings.ts:786-790` asserted `ok: syncFolder.length > 0`. Any non-empty string — `notes/..`, `/abs/path`, `notes<>` — earned a "Pass" while `buildSyncNote` (`sync/templates.ts:70`) calls `sanitizeVaultPath` (`templates.ts:13`) on the very same folder and throws on every one of those shapes. The next tool-call sync failed silently with nothing on the panel to explain why. This is the same ruling the sibling path row at `settings.ts:1027` already makes in its own comment — "same resolver the spawn path uses, so diagnostics can never disagree with what actually launches" — applied to the folder shape. The row now calls `sanitizeVaultPath(syncFolder, 'probe.md') !== null` (a fixed legal filename isolates the folder check) and its detail picks between the existing `syncFolderMissing` (reader typed nothing) and a new `syncFolderInvalid` (reader typed something the writer will reject). Three boundary tests pin the invalid shape, assert the two failure sentences do not collapse into each other, and hold that a legal non-empty folder still passes with its name — the fix must not trade one lie for another by calling every typed folder a failure.

## 0.2.45 - 2026-10-03

No new capabilities. This release answers three more faces of the same class of lie 0.2.42, 0.2.43 and 0.2.44 refused elsewhere: a UI surface certifying a state the code has not observed. A plan panel that had authoritative evidence of emptiness and still showed yesterday's rows; a toolbar chip reading "No models" over an inventory the agent had never surveyed; and a Settings dropdown whose sibling pane had learned to move on its writes, but which had not learned to move on the sibling's.

### Changed

- **The plan panel paints a settled "no todos" as an empty panel**: `refreshNativePlan` (`CoOberViewController.ts:2332`) is the OpenCode-native resync that runs on session restore, rewind and after every completed turn; its own doc comment called the database the truth for the empty answer, and then threw the truth away on the paint — line 2339 cleared the stale caveat via `setPlanStale(false)`, line 2340 bailed on `if (todos.length === 0) return;` before touching the rows. The reader who watched a plan build up and typed a follow-up that closed the loop got the panel re-painted with the same rows, minus the "may be out of date" note that had been the only honest hedge on the surface, and the rows continued to stand as the current plan on a screen where the code had authoritative evidence to the contrary. The live wire path had already learned not to tell this lie — `streamController.ts:254` calls `renderer.setPlanEntries(ch.entries)` unconditionally including when the plan has zero entries, and `setPlanEntries` itself removes every prior `.plan-item` before re-adding. The fix collapses the last three lines of `refreshNativePlan` to `setPlanStale(false); setPlanEntries(todos);`, no branch on length, so a settled empty reaches the paint the same way a settled non-empty already did. `NativeSessionReader` returns `null` on a failed read and `[]` only on a read the database actually answered, and the caller now routes them through different branches (null → stale, empty → paint) instead of the previous collapse. This is the 0.2.42 stage C "loaded empty must render as empty, not as the last known state" ruling applied on its remaining surface.
- **The toolbar chip stops certifying an empty inventory on a session that had never been asked**: `InputToolbar`'s model label was constructed at `toolbar.ts:84` as `t().toolbar.noModels` — a completion claim about the agent's inventory — and stayed there while `modelLabelText()` read `this.modelOptions.length === 0` on an untouched empty array. That array's only writer is `updateModels(...)`, fired by the agent's config chunk through `streamController.ts:312-313`; `chatState.ts:18` initializes `availableModels = []`. A pane whose agent has never streamed a models chunk therefore kept the constructor's chip in place permanently. The 0.2.44 stage B slash fix had already refused the same shape on the transcript surface — `/model` with no arg printed `Available models:` over the same default-empty array — and ruled it as an observation-shaped "The agent has not reported any models for this session yet." Because the toolbar chip has less room than a transcript line, the same ruling arrives in three words: `No model yet` / `尚未获得模型`. The word `yet` makes the incompleteness part of the claim itself. A disconnect-withdrawn `updateModels([], undefined)` reads under the same provisional wording, which is honest for both cases — no model right now, and either state could change. `applyModelOperability` still withdraws `aria-haspopup`/`tabindex`/`role` on empty, so the disabled chip and its non-activatable sole row already told the reader nothing was chosen; the label now agrees with what the code sees.
- **A bar click that moves the permission tier moves the open Settings dropdown too**: `onPermissionChange` (`CoOberView.ts:338-356`) wrote `settings.permissionMode`, re-tiered the client, and swept the open chat leaves — the sibling-repaint completion 0.2.43 stage A added after realizing the settings dropdown's `refreshOpenViewsPermission` fanout had no reverse edge. The Settings panel itself stayed silent on a bar-side write: `renderAgentSection` built the Permission Mode `<select>` via `.addDropdown((d) => d.addOptions(...).setValue(s.permissionMode).onChange(...))` and the closure captured no reference to the component. A reader who opened Settings to pick the tier, clicked the chat bar's chip, saw it cycle to `readonly` and looked up at the same panel — that panel still said `safe`. Same shared field as the 0.2.43 gap, seen from the other side; that release fixed chat panes on a settings-side write, this one fixes the settings panel on a chat-side write, and completes the fanout to be genuinely two-sided on `settings.permissionMode`. `main.ts` now stores the tab instance on the plugin (`settingsTab: CoOberSettingsTab | null`), `CoOberSettingsTab` holds `permissionModeDropdown?: DropdownComponent` bound in the `.addDropdown` callback, and the bar handler reaches `this.plugin.settingsTab?.refreshPermissionDropdown()` after the existing leaf sweep. Optional chaining handles the pre-`onload` window and a plugin that never rendered Settings — the dropdown field stays undefined and the refresh is a no-op rather than a constructed panel the reader did not ask for.

## 0.2.44 - 2026-10-03

No new capabilities. This release answers three more faces of the same class of lie the 0.2.42 and 0.2.43 packs refused elsewhere: a UI surface certifying a state the code has not observed. A transcript line announcing a completed model switch on an RPC that had only been accepted, an "Available models:" header printed over a list the agent had never sent, and a card claiming "no longer available" for a terminal this client never held.

### Changed

- **The `/model` and `/mode` transcript stops claiming a completed switch**: `run` awaited `c.setModel` / `c.setMode` and, on resolution, printed `Switched to model: \`X\``. Resolution says the RPC was accepted; the current-model id is written only by the agent's own config chunks (`streamController.ts:306,312`), so a session that ignores or refuses the id left the toolbar naming the old model while the transcript had already announced the switch — the same "two adjacent widgets, incompatible stories" shape the 0.2.42 attach-tooltip and the 0.2.43 permission-chip fanout both refused. The system message re-words to `Asked the agent to switch to model:` / `已请求切换模型：`, claiming only what the RPC resolution supports. Second half: the dispatch path at `CoOberViewController.ts:2502` (`await def.run(...)`) has no try/catch on the caller side, so a rejected RPC left the transcript silent — the reader typed `/model X` and got no switch, no failure, no line at all. Each handler now wraps its RPC and routes the error's message into a new `modelSwitchFailed` / `modeSwitchFailed` system line, so a dead transport reads as a refused request rather than as a keystroke that did nothing.
- **`/model` and `/mode` stop announcing a survey the agent never sent**: the no-arg branches printed `${availableModels}\n${rt.state.availableModels.map(...).join('\n')}`, and when `availableModels` was `[]` — the default until the agent's config chunk writes it — the transcript read "Available models:" over nothing. That certified a completed survey with a zero result, but nothing had been surveyed; the array's only writer is the agent's chunk at `streamController.ts:306,312`. `availableModels.length === 0` is now its own branch and speaks `slash.noModelsReported` ("The agent has not reported any models for this session yet." / "Agent 尚未上报本会话可用的模型。") — a claim about what Co-Ober has observed, not about what the agent has. Once a chunk arrives the list prints in exactly the previous format, so a working session shows what it always showed. `noModesReported` mirrors on the mode side, in en and zh.
- **A card for a never-created terminal stops asserting someone released it**: `TerminalManager.output(id)` returned the same `Terminal not found` error for an id the manager had actually released and an id it had never held at all (a typo, a stale cross-session id, a hallucination), and `terminalContentFrom` folded both into `tool.terminalGone` — "This terminal is no longer available." The phrase "no longer" presupposes a prior present: for a never-created id, none of that is true, and the sentence pointed a reader at a release they might investigate when the situation is that no such terminal ever lived here. That is the same shape the 0.2.42 stage D absent-vs-unread note fix refused on `[[Old Name]]`. `TerminalOutputResult` gains an optional `errorReason: 'unknown' | 'released'`; `TerminalManager` records ids it actually created and later dropped in a `releasedIds` set, and `create()`'s spawn-failure rollback deliberately does not mark an id it never handed out. `terminalContentFrom` reads the reason and picks between a new `tool.terminalUnknown` ("Co-Ober has no record of this terminal." / "Co-Ober 没有该终端的任何记录。") and the existing `terminalGone`; the released reading keeps the old wording because it is the true sentence for that situation. `AcpRequestHandler.handleTerminalOutput` propagates the reason-tagged error string to the agent over the wire, so `terminal/output` errors now say `Terminal unknown: term-404` instead of `Terminal not found: term-404`.

## 0.2.43 - 2026-10-03

No new capabilities. This release answers three more faces of the same class of lie 0.2.42 refused elsewhere: a UI surface certifying a state the record underneath it does not hold. A permission tier changed on one bar that the other open pane kept naming under the old label, a settings runtime open that read a survey-never-taken as an empty survey, and a diagnostics runtime query that folded its own rejection into the same zeros a settled empty produces.

### Changed

- **A permission change on one bar repaints every open pane**: `CoOberView.ts` `onPermissionChange` wrote `settings.permissionMode`, saved, and forwarded the tier to the client — but only the pane whose bar received the click saw the new label. Every other `VIEW_TYPE` leaf kept its toolbar on the tier that had just died, while the requests those panes made were already being handled under the new one. Same shape as the 0.2.42 rename-repaint family, on the last mutator of a shared field that had been left without a fanout. After the save, `onPermissionChange` now iterates `workspace.getLeavesOfType(VIEW_TYPE)` and calls each sibling's `refreshPermissionMode()`. The loop runs after the settings write so a reader watching a sibling sees the tier they just picked, never the one before.
- **A settings runtime open never surveyed no longer reads as empty**: `renderCustomSkillsSection` (:319) and `renderCommonModelsSection` (:371) sampled the three loading/unavailable/loaded flags introduced by 0.2.42 stage C, then fell through to an `availableSkills.length === 0` / `availableModels.length === 0` guard that painted "No runtime skills loaded" / "No models loaded". On a plain open — the reader selects Settings, `display()` calls `render()`, and none of the three flags is armed — the first two branches both skip and the third certifies emptiness. `getAvailableSkills` (:822) falls back to `client.getSessionSnapshot().availableCommands`, and that snapshot is empty until a session has been created; the panel was reading "no session, no fallback rows" as "no runtime skills". The guard now routes `!loaded && (unavailable || length === 0)` into the "unavailable" reading, so a fetch that was refused and a fetch that was never asked for both say the panel cannot certify the runtime; the loadedEmpty wording still reserves itself for `loaded && length === 0`, so a completed empty read remains the settled measurement it should be. No fetch is fired on plain open — the reader keeps control of when the runtime is surveyed.
- **A diagnostics runtime query that could not answer is not zero**: `getRuntimeMetadataCounts` folded each `getAvailable*` rejection into `[]` inside its own `Promise.all` (`.catch(() => [])`), so the diagnostics row interpolated `{modes}/{models}/{commands}` out of those swallowed empties and printed "0 agents, 0 models, 0 commands" for a stream that died mid-read as though the agent had confirmed having nothing to say. 0.2.20 had introduced `runtimeNotQueried` for the never-connected branch, but the ask-then-rejected branch stayed routed into the same settled zeros. The method now returns `{ ok: true, counts } | { ok: false }`, and the row names the failure as its own reading with a new `diagnostics.runtimeUnavailable` line ("Query failed — the runtime lists could not be read" / 查询失败 — 运行时列表未能读取) in en and zh. A connected agent that truly reports no runtime data still reads as the honest "0 agents, 0 models, 0 commands".



No new capabilities. This release answers five faces of the same class of lie the 0.2.40 and 0.2.41 packs already learned to refuse elsewhere in the codebase: a UI surface certifying a state the record underneath it does not hold. A rename that saves while its sibling control keeps showing the value that just died, an unmeasured fetch that reads as an empty survey, a note that has gone which the reporter insists could not be *read*, and a paperclip that announces an image-incapable agent over a plain disconnect — none of these move a byte a reader could call a new feature, they move only the surfaces that had been asserting something the code never observed.

### Changed

- **Renaming a session repaints the tab strip**: `renameSession` wrote the new title through `sessionStore.rename` and awaited the save, but the strip's tooltip reads `tab.title` from a `tabDescriptors()` snapshot that rebuilds only when the controller raises the `onTabsChanged` signal. After an inline rename, the badge above the reader's finger went on naming the conversation by the title that had just died — the same silent stale-sibling the delete and queue handlers were cured of last release, on the lone mutator of the same field that had been left without the signal. A successful rename now calls `notifyTabsChanged()`; a blank title or an unknown session returns without touching the strip.
- **Renaming a custom-agent id repaints the active-agent dropdown**: `settingBlocks.ts:384` rewrote `agent.id` (and `settings.activeCustomAgentId` when it held that agent) and repainted only the row header. The "Active custom agent" dropdown above was built once from the pre-rename options map, so its guarded `d.setValue` saw a mismatch between the new stored id and the older option keys and answered "Nothing is in force" — a panel claiming no agent was active while the settings file underneath already held the new id. The delete handler and the skill-rename twin both reach for `render()` on the same container for exactly this reason; the agent id rename now does the same.
- **A settings runtime fetch that dies reads as "unavailable", not "no models"**: `loadRuntimeOptions` awaited a `Promise.all` inside a `try`/`finally` with no `catch`, so a rejected fetch reset `runtimeOptionsLoading = false` while `runtimeOptionsLoaded` stayed false, and the next panel repaint fell through to the empty-list branches (`"No runtime skills loaded"`, `"No models loaded"`) — a settled reading for a question the fetch never answered. `nativeLoadError` in the session dropdown had already been fixed for the same collapse last release; this is its settings twin. A third flag `runtimeOptionsUnavailable` is now set both by the `catch` and by the not-connected path, both guard branches sample all three states, and the render is scheduled in the `finally` so the loading flip and the failure flip reach the screen together. Two new locale keys (`customSkills.loadedUnavailable`, `commonModels.unavailable`) speak the new state in en and zh; an empty-but-successful fetch still reads as the honest "No runtime skills loaded".
- **A note reference whose file is gone is named as gone**: `ContextResolver.resolveNote` returned `null` for two distinct failures — the vault had no `TFile` at that path, and the read threw — and `buildParts` funneled both into the same unread bucket, so a renamed or deleted note was reported as *"could not be read"*. That told the reader to chase an I/O error that did not exist when the true fix was one chip-removal away. `FileCommandStorage.reportSkipped` had already split unreadable/shapeless/ambiguous into three classes for command files; the note path's null return had no way to carry the distinction to begin with. The return type is now a discriminated union `{ ok: true, name, content } | { ok: false, reason: 'missing' | 'unreadable' }`, `buildParts` keeps two parallel buckets, and the reader sees `refsMissing` ("no longer exists") for the file that left and `refsUnread` for the file that would not open. `resolveAll`'s happy-path contract is unchanged, so nothing a downstream caller relied on moved.
- **The attach tooltip splits no-agent from no-image-capability**: `setImageAttachEnabled(false)` painted one tooltip — "no image-capable agent is connected" — over both a live agent that had not promised images and no agent at all (disconnect, and the never-connected tab's `loadToolbarOptions`). The sentence presupposes the connection it reports missing, and it sat directly above a drop zone that had already learned to refuse that form: `dragDropManager` splits `imageNoAgent` from `imageNotSupported` with an `isConnected()` check above the capability check, so a reader dragging a PNG into a never-connected pane got "Connect an agent before attaching images" from the notice and "no image-capable agent is connected" from the paperclip beside it. Two reasons — `'unsupported' | 'no-agent'` — now travel into `setImageAttachEnabled`, the toolbar stores the current reason, and both `refreshLocale` and set-time pick the tooltip from that state, so a language switch does not collapse the no-agent wording back to the unsupported one. CoOberViewController names `'no-agent'` on both disconnect paths and `'unsupported'` on the capability-gated path (where a client is present by construction, because the no-client branch returned above). A new `toolbar.attachImageNoAgent` key speaks the split in en and zh; `toolbar.attachImageUnsupported` was rewritten in both locales to name the actual negotiation ("this agent does not accept image prompts").

## 0.2.41 - 2026-10-01

No new capabilities. This release answers the marketplace review's warning-and-recommendation pass on 0.2.40: it strips type-annotation noise the compiler was already ignoring, gives the failure paths that were silent a voice, keeps timers and DOM handles inside the window the reader is actually in, folds every raw `document.createElement` behind Obsidian's own element helpers, and retires the deprecated zod, keyboard and Markdown-renderer calls the reviewer named. Nothing the reader sees in the transcript, toolbar, or settings moved — same bytes on screen, only the calls that produce them changed shape.

### Changed

- **Type-annotation noise comes out, and a widened union narrows back**: nine "unnecessary assertion" and three "literal overridden by string" warnings all traced to the same shape of lie — a cast that said nothing TypeScript had not already proven (`parsed.frontmatter['x'] as object`, `data as AcpResponse`, `String(e.foundVersion) as string`), or a union `'pending' | 'in_progress' | 'completed' | string` that had silently widened to plain `string`, so the three literals were decoration the compiler was told to ignore. Every receiver on the assertion sites already accepted the pre-cast shape, so removing them restores tsc's authority over those positions and stays silent. `NativeSessionReader`'s `Todo.status` keeps its three names through the `(string & {})` idiom so autocomplete still offers them while arbitrary wire values still fall through, which is what the reader already did with an unknown status.
- **Failures that used to disappear now say something**: four sites dropped a Promise on the floor — `CommandRegistry.reload` fired `.then(...)` with no rejection handler and called its own reload callback without awaiting, so a source that died between watch-registration and its first read kept its failure to itself and the menu went on showing the previous defs as though nothing had changed; `renderer.ts` dropped `MarkdownRenderer.renderMarkdown(...)` and one `this.scheduleTextRender()` without marking either. Both registry sites now `void` with a matching `.catch`, and two tests hold the shape: a resolving async source ingests into the menu, and a rejecting one writes a `console.error` naming the underlying failure. Two `JSON.parse` returns bound an `any` under a name the next lines trusted as `unknown[]`/`T`; the `SqliteReader` parse now annotates `unknown` and lets its `Array.isArray` narrow honestly, and `clone.ts` returns `as T`, so the function's own contract stops being an `any` escape hatch.
- **A plugin in a popout window keeps its timers and its lightbox in that popout**: Obsidian 1.4+ lets a leaf tear out into its own `BrowserWindow`, with its own DOM and timer queue. Bare `setTimeout`/`setInterval`/`clearTimeout`/`clearInterval` resolve to the realm the code's closure was made in, and `globalThis.document` resolves to the primary vault's document, so in a popout an interval ticks in the main window while the popout freezes; a lightbox's Escape listener attaches to the wrong document; a SIGKILL timeout for a runaway sqlite child queues against a window that has already closed. Every timer and document site the reviewer flagged — SqliteReader's spawn-time kill, mutex's acquire timeout, thinkingBlockRenderer's live-elapsed and dot-cycle intervals (with their state fields losing the `NodeJS.Timeout`-flavored `ReturnType<typeof setInterval>` typing that browser `window.clearInterval` refuses), and imagePreview's `globalThis.document` pair — now names its window explicitly, so the popout's world serves the popout's reader.
- **Every DOM node comes from the same helper**: eighteen sites reached for `document.createElement`/`createElementNS` and then shaped the bare node with `.className =`, `.setAttribute`, `.appendChild` — the same plumbing `createEl`/`createDiv`/`createSpan`/`createSvg` perform in one option-object call. The arc meter in `CoOberView` was the largest block (six `createElementNS` chained through `appendChild` to build `<svg><path/><defs><clipPath><rect/></clipPath></defs><circle/></svg>`) and now reads as six `createSvg` calls, four of which chain through their parent so append order is stated by structure rather than comment; the image-picker input, the autocomplete dropdown, the turn-collapse group, the two copy buttons, the two markdown placeholders, and imagePreview's overlay-with-`<img>` fold the same way. Nothing on screen moved — same tags, same classes, same attributes, same parent order — only the calls that build them changed. Obsidian's helper functions live at global scope in the plugin's ambient types, so no import changed; `src/test/domHelpers.ts` grew matching globals (`createEl`/`createDiv`/`createSpan`/`createSvg`, and an `Element.prototype.createSvg` for the chained SVG calls) so the same code resolves under jsdom.
- **Deprecated API calls step to the modern ones beside them**: `zod`'s `.passthrough()` is a deprecation marker in v4 for what `z.looseObject` now says directly, and three permission/elicitation schemas plus the session-list parser wore the old form while every strict sibling already used `.object()`; they move together. `acpSchemas.ts`'s `zOpt` helper carried `<T extends z.ZodTypeAny>`, a type alias no longer re-exported under that name in v4 — the same chain resolves against `z.ZodType` unchanged. IME detection still read `e.keyCode === 229`, a `KeyboardEvent` property the web standard deprecated; Obsidian's Electron runtime has answered composition with `e.key === 'Process'` since Chromium's IME spec landed, and `ime.test.ts` re-speaks its two legacy-engine cases in the modern form. `MarkdownRenderer.renderMarkdown` was three of four call sites already behind the newer `MarkdownRenderer.render(app, md, el, sourcePath, component)`; the fourth (`addSystemMessage`) still passed the old arg order, so `src/test/obsidianMock.ts` grew a matching `render` and the swapped path is exercised. `FileCommandStorage`'s `?? parsed.frontmatter['argument-hint']` fallback read a hyphenated key `FrontmatterParser.normalizeField` had already mirrored onto `argumentHint` two lines earlier, so the second lookup saw the same value from a spelling the reviewer's rule flags; it comes out, and the comment names the parser's mirror.

## 0.2.40 - 2026-10-01

No new capabilities. This release repaints the agent rows that still name a skill after it is renamed, stops a generic config chip from presenting an unreported value as a chosen one, and lets a tool card's "N more lines" footer switch language with the rest of the card.

### Changed

- **Renaming a skill updates the agents that use it**: `renameCustomSkill` rewrote every agent's `skillIds` in the settings, and the renamed row repainted its own title, but the *sibling* agent blocks paint their "Skill IDs" box from `agent.skillIds` only when they are built or edited themselves. So after a rename each agent row went on displaying the retired id — a reference `validateCustomAgent` calls an Unknown skill reference — while the record already held the new one. The delete handler repaints the whole list for exactly this reason (`render()` after pruning the id from those same arrays); the rename was the lone editor that mutated shared ids without it. A successful rename now calls the same in-scope `render()`, re-feeding every dependent box from the settings that already hold the truth; a rejected rename still reverts the field and leaves the siblings untouched.
- **A config option with no reported value reads "unset", not a blank choice**: `projectGenericConfigOptions` built a generic toolbar chip's value with `String(opt.currentValue)` and `configValueLabel` fell through to that raw value when nothing matched it, so a select whose `currentValue` was absent (coerced to `''`) painted `Reasoning: ` — an empty string beside the name, shown as the agent's current selection — and a boolean toggle's `true` became the literal id `"true"`, naming a choice the option list never offers. The model and effort selectors already read that same field through `selectValueOf` (a string only when one truly is current, nothing for a boolean) and answer an unconfirmed value with the word `unset`; the chip simply never consulted the rule its siblings honor. The projection now routes through `selectValueOf`, and the label says `unset` where nothing was reported — while a genuine non-empty current the list omits is still named, the model selector's own exception for a value actually in force.
- **A tool card's truncation footer changes language with the card**: `renderLinesExpanded` and `renderSearchExpanded` hand `refreshLocale` their count as a `data-i18n-count` element, so it re-speaks on a locale switch; `renderTruncatedText` appended the same "... N more lines" straight into a block's `textContent`, and `refreshLocale` only walks tagged elements. The tool with no dedicated renderer, a JSON dump, and a bash stderr all used that string form, so after switching languages the card body turned while its footer stayed in the language it first drew in. The truncation decision is pulled into a shared helper that both the (still-tested) string form and a new container form use, and the container form emits the footer as a `data-i18n-count` element exactly as its siblings do, at all four call sites — the count line is now re-speakable and nothing else the reader saw moved.

## 0.2.39 - 2026-10-01

No new capabilities. This release stops the session dropdown from calling an unreadable OpenCode database an empty history, keeps two settings row titles current with the field they name, and reloads an unsupported-content placeholder as the system note it is rather than an assistant reply.

### Changed

- **An unreadable native database no longer reads as "no sessions"**: `listNativeSessions` swallowed two distinct failures into `[]` — a `querySqliteJson` throw was logged and returned empty, and an unrecognized/incompatible schema returned empty before asking anything. But `[]` is a *reading* ("these are all the sessions: none"), and the dropdown trusts it absolutely: it has a dedicated failure row (`.catch` sets `nativeLoadError`, renders "Native sessions unavailable (see console)", and suppresses the "No sessions found" line while that flag is set) that was unreachable precisely because the loader never rejected. A locked, corrupted, sqlite-less, or newer-schema database resolved happily to `[]` and the panel certified an empty history it had not read. This is the same lie the content search was fixed for last release, on the list read whose caller can in fact tell failure from empty. Now a missing database still resolves to `[]` (genuinely nothing to list) while an unopenable database or unreadable schema rejects; usage and todos keep degrading to their sentinels, which have no such failure surface and correctly keep the reader's prior figures.
- **A renamed server or reswitched rule updates its own title**: the MCP server row ("MCP: `<name>`") and the sync-rule row ("Rule: `<tool>`") derived their bold header from exactly the field their editor edits — the name text and the tool dropdown — but neither captured the header, and the block only repaints on a type change (MCP) or delete, never on these edits. A reader who renamed a server or switched a rule's tool kept looking at the old title over the value they had just saved. The custom-agent and custom-skill blocks were cured of the identical defect last month by a `paintHeading()` that re-speaks the same template from the live definition; these two were the holdouts. They now capture their header and repaint on the one edit that changes it, reusing the existing template and the field the code already mutates — so a blank server given its first name even leaves the "unnamed" fallback.
- **An unsupported-content placeholder reloads as a system note**: when a content part arrived the transcript cannot paint (audio, a resource link, any non-text/non-image frame), the client drew an honest "[X content — cannot be shown here]" line through `addSystemMessage` but persisted it with `saveMessage('assistant', …)`. That stored role is all a closed panel has to go on: `paintTranscript` branches on it, so a reload painted the plugin's own protocol complaint as an assistant bubble and the transcript export labelled it "Assistant" — re-attributing to the model a sentence it never emitted. `persistSystemNote` (which writes `role: 'system'`, the shape `paintTranscript` and export already route back to a system line) is what the compaction case beside it already calls; `saveMessage` cannot even express it, since its role is typed `'user' | 'assistant'`. The note now persists the way it renders, so a reopened or exported session shows the decoding gap exactly as the live panel did.

## 0.2.38 - 2026-10-01

No new capabilities. This release stops a permission prompt titled "Permission: undefined" for a minimal agent request, refuses to report a native content search that could not run as "no matches", and re-syncs the tab strip's queued badge when the queue changes underneath it.

### Changed

- **A minimal permission prompt is titled by what it is, not "undefined"**: the banner composed its line as `t().permission.title.replace('{title}', req.toolCall.title || req.toolCall.kind)` — but an agent may send a permission request carrying neither a title nor a kind, and the schema's `.optional().catch('other')` only defaults a *present-but-bad* value; when the key is simply absent the accessor yields `undefined`, and the `|| ` fallback handed that `undefined` straight to the substitution, so the prompt read "Permission: undefined" beside its own Yes/No buttons. The fallback was meant to name the request type when no title arrived; the honest reading of "no title, no kind" is not a missing value but the same `'other'` the runtime already resolves to. The handler now reuses the `kind` local it had just computed (already defaulted to `'other'` two lines above), so a titleless request is titled "Permission: other" — a real label drawn from the request's own shape — while a titled prompt stays untouched.
- **A native search that could not run no longer claims the vault came back empty**: `searchNativeSessions` first resolves the OpenCode database's read format, and on an unrecognized or unreadable schema every other native read (listing, usage, todos) degrades to empty — a settled "there is nothing here". But content search is a *query*, and the empty the other paths return means something different for one: an empty result is the answer "no session matches this text", a claim about the content of sessions the code did not read. When `resolveNativeReadFormat` returned nothing, search returned `[]` too, so a caller — and the "No sessions found" empty row it drives — certified that the vault holds no match, over a database whose schema was never opened. The failure is already surfaced for the paths where it can be thrown; the search now rejects the same way (`native session search unavailable: unrecognized OpenCode database schema`) instead of reporting a reading it did not measure, while the genuinely-empty cases — a blank query, no database — still return their true zero.
- **The tab strip re-samples the queue when it changes under it**: `is-queued` and the "has messages waiting to send" / "generating, more queued" titles are painted straight off `tabDescriptors().queued`, a snapshot of `promptQueue.length > 0` re-taken only when `notifyTabsChanged` fires the strip rebuild. Both push sites (busy, and the shared stream budget held by another tab) and the `×` remove button changed the queue's size while repainting only the local indicator — never raising that signal — so a follow-up queued over a busy tab (or parked for a slot) left an idle badge on a tab with a message genuinely waiting, and crossing out the last queued prompt left the badge and its waiting-to-send title asserting one still existed. Every other transition honors the contract; these queue mutations did not. They now call the existing `notifyTabsChanged()` unconditionally, so a background tab's badge re-syncs too; drain shifts self-heal through the busy transition that already notifies.

## 0.2.37 - 2026-10-01

No new capabilities. This release makes a resumed transcript show its compaction boundary as the system note the live path already writes it as, stops a created file's diff counting a line that was never added, and withdraws a "Drop to attach" promise from drags the drop zone cannot take.

### Changed

- **A resumed compaction boundary reloads as a system note, not an agent turn**: the live path persists the "— Context compacted by the agent —" line through `persistSystemNote`, which files it under `role: 'system'` so `paintTranscript` and the transcript export read it as a note rather than a reply. The replay collector that rebuilds a transcript when a `session/load` or resume lands hardcoded that same boundary's bucket to `role: 'assistant'`. So the identical event looked different only by whether you were watching it happen or returning to it: live a system note, on reload an assistant bubble claiming the agent had produced that line as its own reply, and an export filed under "Assistant". `SerializedMessage.role` already admits `'system'` and the renderer already branches on it, so the replay now writes the same role the running path earned — a resumed conversation shows the boundary exactly as the live one did.
- **A created file's diff no longer counts a phantom line**: `splitForDiff` collapsed only the wholly-empty string to no lines, but a closing newline is a terminator, not a further line — `'a\nb\n'.split('\n')` leaves an empty final segment, and both the `+N` badge and the diff body counted it. File creation is the common case and created files end in a newline, so a two-line file was billed "+3" and drew a blank `+` row for a line the Write tool never emitted, and edits that only added or dropped the trailing newline reported a `+1`/`-1` that does not exist. Everywhere else the repo pops that trailing empty segment as the "ghost" it names it (`renderLinesExpanded`, `truncateLines`); `splitForDiff` was the lone holdout. It now drops the single trailing empty segment the same way, so the badge and body count only real lines — while a blank line in the middle of a body stays genuine content and still renders its placeholder.
- **The drop zone stops offering to attach what it cannot take**: on any `dragover` the handler set the copy cursor and raised the "Drop to attach" overlay, but the drop path reads only `dataTransfer.files` — a text selection or a link flashed the same promise and then did nothing, with no refusal line the way every real file rejection carries. The control advertised a capability the drop path does not hold. The truth rides the event it is already handed: `dataTransfer.types` names what the drag offers, and `'Files'` is the one this zone serves, so the overlay and cursor now appear for file drags alone and every other drag gets a `none` cursor and no promise. Real file drops are untouched — this withdraws a claim, not a feature.

## 0.2.36 - 2026-10-01

No new capabilities. This release re-labels a system boundary that reloaded as an assistant message, withdraws a "No sessions found" that contradicted the failure line printed above it, and stops a disabled delete `×` from blaming a close capability its action never consults.

### Changed

- **A compaction boundary reloads as the system event it is**: the compaction case rendered its line through `addSystemMessage` — the same channel the stop-reason badge and every meta note use — but persisted it with `saveMessage('assistant', …)`, the call reserved for real assistant output. That stored role is all a closed panel has to go on: `paintTranscript` branches on it, so a reload painted "— Context compacted by the agent —" through `appendText` as an assistant bubble, and the transcript export labelled the whole block "Assistant" under `ROLE_LABELS.assistant`. A reader who exported the session or reopened the tab saw a line the running panel had drawn as a system event re-attributed to the assistant — the wrong source. The store already carries the honest shape: `persistSystemNote` appends `role: 'system'`, and `paintTranscript` and export already route `'system'` back to `addSystemMessage` and the "System" label, so the boundary now reloads and exports exactly as it lived.
- **"No sessions found" no longer stands under a failed lookup**: the empty line already held back while native sessions were loading or still pending, so a spinner was never mistaken for a settled zero. But two fields beside that pending state carry a worse fact — a native list that rejected (`nativeLoadError` → "Native sessions unavailable") and a content search that threw (`contentSearchFailed` → "Content search failed") — each of which renders its own failure row and returns zero rows. The empty-row guard keyed only on rows and the pending flags, so with no local match the dropdown read "Native sessions unavailable (see console)" directly above "No sessions found": the same lie the content-error row was added to stop, now wearing the whole-panel badge — asserting the list came back empty when the line above it had just said it could not be determined. Both fields already exist on the class, so the guard consults them too; the genuinely-empty settled cases stay untouched.
- **A disabled delete `×` stops blaming a close capability it never uses**: the control was gated on `capabilities?.close === true` and, greyed, titled "no close-capable agent is connected" — but `deleteSession` is purely local (`sessionStore.remove` + `save`, then closing the tab if one holds the session) and never touches the client or `sessionCapabilities.close`, so a saved row lost its delete over an excuse naming a capability the operation was never asked to have. The pin and rename beside it had already gated on store presence (`setPinned`/`rename` silently refuse an id the store does not hold), and delete shares that exact precondition (`remove` is a no-op on a placeholder row), so the `×` now reads the same store-presence boolean and states the honest reason — "not saved to history yet, so it cannot be deleted".

## 0.2.35 - 2026-10-01

No new capabilities. This release closes a paperclip that offered an attach no agent was there to take, a sync note that read only the first result slot and so reported a tool's text as nothing, and a settings row that renamed its fields while its own title stayed behind.

### Changed

- **A never-connected pane withdraws its attach button**: a view that had not yet connected ran neither `handleDisconnect` nor a capability handshake, so its "Attach image" paperclip stayed in the enabled state the toolbar draws at construction — while the same view's drop/paste gate already turns an image away for want of a connection, and `loadToolbarOptions` is the one call every open and tab-switch makes. A live button sat directly above a gate that refuses exactly what it advertises, so clicking it opened a picker whose picked file the send path then discards. The button now agrees with the gate it sits above: `loadToolbarOptions`, finding no client to read a session snapshot from, withdraws the attach control before returning, reusing the `setImageAttachEnabled(false)` that already runs on disconnect rather than adding new state; the greyed title reads "no image-capable agent is connected", true whether the agent never promised images or there is none at all. Two tests pin the corrected contract — the control is withdrawn, and session options are still not loaded from a snapshot that does not exist.
- **The sync note takes the tool's text from wherever it sits**: the transcript card scans the whole content list for the text block the agent sent, but the same completed call reached the sync pipeline through `contents[0]`, so a tool that answers with an image, diff or unsupported block before its text handed sync an empty `content`. `getSyncBody` then fell past the empty string to `rawOutput` — a machine field, not the human result — or, with neither, to "(no output)": a note claiming the tool returned nothing for a call whose readable result the card shows on the same screen. The fix takes the first text block wherever it sits, the exact selection the renderer already makes, so the note is drawn from the same source the transcript is; a regression drives an image-then-text result and asserts the sync context carries the text, not the empty string the old slot-0 read produced.
- **A renamed settings row renames its own title**: each custom agent and skill block opens with a `<strong>` header naming the entry (name, falling back to id), but the name and id inputs wrote their new value into the definition and saved without touching that header — and the row is never repainted (`render` runs only on the enabled toggle and delete), so a reader who renamed an entry kept looking at the old title over the fields they had just changed, for the rest of the session. The header asserted a name the record no longer held. The block now captures its header and re-speaks the same label template from the live definition on the two edits that can change it — a name keystroke and a successful id rename — while a rejected id rename leaves the title matching the untouched id; five tests drive the real text inputs and assert the title follows a name edit and a successful id edit and does not follow a refused one, on both blocks.

## 0.2.34 - 2026-10-01

No new capabilities. This release retires a rename pencil that blamed an agent capability that has never existed, an error line that turned a bare JSON-RPC code into a request the agent was accused of lacking, and a diagnostics row that said "Resolved" and then echoed the query instead of the path it found.

### Changed

- **A disabled rename pencil stops blaming an agent capability that has never existed**: the session row gated the pencil on `capabilities?.list !== false` and, when greyed, titled "Rename is not supported by this OpenCode agent" — but renaming is a purely local write (`sessionStore.rename` answers false for an id it does not hold, and `sessionCapabilities` lists only close/fork/list/resume), so the tooltip named a capability the agent was never asked to have, while an agent that *could* list yet happened to render a row the store does not hold still showed a live pencil for a rename that would silently do nothing. The pin beside it had already taken this stance — its gate is store presence, not a borrowed "agent does not support it" excuse, which would only trade one invented cause for another — and rename shares the exact same store-presence precondition, so the pencil now reads the same `pinnable` boolean and its disabled line mirrors the pin's honest reason ("the conversation is not saved to history yet, so it cannot be renamed"); two tests pin both halves, the placeholder row left disabled with that reason and a real saved conversation keeping a live pencil even while the agent cannot enumerate the rest.
- **A bare JSON-RPC code stops becoming a request the agent lacks**: `humanizeError`'s `-32601` guard already caught the stock "Method not found" prose and the transport's "Unknown error" sentinel, but an error that reaches us as only the code echoed back — `-32601:`, colon-bearing so `CODE_PREFIX` matches it with nothing after — is non-empty and spaceless, so it slipped past and was quoted as a method name: "the agent does not support \"-32601:\"", charging it with ignoring a request literally named after the failure it just reported. A real JSON-RPC method never reads like a code, so the guard now also rejects any bare `-3\d{4}` token and routes it through the generic error line, which keeps the code visible behind a label that invents no request (the `-32603` internal echo already sits behind such a label, so it is untouched); a test drives `-32601:` and asserts it reads the generic line, not "does not support", while a genuine spaceless method name still reaches the specific one.
- **The "Resolved" path row names the path, not the query**: `getOpencodePathStatus` runs the same resolver the spawn path uses, so diagnostics can never disagree with what actually launches — yet it interpolated the raw input into its `Resolved "{path}"` detail, so the default bare command printed `Resolved "opencode"` and withheld the absolute target the resolver landed on (the `~/.opencode/bin`, `/opt/homebrew/bin` PATH gap the row exists to surface, and exactly the value `getSpawnInfo` hands to exec). "Resolved X" promises to reveal what X resolved to, so echoing X back named the query and hid the answer; the detail now shows the resolution it claims to report, while the not-found branch keeps echoing the input — right, since a command nothing found has no target to show. A test resolves `opencode` to a distinct absolute path and asserts the Pass row names that path, not the query.

## 0.2.33 - 2026-09-30

No new capabilities. This release withdraws a "Pass" the diagnostics panel awarded without running the check, an edited question that painted itself into the transcript before the rewind had agreed to it, and an Ask that ate the draft it could not send.

### Changed

- **The MCP row stops claiming a Pass it never earned**: the diagnostics panel hardcoded `ok:true` for MCP servers and only ever counted how many were configured, so `addDiagnosticsBlock` printed "Pass: MCP servers" beside a connection row that had just failed, and kept the badge even when an enabled server named nothing to launch — a stdio entry with an empty `command`, or an http/sse entry with an empty `url`, can never start. "Pass" says a check succeeded; no check ran, so the word asserted a state the code does not hold. The row now reads the truth already reachable from the settings it holds: a Pass means every enabled server supplies its own launch target, and an enabled server missing one drops the badge to Fail. The counts are unchanged and still reported, so a Fail points at the row without inventing a probe, and a config with no enabled servers stays a Pass because there is nothing broken to claim otherwise.
- **Edit-and-resend no longer shows a question the rewind refused**: the submit handler wrote the new text straight into the message bubble and only then called `onEditResend`, but `rewindUserTurn` can refuse for reasons the renderer cannot see — the turn is busy, the session or its index is gone, or the fresh agent session failed to renew — and every one of those returns after the DOM was already rewritten, leaving the panel displaying the changed question as the one that was asked while the store still holds the original. On the path that succeeds the write was never needed: the rewind wipes the transcript, repaints it from the store, and re-sends the edited text as a fresh turn. The premature write is redundant when the rewind works and a falsehood when it does not, so it comes out — the stored bubble stays exactly as the record has it and only a rewind that actually succeeds changes what the conversation shows, while the edit itself still reaches the handler.
- **A refused side-chat Ask keeps its draft**: `submitFromInput` cleared the text box and then called `send()`, but `send` declines while a side turn is in flight or the main conversation is busy, drawing a "wait until the current response finishes" line and sending nothing. The enabled Ask button and Enter promise a send; when it is refused the panel says so, yet it had already wiped the box, so the reader was told to wait and left with nothing to retry — the draft lost to a control that consumed input it could not act on. An affordance that takes what it cannot use is the lie, so the box is emptied only on the path that proceeds (the same guards `send` reads, checked up front); a refused Ask keeps its draft and still shows why it waited.

## 0.2.32 - 2026-09-30

No new capabilities. This release retires a queued-tab badge that promised a stream slot the disconnected agent could not grant, a diagnostics row that printed a settled zero for a question it never asked, and a side-chat bubble that sat frozen in its first language while the panel around it translated.

### Changed

- **The queued-tab badge stops promising a slot that is gone**: the strip paints "tab {index} is waiting for a stream slot" for any tab whose prompt queue is non-empty, and a disconnect deliberately keeps those queues — reconnect is the only thing that releases them — then repaints. The moment the transport dropped the badge went on naming a shared stream budget that no longer existed: there is no slot for a dead connection to grant, and the drain loop will not run until the agent returns, so the reader was told their prompt waited on a resource nothing was holding. Telling a live-but-busy tab from a disconnected one would need a new connection flag on the descriptor, which a patch refuses to add, so the line now states the one fact true in both halves — "tab {index} has messages waiting to send" / "标签 {index} 有消息等待发送", `{index}` intact — trading only the connected case's extra "why" for a claim that no longer lies when the agent leaves.
- **The runtime-metadata row stops reporting a measurement it never took**: `collectDiagnostics` asks the client for its agents/models/commands only when one is connected; with none connected it fell back to a minted `{modes:0,models:0,commands:0}` placeholder and interpolated that into the same "0 agents, 0 models, 0 commands" line a connected agent that genuinely returns empty lists produces. A panel that never posed the question printed a settled zero answer — directly under the connection row already saying "Failed to connect to OpenCode", the one fact proving the zero was never observed. The "asked, found none" versus "never asked" distinction lives in state the code does not carry (adding it is out of scope for a patch), but the disconnected case is detected outright at `connected`, so the row now reads the truth it holds — "Not queried — no agent is connected" / "未查询 — 没有已连接的 Agent", `ok` false — while a real agent still counts its real zeros.
- **A side-chat bubble stops being left in a retired language**: the panel could re-speak only its chrome — title, close, send, placeholder — so `relabel()` touched nothing inside the transcript, and a bubble drawn from the locale table (the "Thinking…" placeholder, the busy refusal, the "no text reply" note) stayed frozen across a switch while the rest of the panel moved, reading as though those lines were not translations at all. They are, and the renderer already re-speaks the main transcript this way, so the side chat adopted the same convention: `relabel()` now walks `[data-i18n-text]` in its own transcript and restates each tagged bubble from the table. Only table strings get tagged — the streaming answer drops its tag the moment real text lands, and the `{error}` failure line stays untagged, since neither is a reading a locale switch could reproduce.

## 0.2.31 - 2026-09-30

No new capabilities. This release retires a plan caveat the freshly-streamed rows beneath it had already contradicted, an `@` keystroke that was swallowed to open a mention menu the vault had nothing to fill, and a truncation note that pointed at "earlier" messages while the earliest one was still on the screen above it.

### Changed

- **A live plan frame retires the note that said the plan could not be read**: a `plan` frame repaints the checklist from entries the agent just streamed, but that path stamps `lastPlanUpdateAt` to now, which is exactly the gate that suppresses the post-turn DB resync — so the "The plan could not be read from the agent, so it may be out of date" note a previous failed resync left up was never cleared by the fresh rows that contradict it, and the reader was told the list might be stale at the moment a current one was painted beneath the words. `setPlanEntries` now clears the `planStale` note up front (every caller that reaches it is delivering plan content), and a later failed resync still re-marks it through `setPlanStale(true)`, so nothing that was honest before goes quiet.
- **The `@` key stops being swallowed for a picker with nothing in it**: at a word boundary the handler called `preventDefault()` unconditionally and opened the mention dropdown, but the `@` list is built straight from `listAllNotes()`; in a vault with no notes to reference that list is empty and the dropdown could only render its "No matches" row — a panel with zero selectable choices, so the keystroke promised a menu the vault cannot supply and ate the character the reader typed. Tab already refuses to be taken when there is no second mode to step to, and `@` and `/` now follow the same rule: `showAC` returns whether a picker actually opened and declines to open an empty `@`-list, and the keydown handler gates `preventDefault` on that result so a declined toggle leaves the `@` typed (the slash branch always lands the compact fallback, so it opens whenever asked).
- **The truncation note stops naming the wrong end**: when a history is over the cap the head/tail split keeps the first *N* rows, drops what sits between them, and keeps the last *M*, writing the marker after the surviving earliest rows — yet the label read "[N earlier messages truncated]" / "[前面 N 条消息已省略]", claiming the omitted ones were the earlier messages while the earliest row was still on screen above that very line. The count was always right; only the positional word was a falsehood, so it comes out: "[N messages truncated]" / "[已省略 N 条消息]", `{count}` intact.

## 0.2.30 - 2026-09-30

No new capabilities. This release corrects three lines that named a subject or a request that was never there, a ✓ badge and a model label that read off a list other than the one the action uses, and a diagnostics row that a language switch left frozen mid-sentence.

### Changed

- **Three readings stop naming a subject that was not there**: `humanizeError` routes a JSON-RPC `-32601` by dropping whatever the error carried into the `methodNotFound` "{detail}" slot, and the guard that catches a non-method phrase matched only the exact stock "Method not found" — so the transport's `"Unknown error"` sentinel (what `AcpJsonRpcTransport` synthesizes when a `-32601` arrives with neither a message nor data) and any agent that answers with a reason sentence were quoted as a request the agent lacks, reading "the agent does not support \"Unknown error\"" and charging it with missing a thing no one ever named; the guard now rests on the invariant that settles the question — a real method name never contains whitespace — so a sentence falls through to the generic error line. The session dropdown's greyed fork/resume/close buttons carried "…is not supported by this OpenCode agent", but the capability getter answers null while nothing is connected and all three gates are `=== true`, so the tooltip named a subject that is not there to support or refuse anything; they now read like the image-attach refusal the previous round fixed — state what the reader cannot do, plus a reason that holds whether an agent is connected and not advertising or none is at all. And the unreadable-request line, "Permission request could not be shown, and was cancelled", was one string that `onPermissionUnreadable` also fires for elicitations (a malformed create, a form that cannot render, returning a decline rather than a cancelled permission), so it described a prompt kind the reader was never shown and an outcome that contradicted the decline actually sent; it now says only what all four causes share — an agent request could not be shown, so it was not carried out — keeping the internal key so a locale switch still re-speaks it.
- **A ✓ and a model label stop reading off a list the action does not use**: the @-dropdown marks a note ✓ as already attached, but built the set from `ContextMention.getAllRefs()`, which only the @-menu feeds, while `send()` carries the composer's own `currentRefs` — drag-drop, the auto active-file ref and `onAddNoteRef` all push a note onto `currentRefs` without touching mention, so a note that was in fact attached and would go out with the next message showed no check and the dropdown read "not added" over one that already was; the badge now keys off the same list the send path reads. And the model selector printed "No models" while a model was running: `updateModels` names a current absent from a populated list, but the empty branch did so unconditionally, so an empty common list carrying a hidden current contradicted the model in force; the rule is now one helper both the setter and `refreshLocale` call, and the only behavior that changes is empty-list-with-a-current, which names the current instead of denying any model.
- **A diagnostics row stops being left frozen in a retired language**: `addDiagnosticsBlock` re-reads the PASS/FAIL word from the current locale on every render, but each row's label and detail are finished strings `collectDiagnostics` baked from the locale it ran in, so switching language re-rendered the heading, the button and the pass/fail prefix into 中文 while every collected row stayed "通过 ACP connection / Connected to OpenCode" — one reading frozen mid-line inside an otherwise translated panel. Those rows are restorable only by probing again, which is the user's click (and a re-run would reconnect the agent as a side effect no one asked for), so the language change now withdraws them to the honest not-yet-run state the panel shows before the first click rather than freeze them.

## 0.2.29 - 2026-09-30

No new capabilities. This release corrects a timeout and a tooltip that named an agent or a request that was never there, an empty-list notice that answered a search before the fetch it was waiting on had landed, and a toolbar that kept the just-closed conversation's model, agent and command lists on the welcome screen that replaced it.

### Changed

- **A stalled load and a withdrawn attach stop naming a subject that was never there**: `replayBoundedLoad` gives up on a `session/load` that has replayed nothing past the idle window and rejects an `AcpTimeoutError`, but built it from the client's *logical* method name `"loadSession"` rather than the wire method the request actually went out as — and `humanizeError` quotes that field straight into "The agent did not answer \"{method}\"", so the line charged the agent with ignoring `loadSession`, a name the connection may never have been addressed by at all (`session/load` is the first candidate and the one the fallback sends), while every other timeout site already hands its real wire method; it now reads the method out of the same cache the request used. And the attach tooltip read "This agent does not support image prompts" — a claim about a connected agent's capabilities — but the button is greyed by `handleDisconnect` too, where there is no agent to fail to support anything, so it asserted the one case while lying about the other; the single shared string now names the state both paths actually hold ("Images cannot be attached — no image-capable agent is connected"), mirrored into Chinese, and no enable/disable surface was changed to tell them apart.
- **The session dropdown stops announcing "No sessions found" over a fetch still in flight**: its empty line is held back while a native sessions load is running, but the flag that does so (`nativeLoading`) is spent the first time it draws its spinner, and a search keystroke re-runs `renderItems` directly without re-arming it — so once the spinner had shown and the fetch still hung unresolved, filtering the local rows to nothing passed the guard and printed "No sessions found" across a result set that had not arrived, only to retract it a moment later when that fetch landed and rebuilt the panel; the empty message now also waits on `nativeLoadedOnce`, the flag that actually flips when the load settles, so a genuinely empty or failed native list still says so.
- **Closing the last tab takes the dead conversation off the shared bar**: activating a tab re-projects the composer, the send button, the context arc *and* the model, agent, effort pickers and `/` command list from the tab coming forward, but the last-tab close has no sibling to hand them to and reset only the first three — so the welcome screen underneath kept naming the deleted session's negotiated tier and its commands, pickers that on a runtime with no session route the choice through a `sessionId` it does not have and can only refuse; the branch now re-projects those lists from the empty runtime too, withdrawing them exactly as a background tab's are withdrawn, placed before the composer resets so the send/stream state stays the last word the bar reads back.



No new capabilities. This release corrects three failures named after things that never happened, a queue badge and a settings field that kept showing a reading the code had already walked back, and the one refusal notice a language switch left frozen.

### Changed

- **Three errors stop being diagnosed by a cause the code never found**: the idle watchdog times out on a prompt turn the wire knows as `session/prompt`, but built its `AcpTimeoutError` with the client-internal name `"sendMessage"`, and `humanizeError` quotes that name straight into the line "The agent did not answer \"sendMessage\"" — charging the agent with ignoring a request it was never sent, when every other timeout site already hands its real wire method; `requestWithFallback` opens by refusing to run with no transport and threw `stdinNotWritable`, "OpenCode process stdin is not writable" — but that field only exists between `connect()` and `disposeConnection()`, so a null there simply means nothing is connected (usually no OpenCode process at all), not a per-process broken pipe, and the claim is a true sentence only at its spawn-time site where a child's stdin really is null, so the guard now reports the state it actually holds; and a conforming JSON-RPC `-32601` arrives as the stock prose "Method not found" with no colon, which the prefix that strips an agent's restatement leaves whole, and quoting that in the `methodNotFound` "{detail}" slot read "the agent does not support \"Method not found\"" — a method literally named that — so a bare or stock restatement now falls through to the generic error line, naming the same fact without inventing a request.
- **A restored turn and a refused edit stop showing a reading the code had already walked back**: `drainQueueLoop` merges consecutive plain prompts and repaints the queue badge for the shrunken queue before handing the run to `send()`, and when a pending permission refuses the turn the whole merged run goes straight back on the queue via `unshift` and the loop breaks — but the badge was left naming the smaller count, so the strip listed prompts (one, two) the waiting chip no longer counted, the exact under-report the sibling capacity re-queue already repaints away at its unshift; the restore path now repaints for the full size. And a settings number box that rejects its edit sprang only the stored value, not the field: `parseBoundedInt` refuses a non-integer or out-of-range edit and returns null so nothing is saved, but each caller just `return`ed and the text box went on displaying the refused text — the number on screen was again a claim the settings no longer stood behind, the same mismatch its own docstring complains about, only half-corrected; `maxNoteSize` / `maxSessionMessages` / `sessionRetentionDays` / `maxOpenTabs` / `terminalTimeoutMs` / `terminalMaxOutputBytes` / `idleTimeoutMs` now write the value the settings actually hold back into the box on refusal, and `opencodePath` gets the same treatment where `validateOpencodePath` warns, stores nothing, and left the bad path displayed.
- **The refusal badge re-speaks in the language being read**: `surfaceStopReason` drew its `stopReason.refusal` banner — a fixed string with no runtime token, fully restorable — straight from `t()` and handed only the finished text to `addError`, so the notice carried no key for the `refreshLocale` walker and a language switch re-spoke the transcript around it while that one line stayed frozen in the language the turn first refused in; the note helper now threads the key into `addError`'s `textKey` slot exactly as the connection-loss banner was given it, while the branches below stay untagged on purpose — the truncation and tool-call notes route through `addSystemMessage`, which has no key parameter, and the unknown badge interpolates `{reason}`, a line that must stay verbatim rather than be re-printed from a template that would drop the actual reason.

## 0.2.27 - 2026-09-30

No new capabilities. This release corrects three sentences the app says about a situation it had misread, refuses an image the toolbar had just stopped offering, and re-speaks the one connection-loss notice a language switch left frozen.

### Changed

- **Three verdicts stop naming a cause the code never diagnosed**: a slash command is registered only when its frontmatter parses, and `parseCommandFile` returns null for two different shapes of file — one with no opening `---` at all, and one that opens with `---` but never closes — which `FileCommandStorage` folded into one bucket reported as "has no frontmatter", true of the first and false of the second, a note visibly carrying a header the parser simply could not finish, so the advice sent a reader to write a block the file already half-had; an agent's own error reaches `humanizeError` with a JSON-RPC code, and the two the plugin maps are named outright while every other code — including a frame that arrived with no code at all — fell through to a line calling it "The agent refused", inventing a deliberate denial the reader then hunts for a reason for (the very word `accessDenied` reserves for a genuine permission rejection), so an unmapped code is now "The agent returned an error"; and the MCP transport picker grays out http and sse with "not supported by current agent", which holds for a connected agent that declined to advertise the transport but not for the common case where there is no agent running to decline anything (`getAgentCapabilities` hands back null the moment the client is not connected, and `httpEnabled` reads false off it) — so the caption now reads "no connected agent advertises it", true with an agent that never promised http and true with none at all. Every `{token}` is kept in place and mirrored into Chinese, and no behavior was added or removed.
- **A dropped image is refused by the drop zone the button already refused**: `handleDisconnect` greys the toolbar's attach button, because an image that cannot be sent must not stay attachable, but the drop and paste path never learned the agent had left — with no client the capability snapshot is empty, an unstated prompt capability defaults to a cautious yes, and the gate that was supposed to refuse passed the file straight through and drew the chip, a control the toolbar had just withdrawn still answering to a drag. It now reads the same connection the button does, so an image dropped or pasted while nothing is connected is turned away; and the two refusals are kept distinct on purpose, since blaming "this agent does not support image prompts" for a situation with no agent would only trade the old lie for a new one.
- **The connection-loss banner re-speaks in the language being read**: `noteConnectionLost` drew its line straight from `t().error.reconnectFailed` and handed only the finished text to `addError`, so the notice carried no key for the `refreshLocale` walker to reach — a language switch re-spoke the transcript around it while that one line stayed frozen in the language the failure first surfaced in, though it is fixed text with no runtime token and fully restorable. Its sibling permission-unreadable banner already rides a `textKey` precisely so a repaint follows the locale, and the connection-loss line now gets the same treatment through both the on-screen renderer and each tab that had a conversation; the wording is unchanged, only the ability to say it in the reader's current language is.

## 0.2.26 - 2026-09-30

No new capabilities. This release corrects a thinking block that counted a line which was only its own closing newline, a picker that had stood down to a screen reader but still answered a mouse, and an error notice the transcript left frozen in the wrong language.

### Changed

- **A thinking block stops offering to expand text already whole**: `truncateLines` split raw text on newlines with none of the trailing handling `renderLinesExpanded` and `renderTruncatedText` gained in the two releases before it, so a thought of exactly the line budget that ended in a newline split into one segment more than it had lines, cleared the 30-line cap by that phantom row, and drew a "Show all" link over text the reader could already see whole — a click that only revealed the same words back. The closing newline terminates the final line, it does not open a blank one; that single trailing empty segment is now dropped before the budget is read, the same ghost `renderSearchExpanded` filters out, so a full block stops offering while a line genuinely kept past the cap still truncates.
- **A withdrawn picker stops answering a mouse it already refused a screen reader**: `applyModelOperability` and `applyEffortOperability` already lift `role`, `tabindex` and `aria-haspopup` off a control with no rows to choose (the 0.2.20 rule — never advertise a listbox you cannot deliver), yet the click and key listeners wired once in `wireDropdown` stayed live, so a pointer press on the empty picker still called `open()`, which stamped `aria-expanded="true"` back onto a div that no longer had any role to expand and popped a dropdown holding only the `pointer-events:none` "No models" line no one could pick — the exact empty-listbox lie the withdrawal was meant to stop, still reachable by hand, while the stylesheet kept `cursor:pointer` and the hover reveal unconditionally, so the control went on wearing the look of a chooser it was not. Both halves now read the mode chip, the one sibling that has done this honestly throughout: `open()` answers to a `has-options` predicate and stays shut with nothing to choose, the operability pass toggles `.has-options` on the selector, and `main.css` scopes the cursor, hover tint and hover-pop to that class, so pointer and hover belong to the operable case only.
- **A failure notice re-speaks in the language being read, unless it carries its own detail**: the transcript re-labels every tagged surface on a locale switch, but an error drawn by `addError` was the one left holding both its sentence and its button in the language the failure first surfaced in — the text span and action button were built straight from `t()` yet left untagged, so `refreshLocale` relabelled the panel around them while they froze, and re-arming the button from the label captured at draw time stamped the stale wording back over whatever the switch had just freshened. Only notices assembled from fixed UI wording are worth re-speaking, so the caller now hands over the key that drew the line: span and button ride `data-i18n-text`, and the button restores through the same `lookupLocaleString` the walker uses, so a language change landing mid-retry comes back in the words being read now. A diagnosis carrying the error's own detail — a `humanizeError`, an `{error}` interpolation, a message a caller built and passed in — is left deliberately untagged and stays frozen: reprinting it from the locale template would drop a literal token where the reason was, and a frozen-but-true line beats a restorable-but-false one.

## 0.2.25 - 2026-09-29

No new capabilities. This release corrects two readings their own numbers contradict — a wrapped tool output that counted a line nobody had written, and a context meter that published a percentage against a scale it never declared — withdraws a control a freshly opened tab could only ever have refused, and re-reads one position a tab can move out from under.

### Changed

- **A wrapped output stops counting a line that is not there**: `renderTruncatedText` split on raw newlines with none of the trailing handling its expanded twin `renderLinesExpanded` gained in 0.2.24, so a result that filled exactly the line budget and then closed with a newline was cut short with "... 1 more lines" over text the reader could already see whole, and one line genuinely kept back was advertised as two — the closing newline terminates the final line, it does not open a blank one; that single trailing empty segment is now dropped before the count, the same ghost `renderSearchExpanded` filters out.
- **The context meter names the scale it reports against**: the arc publishes a percentage 0–100 through `aria-valuenow`, but a `role="meter"` defaults to a 0–1 range, and no `aria-valuemin`/`aria-valuemax` was ever set — so a screen reader heard "45" as a gauge driven far past full, while the un-reported branch already drops the number rather than say "empty". The two ends the arc actually uses are now declared, so every real reading is named against bounds it can reach.
- **A freshly opened tab stops offering an effort tier it cannot act on**: a live client with no conversation has an empty snapshot, and the picker fell back to the client's built-in tiers even though effort is only a safe bet once a session exists to receive it through `setConfigOption` — so the bar drew four tiers to choose while `onEffortChange` read the tab's sessionId, found none, and returned without sending (0.2.24 emptied the same control on disconnect; this is the connected-but-sessionless twin). It now reads what models and agents already do, so a session without a reported vocabulary keeps its own list, while a tab with nothing to talk to gets an empty list and the picker stands down with the rest of the bar.
- **The permission chip names where the asking tab stands, not where it was**: a background request carries the tab it came from so the banner can point a way home, and it did so with a tab number captured when the request arrived — but a queued prompt does not draw until it reaches the front and a visible one redraws on a locale switch, and the strip can reorder underneath either, so a tab to the left closing moved the conversation up a row while the chip went on saying "from tab 3" for a turn now sitting in slot 2 (the click was never wrong — `onFocus` resolves through the live runtime, and closing the asking tab dismisses its own banner before a stale draw; only the number lied). The origin now hands the banner a read taken at draw time, the one fact on the chip that is not about wording, so a re-render speaks the tab's actual position.

## 0.2.24 - 2026-09-29

No new capabilities. This release corrects two readings a tool card derived out of nothing — a file creation that reported a line it had deleted, and a result whose final newline was counted as another line still waiting off-screen — re-speaks two strings that froze in the language the surface happened to be built in (an image refusal that named no format, and an untitled tab whose fallback word was baked into the list the strip replays), and withdraws two affordances that promised an action the code refuses to take — a disconnected tab that still offered an effort tier whose choice silently goes nowhere, and a tab badge that told a screen reader to "switch" to the conversation it was already reading.

### Changed

- **A file creation stops reporting a deletion it never made**: `computeDiffStats` and `parseDiffLines` split each side on newlines, and an empty file `''.split('\n')` is `['']` — a single blank line, not none — so a `write` carrying only its new text was diffed against one phantom old line: it drew a `−1` beside the `+N`, a `diff-line.removed` row for content that had never existed, and that fabricated delete broke the all-inserts new-file cap, which only fires when every line is an insert, so a created file fell through to hunk rendering instead of the capped new-file view. A line now counts only when the text carries one — a trailing newline still separates and terminates real lines, so just the wholly empty string collapses to nothing, leaving a real blank line to keep its space placeholder.
- **A newline-terminated result stops counting a line that is not there**: `renderLinesExpanded` split the output and advertised `lines.length - maxLines` as "+N more lines", but a result ending in a newline splits into one trailing empty segment that was never a line, so a three-line read reported a fourth waiting below — the same ghost `renderSearchExpanded` already filters away, and it now drops that single trailing segment before counting or slicing, so neither the overflow number nor a stray blank row survives.
- **An image refusal that named no format answers in the current language**: `renderToolImage` emits "Co-Ober cannot show part of this tool result." for an image whose MIME could not be read, built straight from `t()` and left untagged — the exact twin of the unsupported-content line 0.2.23 taught to ride `data-i18n-text`, stranded in English mid-strip while the card around it re-localized; it now carries that key, while a refusal that does name a format stays deliberately untagged, since reprinting its sentence from the template would leave a literal `{type}` where the MIME was.
- **An untitled tab is spoken at draw time, not minted into the list**: `tabDescriptors` baked `t().tabs.untitled` into each badge's title, but the strip replays that stored list on every repaint — including the one a language change forces — so an unnamed conversation kept saying "New conversation" to a reader who had moved to Chinese while every other word on the badge changed around it; the descriptor now carries the store's title verbatim and an empty string when there is none, and the strip says the fallback itself in whatever words are in force, so it is a snapshot of facts rather than of wording.
- **A disconnected tab stops offering an effort tier that goes nowhere**: `handleDisconnect` withdrew the dead agent's models, modes and configs to empty lists yet left the effort picker populated with the built-in tiers — but picking one routes through `setConfigOption` on a client that no longer exists, so `onEffortChange` returns without acting, and `refreshLocale` re-minted those same defaults on the next language change, handing the dead control straight back. The list is now emptied alongside its siblings, the relabel maps the real (empty) list so it stays withdrawn, and an empty picker drops its `role`/`tabindex`/`aria` just as the models row reads "No models" when bare.
- **The tab a reader is on stops promising a switch it cannot perform**: every badge carried `aria-label` "Switch to tab {index}", but selecting the active tab — by mouse, Enter or Space — is a guarded no-op, so the current conversation announced a move that cannot happen; it is now named for what it is, "Current tab {index}", leaving the switch wording for the inactive badges a switch can actually act on.

## 0.2.23 - 2026-09-29

No new capabilities. This release stops a reopened conversation from painting its finished reasoning as work still running — a stored thinking block reached the panel through the live path, so it opened as a ticking "Thinking…" bubble with a duration no frame ever reported — re-speaks the tagless "unsupported content" line across a language change the way its siblings already are, and withdraws two claims the code never earned: a generic load-failure notice that named one of several causes it had not diagnosed, and a pin star on a placeholder session row the local store would silently refuse to save.

### Changed

- **A restored thinking block stops ticking like live work**: `paintTranscript` fed a blockless assistant `thinking` message straight to `appendThinking`, whose first act is to mint a fresh live bubble carrying `is-thinking` and a running elapsed timer — so a saved conversation reopened advertised a thought still being thought long after that agent had gone quiet, and since nothing persists `ContentBlock.duration`, the number it counted up was invented on this repaint rather than read from the transcript; restored thinking now flows through `addStoredThinking`, which draws one finished block past-tense via `renderStoredThinkingBlock` — never active, no timer span, and nothing left in the renderer's live state for the transcript to finalize — the same past-tense contract the structured-block restore path already used for the thoughts that survived as blocks.
- **A tagless unsupported-content line answers in the current language**: when a tool result carries an item whose wire tag could not be read, the card said "Co-Ober cannot show part of this tool result." built straight from `t()` with nothing left behind, so an on-screen language switch relabelled everything around it while this refusal froze in the locale it first drew in — and a completed tool call repaints for no other reason; it now rides `data-i18n-text`, the marker `refreshLocale` walks, so a settled refusal is re-spoken in the words in force, while the *named* variant ("cannot show `resource_link` content") stays deliberately untagged — its sentence embeds the tag the agent sent, a value no locale table can resupply, so reprinting it from the template would leave a literal `{type}` on screen: honest frozen beats falsely restorable.
- **A generic load failure stops naming a cause it never diagnosed**: the `catch` that emits `loadNativeFailed` wraps the entire native sync — load, adopt and replay — so a transport failure, a malformed frame and a genuinely unsupported `session/load` all print the same line, yet that line read "(session/load not supported or session unavailable)", asserting two specific causes it had not looked at the caught error to confirm; the two real diagnoses already have their own words (`nativeSessionMissing`, `syncUnsupported`), so the generic notice drops back to "Could not load this OpenCode session."
- **A placeholder session row stops offering a pin it cannot honor**: with the agent unable to list sessions the dropdown still paints the current conversation, sometimes as a row the local store holds no entry for, but its star was wired straight to `setPinned` — which returns false for an id it does not have — so the click persisted nothing and the ★ never arrived, the same empty promise the fork and rename controls already decline to make; the pin now checks that the row is an actual saved conversation before enabling, and when it is not the button states that plainly rather than borrowing the "agent does not support it" excuse, which would only trade one invented cause for another.

## 0.2.22 - 2026-09-29

No new capabilities. This release takes back a number that outlived the transcript painting it — a cleared tab's un-prompted-grants counter that the reset sweep left behind, so a fresh session's first local write re-read the previous session's total into an emptied panel — re-speaks the four truncation counters that froze in the language a card first drew in, and corrects a draft-restore notice that told the reader images are "never saved to disk" when a sent image is in fact persisted with the transcript and only trimmed later by the stored-image budget.

### Changed

- **A cleared tab starts its un-prompted-grants count over, like the counters beside it**: `resetRuntimeView` zeroes `droppedFrames`, `orphanFrames` and `orphanGrants` under the rule that a count feeding a line painted into the just-cleared transcript must restart with it, yet `rt.unaskedGrants` was the one exempted — and that same field drives the `permission.granted` note written into the very transcript on every un-prompted local write, so the next such write re-read "Co-Ober carried out N agent request(s) on this machine without a prompt" carrying the *previous* session's total into an emptied panel, counting work whose lines were no longer on screen; it is now cleared alongside its three siblings, the same ruling `orphanGrants` already obeys rather than a new policy.
- **A diff or tool truncation counter is re-spoken after a language change**: the four "... N more lines" / "... N more matches" rows — a capped new file, a truncated hunk, a long read and a clipped search — were built once from `t()` into the card body and left untagged, so switching language re-localized everything around them while the count line itself froze in the language the card first rendered in; the renderer's `refreshLocale` already re-speaks any element riding `data-i18n-count`, so each now carries its key and the count it was drawn with (`diff.moreLines` ×2, `tool.moreMatches`, `tool.moreLines`), the same contract the already-tagged `noChanges` / empty-state rows use — a stale word never refreshed onto the wrong number.
- **A draft-restore notice stops claiming images are never on disk**: the notice explained dropped staged images with "images are never saved to disk", a rule the store itself breaks — a *sent* image is persisted with the transcript as base64 and only trimmed later when `data.json` exceeds the stored-image budget; what `storedDraft` actually keeps is the *count* of images staged, never their bytes, so both locales now say a draft remembers how many images were staged, not the images themselves (the `{count}` token is preserved, so the paint path and the live-string test are unchanged).

## 0.2.21 - 2026-09-29

No new capabilities. This release withdraws a time and a dollar a message never earned — a bubble stamp that turned the undatable sentinel into an invented clock reading, a turn-cost that outlived the turn that set it — re-speaks the three strings a language change left frozen in the words the reading had already moved off (two tool empty-states and the permission banner's origin chip), and takes back three affordances that promised work or a gate they could not carry — a dead tab's `/compact`, an empty-list line above a list the same panel was drawing, and a permission tier that told the reader to confirm every prompt while letting an allowed action run un-prompted.

### Changed

- **A replayed turn the database never timed reaches the panel with no hover time at all**: the message bubble stamped `[data-timestamp]` with `timestamp ?? Date.now()`, and `??` catches only an omitted argument — so the undatable sentinel (`timestamp: 0`, what `sessionReplay` writes and `transcript.ts` / `session.ts` already honour) fell straight through into `new Date(0).toLocaleTimeString()` and hung an invented "08:00" on a conversation that had no time, defeating the very `[data-timestamp]` rule that means "none"; the stamp now mirrors that contract, setting the attribute only for a reading above 0 and under `MAX_TIMESTAMP_MS`, so a live message still takes the current clock while a zero or past-cap reading is left blank.
- **A turn that priced nothing stops advertising the previous turn's dollar figure as its own**: the 0.2.17 turn-start reset zeroed the token totals but left `cost` behind, and the end-of-turn footer spreads the whole still-populated usage beside this turn's elapsed time while the per-message stamp writes `cost` onto this turn — so the reset now clears the amount too, the one field that was silently exempt (it is neither a context-meter field nor per-turn-honest to carry), across `addUserMessage`, `appendText`, the streamed-thinking wrap and the carried-cost reset.
- **An apply_patch card's "No result" is re-spoken after a language change**: a patch that ignores a content item carrying no diff and no output prints the same "No result" the fetch path was tagged for in 0.2.20, but this branch created the empty-state line eagerly from `t()` and never carried `[data-i18n-text]` — which is all the renderer's relabel walk reaches — so reopening after a switch showed the previous locale's word under a freshly-localized header; it now rides its key.
- **A hunkless diff's "No changes" is re-spoken after a language change**: `renderDiffContent`'s no-changes line (every line equal, nothing to show) was likewise written once from `t()` and left untagged, freezing it in the language the diff happened to open in while the surrounding card re-localized around it; it now carries `diff.noChanges` so the same repaint re-speaks it.
- **The permission banner's origin chip answers in the current language**: a visible permission re-renders on a locale switch (an outstanding elicitation deliberately does not, so it keeps the language an answer was half-typed in), yet its "Request from tab N" chip was a label minted once when the request arrived — the single element on the redraw that stayed English under a Chinese title, kind and buttons; `PermissionOrigin` now carries the tab number and the label is spoken from `permission.originTab` at draw time, so the repaint re-speaks it alongside the rest.
- **A disconnected tab stops offering `/compact` it cannot carry**: the palette lists `/compact` as a selectable session command, but compacting is a turn sent to the agent and `sendTextToAgent` settles to a silent return with no client or no session open — the reader picked it and nothing happened; the same ruling that took `/add-dir` off a bare tab in 0.2.15 and `/fork` in 0.2.16 now reads for `/compact`: a client up and the controller's own session open.
- **A session list stops announcing it is empty above the rows it is drawing**: "No sessions found" was emitted straight from the local rows, while the native and content sections went on painting clickable sessions into the very same panel below the line — a dropdown that said there was nothing to pick and listed sessions to pick at once; the message now fires last, and only when local rows, native rows and content rows are all absent and no native fetch is still in flight (a still-loading list is not an empty one), which keeps the genuinely-empty case speaking while silencing the contradiction whenever anything is listed.
- **The "safe" tier says what it enforces, not a confirmation it never requires**: the option was described as "confirm every prompt", but a write or command this client has already approved runs without asking and is only recorded to the conversation — safe gates the *un*-permitted, not everything; both locales now say an allowed local action executes un-prompted and is logged, rather than promising an every-prompt confirmation gate that `safe` does not impose.

## 0.2.20 - 2026-09-29

No new capabilities. This release withdraws an affordance the moment the work that justified it is gone — a stale close-confirm, a dead agent's slash commands, two empty pickers advertising a listbox to open — re-speaks on a language change the three surfaces that had frozen in the language they were painted (a waiting prompt, a collapsed tool card's empty line) or stamped with the reader's own clock (a mirrored transcript of unknown age), and takes back three words that asserted something the code never does — a header naming a file it was not showing, a timeout promising a kill it only waits out, an unreadable-blame laid on a prompt that was merely empty.

### Changed

- **A finished tab stops wearing the confirm that was armed to stop it**: the close button's ✓ means "click again to stop this tab and close it", reached by pressing × while the tab is generating — but a turn that ended before the confirm's timer let the tab keep the ✓ through the next repaint, advertising a stream to stop and a two-step press that no longer existed, since the click handler already falls straight to a single-press close once nothing is streaming; the arm is now *dropped* (not merely un-painted) at that repaint, so one press genuinely closes.
- **A disconnected tab stops offering the dead agent's slash commands**: the palette is built from the command registry, which the agent kept repopulating over `available_commands_update`, and models, modes and configs were all withdrawn at disconnect while its commands stayed behind — the reader picked one, its own `/name` line was written into the composer, and the send path had no client left to run it; the same rule that cleared the other controls now clears the agent-synced entries, leaving builtins alone.
- **An empty model or effort picker stops advertising a listbox it cannot deliver**: with nothing reported each dropdown's sole row is the non-activatable "No models"/"—" line, yet its button was born with `role=button`, a tab stop and `aria-haspopup=listbox`, promising a listbox a reader could open but never choose from; operability now follows the option count — the mode chip's rule read across both pickers — re-applied whenever the list is populated or withdrawn.
- **An adopted transcript is filed at its own time, not the import time**: `adoptReplay` mirrored a native session and stamped its `updatedAt` with `Date.now()`, so a conversation the agent finished hours ago filed at the top of the list as "just now" and the reader reached for a session that had gone quiet; the value is now derived from the newest real message time the replay carried, and where none was named — or the time is out of range — it falls to the same undated sentinel (`0`) that `sessionReplay`'s messages and `list()` already honour, rather than a date the transcript never earned.
- **A waiting prompt is re-spoken when the language changes under it**: the queue indicator's `1 queued` / `N queued` and its remove button's aria label are read out of `t()` at paint time and are rebuilt by no other repaint, so it was the one toolbar-adjacent surface the locale subscription forgot — switching language left the count in the locale the prompt happened to queue under; the listener now re-renders it alongside re-registering the builtins, a no-op when the queue is empty.
- **A collapsed tool card's empty line is re-spoken after a language change**: the "No content" / "No matches" / "No result" / "File deleted" line a completed tool's body settles to was written eagerly once, then frozen when the card collapsed, and the renderer's relabel walks `[data-i18n-text]` — which these never carried — so reopening after a switch showed the previous locale's word under a freshly-localized header; they now ride their i18n key so the same repaint re-speaks them.
- **A write/edit header names the file the diff actually draws**: the header's name is chosen at card creation from the tool_call's input/locations, and when those carried nothing (a write announced before its diff, an edit whose path rides only on the content frame) it read "Unnamed file" while the body beneath drew a diff for a real path; the name now follows the diff — the same basename the summary would have shown had it arrived — and the accessibility label read off those words stops announcing an on-screen file as unnamed.
- **The command timeout describes the wait it enforces, not a kill it never makes**: it read "maximum time before a command is terminated", but that deadline only bounds `waitForExit`, whose timer rejects the *wait* and never touches the process (`kill()` belongs to the agent's terminal/kill, the capability closing, release and dispose, not the timeout); the description now says what happens — how long Co-Ober waits for an exit before giving up on the wait, and that the command keeps running on this machine past the deadline.
- **The unreadable-permission line is cause-neutral, since four causes share it**: it fires for a malformed permission request, a well-formed one carrying no selectable options, and elicitation prompts this client cannot render, yet blamed a failed parse ("was unreadable / 无法解析") on a prompt that was perfectly readable and simply had nothing to click; the line now says only that it could not be shown, and was cancelled.

## 0.2.19 - 2026-09-29

No new capabilities. This release stops a loaded transcript, a repaired row, and a focus key from asserting an ending, a date, or an action nobody handed them, and takes the rule back off a plan state no frame carries.


### Changed

- **A replayed turn is left without a date instead of stamped today**: `message_chunk` frames the agent sends during a session load carry no timestamp, and the collector filled every one in with `Date.now()`, so a conversation written months ago opened with today's date on each turn and the exported transcript read that invention back as if the agent had said so — the same undatable sentinel transcript.ts and NativeSessionReader.ts already honour (`timestamp: 0`, "no time at all") is what a replay actually is, and the collector no longer reaches for a clock at all.
- **A session whose stored time cannot be read reaches the dropdown with no time at all**: the migration path repairs a damaged record to `updatedAt: 0`, meaning "this session has no date", and the retention pass already spares it on exactly that reading — but `list()` handed every row through `new Date(0).toISOString()`, so the dropdown's `if (s.updatedAt)` guard was defeated by a real-looking "1970-01-01T00:00:00.000Z" hung on a conversation the database never timed, and a past-cap epoch threw in `toISOString()` and took the whole listing down with it. It now mirrors NativeSessionReader's contract — a value under 1 or over `MAX_TIMESTAMP_MS` yields no `updatedAt` rather than a wrong one or a missing list.
- **Tab stops promising a mode cycle there is nothing to switch between**: the composer swallowed Tab and Shift+Tab unconditionally and fired off `onCycleMode` whether or not a mode actually changed, so at one agent (or none yet) — where `cycleMode()` can only return, the very condition 0.2.18 stage 2 already used to take `role=button` off the mode chip — the key was consumed to do nothing and trapped the keyboard reader in the textarea instead of moving focus as it does everywhere else on the page. `cycleMode`/`cycleModeReverse` now answer whether they moved, the callback contract says a false return means the caller may release the key, and `preventDefault()` fires only on the side of that answer that actually changed something.
- **The plan panel loses a rule for a state no ACP frame ever sends**: `setPlanEntries` stamps the class straight from the entry's status, whose wire vocabulary is closed to *pending* / *in_progress* / *completed* / *cancelled*, so the muted `.status-todo` coloured a plan-item state nothing produces while the *pending* rows it was meant to reach — the ones the checklist actually paints with a ○ — are unstyled, which is right (the icon is what says "not started yet", not a colour); the rule is taken back rather than renamed, since inventing a new decoration would open a surface under a patch release, and the two states the wire does send keep their rules.

## 0.2.18 - 2026-09-29

No new capabilities. This release stops a window reading, a withdrawn summarising, and a salvaged keystroke from being reported as something they are not, retires the actions a disabled button, a text field, and a single-agent bar kept offering but could not carry, and leaves a translated panel, a colouring badge, and a dashed frame no code paints saying what they actually mean.

### Changed

- **A first usage frame reports no tokens consumed it never named**: a session's opening usage line that carried only `used` — how full the context window is — was also seeding the footer's token *total* from it, so a report of "45k tokens in the window" went out as "45k tokens spent", work no frame claimed; the merge branch already kept the two figures apart and the meter already reads occupancy from `contextTokens`, so the total now opens at a reported figure or nothing.
- **A withdrawn compaction spelled the way this file reads one stops saying "Context compacted"**: only the British `cancelled` was matched, so `canceled` / `aborted` / `rejected` — the very abort-shaped statuses `normalizeToolStatus` three lines above already treats as terminal — fell straight through both terminal guards and painted the completion boundary a real summarising earns; they now settle to silent-withdrawn exactly as `cancelled` already did.
- **A tab bar at its limit stops offering a new tab it cannot open**: at the cap the "+" was disabled and its tooltip said to close one first, but its accessible name stayed "Open a new tab", handing a screen-reader a press with no effect and no explanation — the disabled button now carries the same limit line the tooltip gives, while an under-limit "+" keeps the promise it can honour.
- **The elicitation's keyboard hint stops promising a key that does nothing**: a permission and an elicitation shared one hint, "Enter to choose · Esc leaves it unanswered", but only a permission opens on an option button where Enter chooses; an elicitation opens on a text field wired to no submit handler, so Enter there is dead — the banner now paints an elicitation-scoped "Esc leaves it unanswered", the shared key split into one the caller passes in.
- **A mode bar with one agent to name is not a button**: the chip kept a `role=button`, a slot in the tab order, a pointer cursor and a hover accent even with a single agent (or none yet) selected, where cycling can only return — a press that changed nothing, dressed as one that would; the operable attributes and the `.has-options` styling now follow the mode count (the base rule had also left that class dead, re-declaring a cursor the base already set), so a lone agent reads as a plain readout.
- **A whole-number field refuses to repair what it was told to reject**: a setting whose hint reads "Enter a whole number between {min} and {max}" accepted anything `parseInt` could salvage, flooring "4096.5" to 4096 and truncating "4096abc" to 4096 while the box kept showing the exact text it had just declared invalid — it now rejects anything not exactly an integer in range and leaves the stored value alone.
- **The MCP add-header button speaks the panel's language**: every neighbouring control in the request-headers block was localised — its add-variable sibling reads `labels.envAdd` — except this one hardcoded English "+ Add Header", so a Chinese settings pane carried a lone untranslated button; it now draws a proper `settings.mcp.headersAdd` key.
- **A slash-command badge keeps its colour across a language switch**: the badge minted its CSS class from its own translated label, so the `builtin`/`acp`/`custom`/`mcp`/`skill` buckets matched only an English UI and a Chinese reader's Builtin/Custom/Skill badges silently lost their colour while the text looked untouched; the badge now carries a locale-independent key, and a bare @-mention check-mark is a plain badge rather than the phantom `ac-badge-✓` class it used to draw.
- **A dashed thinking frame no element wears loses its rule**: `.co-ober-thinking` styled an outer container `thinkingBlockRenderer` never paints — it builds the wrapper as `.co-ober-thinking-block` and its parts as `.co-ober-thinking-header` / `-body` / `-label`, all still styled — so the dashed box was a rule reaching a class no DOM node had.

## 0.2.17 - 2026-09-29

No new capabilities. This release keeps a fresh turn, a later usage frame, and a filtered model list from reporting a figure or a name nobody handed them, stops a search line and a greyed pencil from offering an action nothing carries out, refuses a compaction its ending when the frame only said it failed, moves a list's accessible name onto the element that can answer to it, and takes the rules back off a diff card no code paints.

### Changed

- **A new turn that reports no usage carries no token total**: the per-turn figures were reset only where a report arrived, so a turn the agent answered without a usage frame opened on the previous turn's tokens — and divided them by the elapsed time to print a throughput that had never happened; the totals now clear the moment the turn starts.
- **The context meter re-reads a newer token count instead of keeping the first frame's**: a later report that carried a bigger total was dropped on the floor, so the meter held the opening figure and called it current while the conversation kept spending.
- **A usage row names no input or output figure it did not receive**: with the tokens still at zero the footer and its tooltip read "*Input: 0, Output: 0*", asserting two counts the report never gave — the parts that answered nothing are now left off entirely.
- **A grep match stops inviting a click it cannot honour**: nothing binds a pointer to a tool line, yet every search match was stamped *hoverable*, so the stylesheet drew a pointing-hand and a hover highlight promising an action no handler would ever take.
- **A disabled rename pencil says rename is unsupported**: an agent that cannot list sessions has nothing for the pencil to reach and the button sits greyed out, but its tooltip still read "Rename session" — promising the one thing the control could not carry, exactly the lie the fork and resume buttons already avoid.
- **The model bar names the model actually running**: the picker is narrowed to the reader's common list, and a session can be live on a tier that filter dropped, so against a filtered-out current the bar printed "Not set"; it now speaks the model's real name in both the immediate label and the locale repaint — naming a model is not offering it, so the dropdown still marks nothing chosen.
- **A failed or withdrawn compaction is not reported as compacted**: the case already guards against a terminal frame painting the "Compacted" boundary, but that guard sat behind the missing-id return, so a failure that carried no *compactionId* fell straight through and wrote the success note a real summarising earns — the status now reads before the id.
- **The session list's name sits where it can be heard**: "Session list" rode on the role-less popup that merely wraps the panel, and an *aria-label* on an element with no role names nothing — so the *listbox* the rows live in reached a screen reader with no label at all; it now names the listbox itself.
- **A diff card no code paints loses its rules**: `.co-ober-diff`, its cursor:pointer `.co-ober-diff-header`, a bare `.diff-stats` and a `.diff-path` styled a wrapper, a clickable header and two labels the renderers never mint — the tool header paints `tc-diff-stats` and the diff rows paint `co-ober-diff-body` and `diff-line`, all still styled.

## 0.2.16 - 2026-09-29

No new capabilities. This release stops a terminal wait, a permission, and a session summary from reporting an ending or a figure nobody gave it, backfills the one field an old server record was missing before it left the wire unnamed, keeps a time this client cannot read from dating itself to 1970, and takes back the colour a denial was offered without and the style rules no painted class reaches.

### Changed

- **A terminal wait that runs out reports the timeout, not an ending it never saw**: a shared deadline that expired handed back `{exitCode: null, signal: null}` — the pair 0.2.14 took off the kill path, meaning "it ended, with nothing to say otherwise", and printing no line at all — for a command nobody had watched finish; the timeout leaves the process alone and travels as a failure, since nothing in the wait response can say "still running" and an in-band answer would be the quieter lie.
- **A compaction boundary is pinned once, not toggled**: the started-compaction set was read as a flip, so the second patch frame withdrew the id and a third re-emitted the marker — two "Compacted" notes for a context summarised once, against this file's own rule that the boundary is set at the first frame.
- **`EISDIR` is no longer reported as a refused operation**: nothing was denied and the path the reader named does exist — it is a folder — so the errno files a sentence of its own pointing at the wrong kind of path rather than at permissions.
- **`/fork` is offered only once a tab has a session to fork**: the gate read the agent's capability while the run body still needs this tab's session id, and selecting a builtin writes its own line before running, so a bare tab got "/fork" entered for a command that returned without a word — the `/add-dir` rule, read across the session commands that share it.
- **A permission resolved elsewhere settles as nobody-answered**: it was being closed with the request's reject optionId, which the wire forwards as `{outcome: 'selected'}` whenever the agent offered that id — a choice no reader made that `outcomeFor`'s guard cannot catch, where this client's own dismiss contract already says an answer given on the user's behalf is "nobody answered".
- **A native session row that answered only some summary columns shows no badge**: each column is set on its own, so the missing ones were counts nobody read, and "0 files" contradicted the "+7" standing beside it.
- **A server saved before transports existed keeps its place on the wire**: the MCP list keys an entry off its type, so a command-bearing record carried through the migration with no type was handed to the agent unnamed and silently left off — listed in Settings as an enabled stdio server nothing ever started — and the loader now backfills that type onto the command shape while leaving a genuinely headless entry as it is.
- **A turn the loader could not date is left without a time**: a damaged epoch collapses to 0 and 0 is a perfectly readable date, so the exported transcript stamped "· Jan 1, 1970" onto a turn it had no time for; it now emits a bare role heading.
- **A native session row whose time cannot be read carries no time at all**: past the largest date a `Date` holds `toISOString()` threw and took the whole listing down, and 0 would have hung a 1970 date on a session the database never timed — so a non-positive, non-finite, or past-cap `time_updated` now yields no `updatedAt` rather than a wrong one or a missing list.
- **"Reject always" is coloured as the denial it is**: the banner paints a class per option kind, and only *reject once* had an error style, so an agent offering both handed over a red denial beside a plain-coloured one that had to be told apart by reading, not colour — both now share the one family.
- **Two states nothing paints lose their rules**: the tool-call status vocabulary is closed to *pending*, *running*, *completed*, *error*, so the `.status-blocked` border, its body accent, and its line in the no-border group styled a class no code applies, and `.co-ober-baked-footer` named a footer the renderer never emits while the class actually drawn was already styled.

## 0.2.15 - 2026-09-28

No new capabilities. This release keeps a figure honest when it is read back from storage rather than reported live, finishes the rule that a settled block says it has settled, and takes back the labels a locale switch, a bare tab, or a freshly opened panel still painted in a state that no longer held.

### Changed

- **A cost read back from the session database names no currency it never carried**: the native-usage path defaulted an unpriced amount to USD, so a resumed conversation advertised a dollar figure for money this client never saw priced — the same rule the message-derived path already keeps, at the one read that still broke it.
- **A tool call rebuilt from an evicted status settles to *pending*, not *completed***: the normalizer's own rule is that no missing status may fake completion, and one rebuild branch still contradicted it, stamping an outcome onto a card whose last real signal had been dropped.
- **A restored thinking block with no duration reads “Thought”, not “Thinking”**: a block that finished before this panel opened cannot advertise itself as still in progress, and the tense now holds whether or not the number that lets “for Ns” rebuild was ever recorded.
- **An interrupted answer re-speaks itself when the language changes**: the badge and its follow-up hint were written as words rather than keys, so a row frozen mid-turn kept announcing the language it happened to stop in; the separator between them sits outside both keyed spans.
- **A restored interrupt footer keeps its lowercase after a locale switch**: it was repainted in title case because the settled word was a bare string, not a key plus the casing marker every other lower-cased label already carries.
- **A failed reconnect stays named after a language change**: the button has three labels but only enabled/disabled to read them from, so a repaint flattened “Reconnect (failed)” back to a fresh offer — the retry it promises has already been tried.
- **The context meter re-speaks its tooltip and its “not reported” value on a locale switch**: an otherwise-Chinese transcript kept reading “Context:” in English, because the meter's wording was refreshed only when a new reading arrived.
- **`/add-dir` is offered only once a session exists to carry the directory**: its own body already refused without one, but the palette listed it anyway, so a bare tab could select it and press enter into a command that sent nothing — the gate now reads what `/model` reads.
- **A freshly opened panel shows the permission tier actually saved**: the toolbar is born on a hardcoded *safe* and only left it on a change or a refresh, so the chip named a tier nothing was running under until the first touch.
- **A tab that is generating while holding a queued turn keeps the working look**: the waiting-slot dim — faint ring, dimmed badge, faint number — is scoped away from a streaming tab, so it no longer paints a beating tab as standing by, agreeing with the name the last release gave it.

## 0.2.14 - 2026-09-28

No new capabilities. This release stops the commands we host from reporting an ending nobody saw, lets a tool card say only what its latest frame actually said, and takes back the figures — a currency, a meter reading, an operation tag — a shared surface asserted when nothing had named them.

### Changed

- **Asking a command to stop is no longer reported as its ending**: a SIGTERM the agent watched for answers as the exit that eventually arrived, rather than the `{exitCode: null, signal: null}` this client invented on its own behalf — a pair that prints no line at all, which made a command still running read back as one that finished quietly.
- **A wait ends when the output is finished, not when the process is gone**: a terminal or output read pulls the whole log, not the version whose tail was still in the pipe — the same move the agent's own stdio made.
- **Releasing a terminal answers the waits still held for it**, the way dispose already does, instead of leaving a caller parked on its own deadline for a terminal the manager had just said it released.
- **Killing a terminal we created but have no process for says nothing is left to stop**, rather than returning false and delivering "Terminal not found" for an id the agent was handed by this very client — its own documented contract always said only an id we never had answers that.
- **A command that refuses to spawn leaves no record behind**: writing the terminal before spawning meant a rejected start stayed listed as running, was counted by stop-all, and could never be released by anyone who had been given no id to release.
- **A patch frame replaces the snapshot it describes**: an agent that re-sends a finished output no longer shows that output twice, and a key it withdrew (an exit code it took back) no longer stays on the card as current — the content and raw input/output are set to what the latest frame says, not concatenated onto or spread underneath it.
- **A write/edit card stops declaring its own terminal state mid-stream**: it no longer stamps *completed*, empties the status glyph, or collapses the body a frame after the reader opened it to watch the text arrive — that look belongs to whoever sets the status.
- **A restored tool call with neither a status nor an error settles to a named "no result recorded" dash** rather than keeping the live ellipsis, so a conversation that stopped the moment it was written down does not advertise a command still running.
- **A thinking block the reader opened is left open** when the turn finalizes it — the reader's own toggle now outranks the auto-collapse, the ruling this round already made for tool cards.
- **A collapsible header that composes its announcement reads it off its own visible words**, so a locale switch and a programmatic collapse re-speak the aria-label in the language and expansion state now in force instead of the ones it was born in.
- **A side-chat turn that answers with tool calls only, or stops before any text, terminalises to "no text response"** rather than leaving the bubble saying "Thinking…" with nothing left to think.
- **A tab that is both generating and holding a queued turn is named "generating, more queued"** instead of only its wait, which had introduced a working tab as one standing by.
- **A cost reported without a currency is not dressed in "$"**: a bare amount names no currency, and a dollar sign asserted one the agent never chose (an unknown code still spells itself out, so a non-USD figure is never misread as dollars).
- **The context meter's dash stops announcing "0" to a screen reader**: the value read as "the window is empty" on the very frame that put "not reported" on screen; the meter goes value-less and names the state instead, handing the number back the moment a real reading arrives.
- **The patch operation chip reads the reader's language**: a Chinese UI was being told "UPDATE" beside a delete note it could read; the chip now carries the key so a locale switch re-speaks it, as the rest of the transcript already does.

## 0.2.13 - 2026-09-28

No new capabilities. This release takes back the names a shared surface borrows when nothing has reported one, shows each panel the state its own turn is in, and finishes the round where a change of language renames the words a screen reader hears too.

### Changed

- **The bar names only what this session spoke**: no model, no tier and no effort is named for a session that never reported one, since the bar is the prompt's own header and falling back to the first option claimed it as the setting the next send would go out under — a dropped agent, a session still introducing itself, or a locale switch mid-session all relabelled an untouched tier as *Default*.
- **Stepping back through the modes comes in at the end of the list** when nothing is named as current, the way stepping forward enters at its start, instead of landing one short of the wrap every other press performs.
- **A chip that resends nothing is not offered**: the way back into a question arrives on every failure that can actually be replayed — a rejected send and a timed-out one are the same reader-problem — and a turn with no retry path gets a plain error instead.
- **An inline edit answers from the messages this turn wrote**, so a failed send, a turn of tool calls alone, a leftover thought, or simply an earlier turn no longer has its reply offered as the diff for this selection and written into the editor on *Apply*.
- **Stop works during `session/new`**: the turn is claimed the moment the composer hands it over, so requiring a session id made the button a no-op for the whole handshake while the answer kept arriving underneath — and no cancel is sent for a session that does not exist yet.
- **Closing the last tab clears the shared surfaces**: the composer, send button and context arc lose the projection of a conversation that just stopped existing, which left a welcome screen whose bar still said *stop* and an arc still full of a context no longer there.
- **A reported zero is the reading it is**: the frame after a compaction empties the meter instead of leaving the figure from before it, which had been read as an absence.
- **Each message of a side-chat answer gets its own bubble**: the stream restarts its accumulated text at every new id, and pouring both halves into the one waiting bubble let the second overwrite the first with no trace of the gap; a failure that follows landed text is added below it rather than written over the words already said.
- **A referenced note is cut at the ceiling Settings holds now**, not the one the panel happened to open under, so the figure on the Settings screen and the figure the agent receives stop disagreeing.
- **The custom-agent row names only what will be attached**: an agent with a blank instruction or an unknown skill reference is dropped without a word, and a stored pick this build can no longer offer reads as *None* rather than naming a tier nothing will ever carry.
- **An exported transcript keeps the picture and the steps**: a turn that answered in tool calls alone came out as an empty header, and a screenshot left no trace in the note that was its point.
- **A side chat closed mid-answer stops painting what arrives after it is gone**, since the abort the close itself provokes re-entered code that needs a transcript to write into and threw.
- **Reconnect releases the queue a crash parked**, so the panel no longer reads *Connected* over a prompt waiting on a turn already dead — that drain sat inside a busy check the disconnect preceding it always clears.
- **A content search that could not run says so** in the line already written for it, instead of answering a locked database with the same silence as no matches.
- **The tool-card legend stops claiming a state nothing produces**, and the retry line an agent failure leaves behind names the way back out in the language being read.
- **Changing the language renames what a screen reader hears**: a completed tool card kept announcing the language it happened to finish in, and a finished or restored thinking block sat as "Thought for 12s" frozen in English in an otherwise Chinese transcript until the conversation was reloaded — both now carry the key that produced them, and the seconds the wording needs to be rebuilt.
- **The permission button stops telling a Chinese UI "yolo"** on hover: its tooltip named the internal id while the word beside it named the mode, and the mode is not a name the user chose but the tier the next tool call runs under.
- **An Escape that belonged to the input engine is left alone**: answering a permission question in the reader's own language no longer loses the whole question to the keystroke that discards a half-typed candidate.
- **A code fence anchors its own copy button**: with no containing block every fence in a long reply parked its button on the same corner of the message, so the reader could not tell which block the button copied.
- **The error action is drawn as a button, including while it is working** — it had no styling at all, so a pressed *retry* looked identical to an idle one and gave no sign that the second try it promised was running.

## 0.2.12 - 2026-09-28

No new capabilities. This release finishes the cards a stopped turn leaves behind, greets a restored pane with the state the agent is actually in, and stops the screen from moving out from under the reader.

### Changed

- **A stopped turn clears the card you were watching**: `finalize()` returned as soon as the buffer was empty, so it never reached the call that had already left the buffer and gone on screen — which kept spinning on a turn no agent would ever finish.
- **An unfinished call comes back interrupted**: a transcript carrying a call that never reached a terminal state — the turn was stopped, or the process died mid-tool — restores into the same failed look a live interruption produces, instead of running a spinner forever on a conversation that cannot update again. The reason is chosen at paint time, so `data.json` keeps no localized copy of it and a stored tool error keeps its own words.
- **A completed answer replaces the streamed one**: the body of a finished call is swapped out rather than stacked, so the text on screen is what the tool last said and not every partial it sent.
- **A card you opened stays open**: closing it when its call finished threw away the thing the reader had reached for; a card nobody touched still settles itself.
- **One step, one card — even when the frame is late**: a frame arriving after its card was drawn is routed onto that card instead of being buffered and flushed a second time under the same id, which left two cards where one step ran and made only the newest copy writable. An out-of-order frame can no longer reopen a card that had already finished.
- **A turn of nothing but tool calls survives a reload**: it is persisted, and a card that surfaced after its answer was written is attached to that answer rather than dropped.
- **A card closes the bubble it interrupts**: text after a tool card now starts its own bubble instead of appending beneath it.
- **Running looks like running the moment it starts**: the spinner appears with the card rather than on its next frame, which for a short call is never; a queued call gets its own faint static mark against running's accent spinner, so a step waiting to run is no longer indistinguishable from one that finished quietly, and every status mark carries the state it depicts as its `aria-label` and `title`.
- **An empty result is a result**: a bash call that returned nothing says so, instead of leaving a blank card for the reader to decide the meaning of. Status and icon classes are cleared before each repaint too, so a card that went from running to failed no longer keeps the spin animation of a state it left.
- **Connected means the handshake answered**: a client object is held across a dropped handshake, and the check this used to make called that *Connected* — sending the reader into a composer whose every send was about to fail. The login hint the agent reports over its handshake is withheld until the handshake reports in, and the status line writes the span inside it rather than moving the words out from under the rule that colours it.
- **Every restored tab is handed the connection state**, not only the one in front, so a background runtime no longer answers a failed send with the connection having been lost on a connection that never broke.
- **The conversation you already have paints first**: a tab rebuilt from a saved shell draws the transcript this plugin holds before any read of the agent's own files is attempted, and repaints only when that read brought figures the snapshot lacked — three sequential disk reads, or one that threw, used to stand between the reader and their conversation, and a conversation missing its cost lines is still whole.
- **A paint that fails says so where the reader is looking** and leaves the tab retryable, instead of rejecting into the rest of the pane's startup (welcome, keybindings, drag and drop) and blanking the tab for good. The in-flight marker is raised before the first `await`, so clicking through the strip twice in one breath does not start the same read — and the same panel reset — twice.
- **Dropping the agent takes the affordances with it**: the image attach control goes away with the models and modes, no effort tier is named as the current one, and the tab strip is told, which otherwise kept lighting a generating dot for turns that ended seconds ago.
- **Moving an option in Settings reaches the open pane** through its own reload entry point rather than a method the view never had, so a chat bar stops offering the list from before the save.
- **The bar names as chosen only what this session reported**: falling back to the saved default dressed a value the agent never confirmed — including one it may have overridden mid-run — in the look of the tier the next prompt would actually send.
- **A tab strip that has not changed is left alone**: rebuilding empties the strip, which took the caret with it, restarted the generating pulse from zero and dropped the place the reader had scrolled to — all on a turn boundary, or a background tab's frame, with nothing about the strip changed. A repaint still happens when one is owed, and the caret goes back to the exact badge or close button it was lifted from.
- **A turn that finishes leaves the reader's selection alone**: the composer asked for the caret unconditionally, which pulled a mid-drag selection out from under the mouse the moment the agent stopped speaking; it asks only when nothing holds it — caret on a copy button, an expanded step, or text being dragged. An expanded thinking block likewise stops re-formatting itself under a live selection, which used to collapse the drag and hand the copy buffer the wrong words.
- **The context meter gives one answer to every sense**: a figure the agent never reported is a dash rather than a 0% window it did not describe; the detail behind the percentage, which used to arrive only on hover, is reachable with the keyboard; and the *approaching limit* line arrives on the same reading that turns the arc orange instead of a second hardcoded 80 that disagreed with the colour.
- **A plan that could not be read says so**: a resync that got no answer from the agent leaves a note on the panel, rather than yesterday's checklist standing under today's answer, checked off like a plan still being followed — and the resync that threw logs why instead of swallowing its own error and stopping the panel mid-turn with no trace.
- **Reduced motion reaches the spinners**: the whole block sat among the tab styles, and a media query adds no specificity, so it lost every tie against the spinners declared after it and the setting looked like it did nothing. It is deliberately the last thing in the stylesheet now, covering the tool card, the thinking dots, the critical arc and the new-messages button, and leaving each of them visible once it stops moving. Alongside it, a `.co-ober-tool-status` block no code ever painted is gone, and the permission banner's origin chip — which the code makes a button that moves focus to the tab that asked — is finally styled as one, with a pointer, a hover and a caret a keyboard reader can see arrive.
- **`waitForClient()` is removed**: no caller reached it, and it resolved `true` for a connection that had since been torn down.

## 0.2.11 - 2026-09-28

No new capabilities. This release refuses a store that would load as half of itself, tells the agent when its pipe is gone, and draws one card per tool call instead of one per frame.

### Changed
- **A session id listed twice is a damaged store**: a `data.json` whose session list names the same id twice no longer loads as the smaller conversation it collapses into — `hydrate()` writes both records to the same `Map` key, so the later one won, the load reported success, restore-from-backup never ran, and the transcript the reader expected vanished from the screen and from the next autosave with the only reversible moment already behind it. This build cannot emit that shape, so the load fails instead; the rolling backup applies the same gate to itself, since promoting a copy whose records merge would fail the very next load and leave the file it set aside as the only bytes remaining.
- **Two things added at once are two things**: an id minted from a bare `Date.now()` gave two custom agents (or skills) created in the same millisecond one shared id, and because every delete handler filters by id, removing either silently removed both. The collision check now reads the ids as they are actually stored, keeping the `agent-`/`skill-` spelling a convention rather than a second source of truth.
- **A command file in the format its own header documents parses**: `hooks:` on one line with `pre: ["echo starting"]` indented under it spun the nested-mapping loop re-reading the same line forever, which froze Obsidian outright because the scan runs on the main thread during vault load; the cursor now advances past the line it consumed.
- **A command that lost a name fight is named**: two command files sharing a basename — which the popover shows as one entry however deep the tree puts them — resolve to the shallowest path instead of whichever file the vault happened to enumerate first, and the loser is called out in a notice, so which template reaches the agent is a property of the user's directory and not a coin toss.
- **An export cuts after the glyph, not through it**: exporting a chat whose 80th character is the first half of a surrogate pair — an emoji, most CJK outside the BMP — no longer writes a filename ending in a lone high surrogate, which is a note name nothing can be read back from. The orphan glyph goes, not the ceiling.
- **A dead pipe says so**: only the process going away was ever wired, so a JSON-RPC transport that closed on its own left `connected` true, *Send* lit and the banner still promising an answer, with no reconnect scheduled. The pipe closing now shuts the child down with it, and both ways a connection ends run through one shared tail, so a report no longer depends on which of the two died.
- **The commands a session arrives with get walked**: the `availableCommands` carried by a `session/new` or `session/load` answer is parsed by the same parser a notification already used, so a command frame with no name stops reaching `command.name.trim()` from inside the code that runs the moment the session was created and leaving the agent's session orphaned and unheard — and the description that parser asked for is now the optional thing the wire says it is, because requiring it deleted named commands the slash menu could still run.
- **A prompt with no result is a finished turn**: a turn whose result was absent, or JSON `null`, answers as the completed turn it actually is rather than an invalid-response failure that threw the agent's text away.
- **Closing the terminal tier closes its doors**: `terminal/output` and `terminal/wait_for_exit` are refused while the tier is shut, since the create was gated but the manager the switch left behind kept handing the agent the buffer of work permission had just been withdrawn for — while `kill` and `release` stay open, because closing the door is not locking it on the way out, and the reader keeps their own view of a card already on screen.
- **A frame that only says the mode changed says nothing about models**: a mode or model list the frame never mentioned is carried as absent rather than as the empty list it is not, which used to blank the tab's selector on a turn that had no intention of touching it.
- **A byte ceiling this build cannot**: a `maxNoteSize` of zero or below, arriving from a `data.json` this build did not write, keeps the ceiling already in force — the first reads every note as empty, the second hands the buffer a length no buffer has.
- **One tool call, one card**: an agent walks the same call through `pending` and then one `in_progress` after another, and pushing every frame onto the buffer drew a card per frame at the flush — the earlier copies stayed on screen frozen at whatever status they were buffered with, and each became its own content block, which is how the duplicates survived a reload. Buffering is by `toolCallId` now.
- **A card remembers what kind of call it is**: the kind the card was created with is held on its state and stamped on the attribute the locale repaint reads back, rather than recovered from the label the reader was shown — so a card whose kind changed mid-flight no longer comes back wearing its old name the next time the language is switched.
- **The welcome page gets out of the way of the transcript**: it is a sibling of the transcript, not a layer underneath it, so a tab that came here empty and had a history restored kept showing the shortcuts through it. It is now retired for the tab in front — and only that tab, since hiding it for a background restore would take it away from whoever is looking at an empty panel.
- **A turn that timed out, or lost its process, says which**: the bare error sentence is replaced with one the reader can act on, keeping the *retry* and *restart* affordances it always had.
- **Reconnect reaches the agent, not just the client**: pressing *Reconnect* in Settings goes through an open panel's own handler instead of swapping the client object out from under a panel still bound to the one it started with — which left every open tab's *Send* dead, its parked queues, lost sessions and toolbar un-refreshed, until the panel happened to be reopened. With no panel open there is no bound handler to re-point, so the old path still serves it.
- **A keyboard activation keeps the caret**: activating a tab with *Enter* leaves the focus on the badge the strip rebuilt rather than dropping it onto the document, where the next arrow key reached nothing.
- **The session search keeps its caret**: a pin toggle, or the native list simply arriving, rebuilt the dropdown out from under the box the reader was typing into — the text stayed visible while every keystroke after it went nowhere and the panel looked frozen.
- **A tab waiting for the shared slot looks like it**: the `is-queued` class had been applied long before any rule read it, so a parked tab looked exactly like an idle one while its own tooltip promised a slot. A dimmed badge with a faint ring now says *not started*, where the solid accent ring of an unread tab says *done and unseen*.
- **Two strings nothing says**: the dead `error.timeout` and `error.processExit` labels are removed from both locales, alongside the `error.timedOut`, `error.processExited` and `acp.processExited` strings that are still live.

## 0.2.10 - 2026-09-27

No new capabilities. This release refuses a store that would load as nothing, answers the agent with the config options and the parameter error it should have received, and leaves a stopped turn with nothing still spinning behind it.

### Changed
- **The smallest message cap still keeps an answer**: a limit of one no longer spends its single slot on the truncation marker, so the newest turn — the answer being read — stays on disk instead of being replaced by a line saying how many messages were dropped.
- **A session list that yields no sessions is a failed load**: a `data.json` this build stamped whose list names conversations but produces none after migration is told apart from an intentionally empty history and routed to restore-from-backup, rather than hydrating as an empty plugin that restamps and buries the bytes; the rolling backup applies the same gate to itself, so a copy that would only fail again is never written over the live file.
- **A save-failure toast cannot outlive its plugin**: the sticky notice is retired when the plugin is torn down, since a duration-0 toast survives its instance and a reload holds no reference to hide it — leaving the reader accused of a failing disk for a session that will never write again.
- **A command from a file remembers the line you typed**: an expanded slash command now records the prompt as typed, in the tab it was typed in and in the transcript that reaches disk, the way a builtin command always has — no more answer with no question above it and nothing left behind by a reload.
- **The config options a session answers with get walked**: `session/new` and `set_config_option` responses are parsed by the same parser a notification already used, so a grouped model list or an option-less toggle no longer arrives unwalked at the toolbar — and no longer throws from inside the code that runs immediately after the session was created.
- **A command this client refuses says why**: a blank invocation, or one off the allowlist, answers as the invalid-params it is rather than an internal error, so an agent stops spending the rest of its turn retrying a command that will never be accepted.
- **A whole-file read cuts on a character too**: the byte ceiling for an entire note is clipped to a whole character the way the line-window branch already did, so the note an agent reads back never ends in a glyph no file ever contained.
- **The note size reaches the tiers where reads still happen**: `maxNoteSize` is carried through the *readonly* and *plan* tiers instead of leaving the delegate on whatever ceiling was current the last time that tier was up.
- **A ceiling of nothing is not a ceiling**: a zero or negative terminal timeout and output size are refused rather than honoured — the first answers every wait instantly, the second makes every command appear to print nothing.
- **Closing the terminal stops the work it was guarding**: a running command is killed the moment the terminal surface closes, so nothing keeps executing against the user's vault after they withdrew permission for it.
- **A stop leaves no spinner, no banner, no dot**: stopping a turn retires the permission question that turn was asking, takes the waiting bubble away with the `finally` the generation bump skipped, and tells the tab strip the tab stopped working — and only that session's banner goes, since a `/btw` thread of the same tab still holds its own question the reader never cancelled.
- **A turn that never started is not unread**: a turn that lost the shared-slot race and went back into the queue no longer lights the unread dot, so the reader is not sent to a panel whose answer had not begun.
- **The image budget belongs to the tab**: the staged-byte total is handed over with the composer when a tab comes forward, instead of being carried across tabs by one shared counter that made the tab you entered pay for the attachments of the tab you left — and let a chip removed there drive the budget negative and admit anything.
- **The chat bar shows the tier Settings just moved**: changing *Permission Mode* re-projects the tier onto the open chat view's own selector, which previously re-read the setting only when a tab was activated and so kept naming a tier no longer in force.

## 0.2.9 - 2026-09-27

No new capabilities. This release keeps a damaged store from being read as an empty one, answers the protocol with the ceiling and the hangs-up call it should have sent, and puts the shared screens back in the state of the tab you are actually looking at.

### Changed
- **A file that lost everything is not a fresh install**: the stamped-file guard moved ahead of the new-install branch, so a `data.json` that lost its settings, session list and active pointer together is told apart from a genuinely first run and routed to restore-from-backup instead of hydrating as an empty plugin whose bytes the next autosave overwrites.
- **The backup is judged by what a load would keep**: the backup guard now counts only the sessions a loader would actually hold on to, so a parseable id-list can no longer read as a populated store and replace the copy that still holds the real conversations.
- **A timestamp that cannot render cannot survive**: session and message timestamps must be finite numbers inside `Date`'s range to pass migration, ending the value that threw on every list render while retention refused to prune it.
- **Giving up on a stalled load hangs it up**: the idle deadline on a bounded `session/load` now aborts the request it gave up on, so an abandoned load stops sitting on the connection for its whole life — answering the reader's retry as a ghost and settling a promise nobody routes any more.
- **A handler that returns nothing answers explicitly**: a listener with nothing to give back is answered with a `null` result, because JSON drops an `undefined` value and leaves the frame carrying neither result nor error — an answer a good agent reads as malformed and waits on.
- **The terminal ceiling counts bytes, and cuts on a character line**: output is bounded by `Buffer.byteLength` rather than string length, ending the CJK log that fed an agent close to triple what it declared it would bound its own context with, and the trimmed tail no longer starts between characters, so no replacement glyph or lone surrogate reaches the transcript.
- **A lost connection finishes the thought everywhere**: a connection that dies mid-thought closes the live thinking block in every tab, not only the ones a turn's own `finally` reaches, so a tab visited later shows a finished thought instead of a timer still counting on an answer that died.
- **The composer reports the tab you arrived in**: entering a tab re-projects its own streaming state onto the shared composer and toolbar, so a turn started in the background no longer leaves the panel an answer is arriving in offering *send* while hiding *stop*.
- **A tool call reported only as finished still gets its card**: an agent that sends no `pending` or `in_progress` frame before the completed one now has the card made at that moment instead of an update with nothing to write into, which dropped the step from the live transcript and from the blocks a later reload renders.
- **A capability dropdown cannot outvote the permission tier**: the file-system and terminal mode dropdowns push through the tier rather than around it, so picking *read & write* under *readonly* or *plan* is remembered but cannot open the write or command surface that tier exists to shut.
- **A placeholder inside an argument stays a placeholder**: template expansion is one pass instead of two sequential replaces, so a `$3` the user typed as part of their own argument is no longer rewritten after `$ARGUMENTS` had landed — a silent edit to what the command sent to the agent.
- **The slash command you typed is drawn once**: the dead `/help` echo is removed, since the send path already paints and stores the command the user typed, which left that prompt on screen twice.

## 0.2.8 - 2026-09-27

No new capabilities. This release keeps a bad save from eating the copy it was made to protect, answers a dying connection and a genuinely missing file with the reason an agent can act on, and lets no background operation move the screen the reader is looking at.

### Changed
- **A corrupt save cannot be promoted over the copy that still reads**: a `data.json` that real Obsidian swallowed a parse error on is told apart from a genuinely absent file and routed to restore-from-backup rather than loaded as defaults the next autosave would overwrite; a file this build stamps that lost its session list entirely (not only a malformed one) counts as a load failure; a save whose outcome handler itself throws still resolves, so the never-rejects save API holds; and a rolling backup is promoted only when it would actually parse and load.
- **Retention and migration stop reading a damaged store as empty**: a migration-repaired session whose `updatedAt` is `0` is spared rather than deleted as if from 1970; a non-string image payload — the value that turned the persisted byte total into `NaN` and purged every image, pinned ones included — is measured as zero bytes and dropped at the migration boundary along with non-object `contentBlocks`/`images` entries; and the auto-connect legacy default now applies only to genuinely pre-schema data, so a present-but-unreadable `schemaVersion` no longer flips a stored *false*.
- **A closing connection reports what actually closed it**: disposing the transport rejects every still-pending request with the real close reason instead of firing each request's abort handler first and burying it under a generic *aborted*, so a caller can still tell a dying connection apart from a user cancel; a request answered before its deadline lets go of the listener it attached to a signal the agent reuses for the next turn, ending the per-request leak; and a terminal manager being disposed resolves every pending `wait_for_exit` as *no exit observed* rather than stranding the caller until their own deadline.
- **An empty response is the result, not a hang**: a frame carrying an id but no method, result or error settles as the empty result the agent gave rather than waiting out its own timeout.
- **A file that is really gone says so, and one that only was refused says that**: a file-system read answers `-32002` only when the file genuinely is not there, so a path outside the vault, a directory or an I/O failure no longer reads back to the agent as *not found* and stop it reacting to what actually failed.
- **Creation is not activation**: ensuring a session exists no longer moves the active conversation onto it, so a replay this client adopts for another tab and a background stream that merely needs a place to write stop pulling the pointer off what the reader is looking at — activation stays the caller's explicit choice, exactly as the every-answer-belongs-to-its-tab round intended.
- **A saved tab strip cannot outlive its cap**: restoring yesterday's tabs clamps to the configured open-tab limit, so a list that outlived its cap — the limit was lowered, or `data.json` was edited by hand — opens no more panels than every user-facing open path refuses to, and a front tab dropped by the clamp falls back to the first kept panel instead of selecting a tab that was never made.
- **A native id means the agent's own id**: the replay collector stops writing a client-minted token (the anonymous `#anon-N` a missing message id got, the `compaction|N` boundary key) into `nativeMessageId`, keeping that field meaning an id the agent actually sent and denying cost/usage matching a token no agent will echo back on a later load; and the dead `error.compact` label, which no code path ever rendered, is removed from both locales alongside the compaction strings the client does show.
- **A debounced shell save cannot crash past its caller**: the tab-shell write scheduled on the transcript's debounce window re-checks that the view still exists before running (a save already armed just before close no longer fires into a disposed controller), and it wraps the store call so a `save` that hands back no promise is settled rather than reached into for `.catch` — the throw that escaped the caller as an unhandled error, failing an otherwise-green run on a defect that was never in the code under test.

## 0.2.7 - 2026-09-27

No new capabilities. This release keeps every answer in the tab that asked it, answers the protocol closer to the frames it actually accepts, and refuses to let a bad write or a nonsense setting eat what was already there.

### Changed
- **A turn belongs to the tab that started it**: a disposed view stops re-binding handlers and a closing view takes its permission and elicitation handlers back so nothing answers in a gone tab's name, closing a tab releases the agent session it owned (and only once the sibling sharing it is gone too), a turn that outlives its tab is released rather than resurrected, and a background turn no longer rewrites the conversation pointer on the screen in front.
- **Reconnect settles where it belongs**: reconnect and disconnect resolve the interrupted turn inside each owning tab, a sessionless tab loads an empty toolbar snapshot instead of the active tab's models, a background tab's toolbar write-back stays in its own state, and a capacity-parked queue drains once even under two simultaneous releases.
- **The protocol shapes this client honors**: `session/set_config_option` sends the type the agent declared, so a boolean option stays a boolean instead of being pasted as the string *true*; prompt parts are copied down to only the fields the content schema defines, so a local label or internal id cannot poison the frame; and an MCP transport the agent never affirmed is disabled in the picker instead of offered and rejected on connect.
- **An error the agent can branch on**: cancelling a turn resolves the permission still open on that screen as *cancelled* rather than leaving a banner that outlives its stream, a capability surface the reader closed mid-session answers `-32601` (method not found) instead of the `auth_required` code that sent a good agent off to log in, and a terminal the manager no longer has answers `-32002` (resource not found) while a malformed frame keeps `-32602`.
- **A save cannot lose what the backup still holds**: a save that wrote no conversations against a backup that still has them is refused rather than promoted, and a stored session list that is present but not a list is treated as a load failure that restores from the rolling backup instead of writing over the good bytes.
- **Retention runs on a copy**: retention, truncation and the stored-image budget now apply to a private snapshot of the store, so no transcript on screen is rewritten under the reader, and a nonsense `retentionDays` or `maxMessages` (zero, negative, `NaN`) is floored rather than trusted — one bad value used to delete every closed conversation in a single save.
- **A tab switch and a typed draft reach the disk**: the tab shell and the half-typed message riding on it are written on the same debounced save the transcript stream uses, so they arrive in `data.json` without waiting for a chat turn, and a session rotation closes and rekeys inside the mutex so the agent sees one create, not a race.
- **The strings say what the code does**: the Readonly and Plan permission labels now describe what actually happens — Readonly auto-approves reads, searches *and fetches* and rejects writes and execution; Plan approves only reads and searches and rejects the rest — in English and Chinese.

### Fixed
- **A sync rule will not overwrite what it cannot read**: a rule whose note it cannot read refuses the write and records the failure, instead of quietly eating the reader's own edits over a file it never looked inside.
- **A rule added in the same moment gets its own id**: an MCP server or sync rule created in the same millisecond as another is given a collision-free id rather than overwriting its twin.
- **A cleared composer still reports itself**: a turn that throws after the input box has already emptied paints its reason in the tab that sent it, instead of vanishing as an unhandled rejection that leaves a blank box and no reply.
- **A terminal that already stopped is not an error**: killing a terminal that has already exited returns the success the agent wanted, and a `wait_for_exit` deadline that passes leaves the command running instead of sending it a `SIGTERM` it never asked for.

## 0.2.6 - 2026-09-26

No new capabilities. This release keeps what was already written, answers the protocol closer to the shape it arrives in, and makes the client own the things it claimed.

### Changed
- **A restart does not eat the paragraph**: an unsent draft travels with the tab shell it was typed in and comes back with it, so a parked conversation is not a lost one.
- **A data file from the future is refused, not rewritten**: a schema version newer than this build is left alone instead of being read as `0` and saved over. Each successful save leaves a rolling `data.json.bak`, and a corrupt `data.json` is repaired from it with the damaged copy set aside rather than replaced by defaults.
- **Half-written settings are caught at the door**: every typed field is checked when data loads, so one truncated value can no longer poison the sync rules or the permission tier.
- **An edit that moved is refused**: an inline edit remembers the exact range it was asked for and will not Apply once those characters have shifted underneath it.
- **The protocol shapes this client honors**: `terminal/create` takes the `env` list as the `{name, value}` pairs actually sent and treats the agent's own `outputByteLimit` as a real ceiling; a request this client could not read answers `-32602` naming the field that failed (rather than `-32000`, which tells a good agent to go log in); `rawInput`/`rawOutput` carry any JSON, so a tool that answered with a string keeps its frame; and a boolean config option stays a boolean instead of becoming the model named *true*.
- **A closed tab stops speaking for itself**: closing a tab answers its queued and visible prompts in that tab's name, a disposed view no longer re-binds handlers, reconnects or reclaims the screen, and a renewed session settles in the tab that asked for it.
- **The strings say what the code does**: Auto Connect, custom instructions, the system-prompt setting, session retention, the capability tiers, the idle timeout and the reconnect hint are rewritten in English and Chinese to match what actually happens, and the settings rows and README lines that advertised what nothing reads — compaction markers, per-agent model and mode defaults — are gone.

### Fixed
- **A turn cut off by a lost connection admits it**: the tab whose reply was in flight says the reply was not completed, on the screen that turn belongs to, instead of leaving a half answer looking finished.
- **A parked turn keeps its shape**: a run parked for stream capacity keeps its inline edit and its already-painted bubble, and a manual reconnect drains it; `/compact` waits behind a pending permission banner instead of talking over it.
- **A command that never started says why**: a spawn failure writes its reason into the output the agent reads back and settles whoever was waiting with a null exit code, rather than looking like a command that ran and exited cleanly.
- **A slash command that vanishes names itself**: a command file that cannot be read and a file with no frontmatter each report themselves once per distinct set — with a count when the list runs long — instead of disappearing from the `/` popover as a plugin bug.
- **Defaults the agent declined are reported, not fatal**: a session still opens when the mode, model or thinking-effort request is refused, and the transcript names what did not land.
- **An agent that never asked for images is not sent one**: a client that reported capabilities without naming image support no longer receives an image part, and a notice that arrives with nothing to say counts itself among that tab's dropped frames.

## 0.2.5 - 2026-09-26

No new capabilities. This release keeps what the reader already typed, reads the protocol closer to the way it is written, and says its failures in sentences rather than in stack traces.

### Changed
- **An open tab is not a discardable buffer**: transcript retention exempts every tab that is still open, and the pending-image budget gives up the chats nobody has in front of them before it touches the one being read — a conversation you can see no longer gets emptied to make room for another.
- **A banner that blocks a send keeps the paragraph**: refusing an input returns before the textarea is cleared, so the text is still there to fix, and a queued run whose tab turns parked mid-drain is put back whole instead of losing its head.
- **Unreadable references answer in the tab that asked**: a note reference that could not be read reports itself to the conversation that requested it, not to whichever one is on screen.
- **Grouped config options arrive**: an agent that nests its choices under groups has those groups flattened into the model and mode dropdowns with the group folded into the label, instead of the options being dropped on the floor.
- **A line range is honored**: `fs/read_text_file` reads `line` and `limit` rather than returning the whole file and calling it a day, and the byte cap is applied to the window that was asked for.
- **Terminal failures are failures**: `terminal/*` that cannot do the job answers with a JSON-RPC error the agent can branch on, instead of an in-band `{error}` object that looks like a successful call with strange content.
- **A resume is judged by silence**: `session/resume` uses the same idle deadline as a load, so a session replaying a long history is measured by whether it is still talking rather than by a fixed window — and each replayed update resets the clock.
- **An error reads like a sentence**: timeouts name the method and the window, a conversation that went away on the agent side says so, a dead process reports its exit status, and anything unrecognized is kept verbatim behind a label, so translating the message never costs the detail needed to report the bug.
- **README matches the client**: the offline agent list drops a mode nothing could ever start, and the settings and shortcut tables gain the `Alt + 1..9` tab switching, Default Thinking Effort and Max Open Tabs that were already there.

### Fixed
- **A sync rule pinned to one path says that it replaced the note**, and stays quiet when the note already held exactly what was written; a body that outgrows the vault is clipped with a marker instead of written whole.
- **A dropped image that will not read reports itself**: every other branch of the drop path announced what happened, so a failed read looked like a successful attachment.
- **One bad element no longer takes the list with it**: `availableCommands` keeps the commands that parsed, and the first frame of a tool call keeps its `rawOutput` so the card can show what came back.
- **A synchronous handler that throws still gets an id**: the reply is sent instead of leaving the agent waiting on a request that already failed.
- **Listeners leave with the surface that owned them**: the image lightbox detaches its keydown from the document that was given it and closes when the view closes, and the toolbar listens for outside clicks on its own document and stops listening once it is disposed.

## 0.2.4 - 2026-09-26

No new capabilities. This release puts up the second wall the code said was there, and stops discarding work the protocol allowed us to keep.

### Changed
- **`plan` and `readonly` now mean what they said**: both close this client's own mutating surfaces — file writes and command execution — no matter what the capability settings allow, where previously only `readonly` did and `plan` silently deferred to them.
- **A change made without asking is recorded where it happened**: an `fs/write_text_file` or `terminal/create` this client carries out on the agent's word — which never has to ask permission to make it — writes the path or the command line into the transcript of the tab whose agent did it, and the terminal manager's comment now describes what actually gates it.
- **The permission banner works from the keyboard**: focus lands on the first option when a prompt appears, Esc answers the prompt instead of being swallowed by "stop the stream" (the agent is told nobody answered, which no reject button claims), and a tab sitting on a pending prompt holds new messages out of its queue until it is decided.
- **What belongs to a tab stays in that tab**: unreadable permission and elicitation reports, elicitation refusals and reconnect failures are painted into the conversation they name rather than whichever one is on screen, and a connection lost with several tabs open marks each one that had a session.

### Fixed
- **Frames the protocol allows no longer fail our own parser**: the SDK requires only `content` on a message chunk, so chunks that arrive without a `messageId` are grouped under a stable synthetic id and stream as they should, and a single unrecognized config option now drops itself instead of taking the whole model list with it.
- **Frames with nowhere to go are counted**: an update that normalized fine but lost its stream — including the closing frames that arrive just after you press Stop — adds to that tab's "frames not rendered" note rather than vanishing.
- **A subprocess that dies is reported as dead**: a teardown that throws now still announces the loss and schedules the reconnect, instead of leaving the Send button lit for a process that no longer exists.
- **Stop survives a reload**: the *Interrupted* badge is written into the stored answer, so a half reply no longer comes back looking like one the model finished on purpose.
- **An inline edit is answered by the turn that asked for it**: the selection is claimed by its own tab, waits in that tab's queue with its editor if the turn has to wait, refuses to merge with a plain prompt or dissolve into the composer — and the preview diff now actually appears, where the state was cleared before the reply was read.
- **A fork owns its transcript**: branching copies message blocks instead of sharing them, so a tool call settling in one conversation cannot rewrite the other one's record.
- **The context meter follows the tab**: switching tabs re-projects that conversation's token numbers instead of leaving the previous tab's on the arc.
- **README stops misreporting itself**: the Obsidian floor matches the manifest, Auto Connect's real default is stated, and the permission tiers are described as four — with the two that override the capability settings named.

## 0.2.3 - 2026-09-26

No new capabilities — this release is about telling the truth: what Co-Ober advertised to the agent, what it answered back, what it drew and what it claims it did.

### Added
- **Elicitations are answered instead of invented**: when an agent asks for input, the common cases become real form fields you can fill, a link-mode ask shows the link it wants you to open, an ask with nothing to fill is treated as a confirmation, and anything Co-Ober cannot present is declined or cancelled out loud — where every ask used to come back as an empty accept the agent read as consent.
- **Settings beyond model and mode reach the toolbar**: config options an agent exposes that are neither model, mode nor effort now appear as keyboard-operable chips that write back through `session/set_config_option`, instead of being stored where nothing could show them.
- **The negotiated protocol version is visible**: when the agent speaks a different ACP version than Co-Ober expected, every open tab carries a dismissible note saying so, rather than the mismatch existing only in a console nobody opens.

### Changed
- **What we advertise is what we honor**: the permission tier you stored now reaches the request handler before `initialize` announces our filesystem and terminal capabilities, so the agent is never promised a write path that will be refused, and nested capability groups are no longer silently dropped while parsing.
- **Tool cards say what they could not draw**: image content inside a tool result is rendered when it survives parsing, and a content item Co-Ober cannot show is named in the card instead of vanishing and leaving text it was standing next to erased with it. Frames that could not be drawn — compaction summaries included — count toward the tab's dropped-frame note.
- **A copy button only says "Copied" once the clipboard took it**: transcript and message copies wait for the write and report failure when it fails, and a save that would not survive a restart no longer passes silently.
- **Deleting a sync rule stops its notes**: the engine reads the current rule list at the moment it works, so a rule removed mid-session cannot keep writing files.
- **Disconnect withdraws what the dead agent reported**: models, modes and config chips leave the toolbar with the connection, and the client's handlers are unbound when the view closes, so nothing keeps reporting for an agent that is gone.

### Fixed
- **Per-session metadata dies with its session**: commands, models and config options an agent reported are dropped when that session closes and when the connection goes away, instead of being read back against the next agent to answer.
- **Frame-drop warnings restart per connection**: a warning that already fired in one connection no longer silences the next one's drift.
- **Locale keys nothing renders are gone**.

## 0.2.2 - 2026-09-25

Everything here is on our side of the wire: each tab is made to speak only for itself, and a conversation is made to say what it could not do.

### Added
- **Composer drafts survive a restart**: the text you were typing and the note references inside it come back in the tab that holds them. Images are the exception — a restart never brings their bytes back — so a draft that carried them says how many it left behind instead of quietly returning half a message.
- **Terminal cards show their output**: when the agent asks Co-Ober to host a terminal, the frame that follows reads that process back and paints its output, what was trimmed from it and how it ended — by a signal, or by a nonzero exit — where the card used to say the content was unsupported.
- **A conversation that did not reach the disk says so**: when saving a transcript fails, the tab it belongs to marks the failure once per streak, so you know what a restart would lose rather than assuming the words were kept.

### Changed
- **Every tab speaks for itself**: the `/btw` scratch thread belongs to the tab that forked it, so closing that tab releases the session instead of leaving it live on the agent side; resetting a background tab no longer tears down the thread on screen, and switching tabs hides a thread rather than closing it.
- **A slash command runs where it was admitted**: a command drained out of a queue can no longer switch another tab's model, clear another tab's transcript or greet the user with another tab's welcome screen — and a command whose tab has gone runs nowhere at all.
- **The agent's own input hints reach the slash menu**: the hint an agent attaches to its command now surfaces as its argument hint instead of being stripped while the frame was parsed.

### Fixed
- **Frames that could not be drawn are counted where they were lost**: malformed, unrenderable and unrouted update frames now add a line in their own tab saying how many frames of this conversation Co-Ober failed to render, and the count clears with the transcript it belongs to.

## 0.2.1 - 2026-09-25

No new capabilities — this release levels the ground that 0.2.0's tabs stood on, so moving between conversations stops costing you anything.

### Changed
- **Auto-scroll describes the surface, not one conversation**: the setting now applies to every open tab and to tabs opened later, instead of only the one in view when you flipped it.
- **`/clear` really clears**: the tab hands itself to the same reset path a session restore uses, so its half-finished stream, its painted markers and its queued prompts go with it.

### Fixed
- **A staged image stays in the tab that staged it**: image chips travel with the conversation they belong to — switching tabs no longer leaves the picture and its chip on the wrong composer, and a restored chip is still removed by identity.
- **Coming back keeps your reading position**: reactivating a tab you had scrolled up in no longer jumps to the latest message, and the jump-to-latest button is waiting there for you instead.
- **Closing a tab says what it threw away**: prompts still waiting in its queue are announced, the same way every other discard already was.
- **A contested stream slot no longer eats a prompt**: when two turns race for the last free slot, the loser re-queues with its bubble and images intact rather than surfacing a red error and losing the message.
- **The slash menu speaks for the conversation in view**: a background session's command list can no longer overwrite it, and each tab's own list is re-projected when it comes forward.
- **`/clear` keeps the note cache**: note contents are memoized by path, so clearing one tab's screen no longer makes every later reference read the file again.

## 0.2.0 - 2026-09-25

### Added
- **Multiple conversations side by side**: open conversations live in a numbered tab strip under the header — click, arrow key or Alt+1..9 to move between them, "+" for a fresh one, × to close. Looking away from a generating conversation never cancels it: its badge pulses while it works and marks a reply that landed while the tab was hidden.
- **Real concurrent generation**: every tab owns its transcript state, stream controller and queue, so up to four conversations can stream at once. A turn that finds no free slot waits in its own tab's queue and drains the moment budget frees up instead of failing.
- **The strip survives a restart**: tabs come back with the conversation that was in front, and each one reads its transcript back only when you actually look at it. A new *Max Open Tabs* setting (2–12, default 6) bounds the strip, and past the limit the plugin says so out loud rather than quietly refusing.

### Changed
- **Stop and /clear stay local**: stopping a generation or clearing the screen affects only the conversation in view, while disconnecting the agent tears down every open tab at once.
- **Permission prompts name their origin**: a request from a conversation in the background says which tab it came from and switches there on click.
- **Session actions gained tab semantics**: `/new` and the session dropdown focus or open a tab instead of replacing what is on screen, a fork always lands in its own tab, and deleting a session closes exactly that tab.

### Fixed
- **Interleaved sessions no longer weld together**: per-session message normalizers and metadata maps mean two sessions that happen to reuse a message id accumulate separately, and loading a session in the background can no longer overwrite the model and mode shown in front.
- **Ambiguous frames are no longer guessed**: an update without a session id is delivered only when exactly one target could own it, and dropped with a single warning otherwise.

## 0.1.40 - 2026-09-25

### Added
- **Keyboard-reachable controls**: previously hover-only actions — user message buttons, session item actions, code and text copy buttons — now also reveal on keyboard focus, and every session action button carries a title plus accessible name in both enabled and disabled states, including the delete confirmation cycle and the inline rename input.

### Changed
- **Stop is immediate**: `session/cancel` is sent as fire-and-forget notifications across every agent method alias, so pressing Stop no longer waits up to 30 s on a response frame that never arrives.
- **Session load keeps pace with replay**: `session/load` runs on an idle deadline instead of a fixed timeout — a session whose replay keeps streaming stays open, a stalled one fails after 30 s.
- **Localized collapsible and tool chrome**: expand/collapse aria-labels follow the active language through a new `data-i18n-toggle` relabel pass, write/edit tool badges show the localized kind and pick their icon from the raw tool kind, and the side-chat panel relabels its chrome live.
- **Honest process exit errors**: a dead agent process reports its real exit code and appends a tail of captured stderr to the surfaced failure, and shutdown resolves after the SIGKILL grace even when the `close` event never arrives.

### Fixed
- **First-connect permissions reach the handler**: the dispatcher is resolved live per request, so permission prompts can no longer be silently auto-rejected by a stale by-value capture.
- **No painting into the wrong session**: superseded turns abort right after session resolution, mid-render message tails get a second render pass, and the jump-to-latest button revives after a transcript clear.
- **No listener or waiter leaks**: timed-out JSON-RPC requests detach their abort listener, and concurrent terminal `waitForExit` callers join one shared waiter instead of orphaning the previous one.

## 0.1.39 - 2026-09-25

### Added
- **IME-safe key handling**: Enter and printable keys during IME composition no longer send messages, feed the dropdown filter, or commit/cancel a session rename — a shared composition guard covers the chat input, side chat, autocomplete and session rename.
- **Live locale relabeling**: the thinking placeholder, collapsed-turn summaries (keeping their step count), code and text copy buttons, the plan title, tool kind badges and rewind tooltips follow a language switch without re-rendering the conversation.
- **Listbox and meter semantics**: the autocomplete and session dropdowns expose `listbox`/`option` roles with selection state, and the send/stop button, context arc meter and chip-remove buttons carry localized accessible names; chips can be removed from the keyboard.

### Changed
- **Lenient permission frames**: a malformed option drops just that option instead of the whole request, and a prompt that arrives with no usable options is cancelled visibly instead of hanging.
- **Honest tool status**: cancelled/aborted/rejected report as `failed` and unknown statuses as in-progress — a malformed frame can never fake a clean completion.
- **Readable tool failures**: a failed tool card shows the agent's own error or message text instead of a raw JSON dump; the "more lines" suffix and every tool kind name follow the active language.
- **Protocol conformance**: the initialize handshake now closes with `notifications/initialized`, a protocol-version mismatch warns instead of failing, JSON-RPC batch frames are answered per message, and file/terminal failures leave the result lane as real RPC errors.
- **Session search failures are visible**: a content-search exception shows a failure line in the dropdown instead of only a console warning, and stale native/content sections are swept between re-renders.

### Fixed
- **Subprocess teardown drains stdout**: exit handling moved from `exit` to `close`, so buffered JSON-RPC frames are still read before the connection is disposed.
- **Session and input correctness**: restoring a session is guarded against stale completions, retry replays captured images, the effort list survives a locale switch, a stale stream turn recreates its message, dropdown re-renders preserve an in-progress rename and filter, and input resize listeners detach on dispose.

## 0.1.38 - 2026-09-25

### Added
- **Save failure is visible**: a failed data write raises a sticky notice that hides itself on the next successful save — silent loss of recent chat data is no longer the failure mode.
- **Stored image budget**: images persisted in a session are kept under a total byte budget, evicting the oldest payloads first and leaving a localized placeholder where a message becomes empty.
- **Settings bounds with hints**: numeric settings fields gain explicit ranges and reject out-of-range or non-numeric input with a visible localized hint instead of silently discarding the value.

### Changed
- **Tool frames degrade instead of dropping**: unknown tool kinds parse as `other`, `apply_patch` is recognized, and any status string keeps the frame — a patch update can no longer silently vanish.
- **Config-option resilience**: an option with an unknown id, category, type or current value no longer costs the whole `config_option_update`; the model list survives the ride.
- **Honest permission outcomes**: a decision matching none of the offered options reports `cancelled` on the wire, and deny-intent modes (plan/readonly/safe) never fall through to an allow-shaped option.
- **JSON-RPC tolerance**: string request ids are answered, `null` results resolve pending requests, and `error.data` text surfaces when the error object carries no message.
- **Thinking blocks finalize**: the live thinking block closes when a turn completes, is stopped or is reset by a reconnect — no orphaned timers or mislabeled headers.
- **Session loss is told honestly**: a runtime session the agent no longer holds becomes a neutral system note, while other sync failures render as a visible error line.
- **Pending images measured on the wire**: the attach budget compares the encoded base64 payload, not the claimed file size.
- **Stop keeps the queue separated**: stopping a turn restores queued prompts into the input with blank-line separation so independent messages stay independent.
- **Localized polish**: one rendered form for token rates, the empty tool-result line follows the active language, session list dates use the locale calendar, and idle `state_update` usage keeps its cost.
- **Keyboard and screen-reader access**: mode-cycle and permission toggles are proper buttons operable with Enter/Space, and the header and jump-to-latest icon buttons carry localized accessible names.

### Fixed
- **Byte-identical attachments remove independently**: pending-image chips splice their own part by object identity, so attaching the same image twice no longer deletes the wrong one.

## 0.1.37 - 2026-09-25

### Added
- **Elicitation retirement**: when the agent reports an elicitation was answered elsewhere (`elicitation/complete`), the matching permission banner retires on its own instead of waiting for a click.
- **Unrecognized stop-reason badge**: a turn that ends with a stop reason outside the known enum still badges and notes the raw reason — agent enum drift no longer masquerades as a clean completion.
- **Queue-drop notice**: resetting or closing a conversation with prompts still queued reports how many were discarded instead of deleting them silently.
- **Currency-honest usage**: the usage line renders `€`/`¥`/`£` glyphs for known currencies and falls back to the raw code (`BTC 0.5000`) for unknown ones, so a non-USD cost can never be misread as dollars.

### Changed
- **Stable fork wire name**: session fork prefers the official `session/fork` method, with the unstable spellings kept only as fallbacks.
- **Paged session listing**: `session/list` follows `nextCursor` (page-bounded) instead of assuming one response holds the whole history.
- **Idle timeout is honest**: `0` disables it outright (the old setting silently snap-backed to 5 minutes), and while a permission banner is on screen the idle clock pauses — a slow human decision no longer kills the turn, and the full window restarts after the banner resolves.
- **Settings take effect live**: note reference size, terminal timeout and max output size re-push capabilities to the connected client on change — no reconnect needed.
- **Localized chrome**: the thinking timer, "Thought for Ns" duration, tool-source badges, session truncation marker and token units now follow the active language; unknown incoming notifications warn once per method instead of vanishing in silence.

### Fixed
- **Stale client disconnected before replacement**: a reconnect tears down the old client first, so its late callbacks can no longer mutate the new session's view.
- **Retention spares the in-flight turn**: persistence during streaming is exempt from history pruning, so a long turn can no longer save a transcript that truncated away its own messages.
- **Resume swaps the screen**: loading or resuming a session re-renders the transcript instead of layering the old conversation underneath.
- **Stop clears its tool ghosts**: stopping a turn finalizes still-running tool-call rows instead of leaving spinners frozen in "in progress".
- **Newer data is set aside intact**: `data.json` written by a newer plugin version is preserved under a distinct name and the plugin starts clean, instead of round-tripping data it cannot understand.
- **Concurrent loads no longer wipe streamed text**: the update normalizer resets only when no stream is active, so loading another session mid-answer no longer corrupts the message being streamed.
- **Official `plan_removed` honored**: the v2 plan-clearing frame now parses and empties the plan instead of surfacing as an unknown update.

## 0.1.36 - 2026-09-25

### Added
- **Official v2 notice frames**: `notice` session updates (severity/title/description) fold onto one transcript shape — warning and error lines render level-labeled, info renders plain.
- **Compaction upsert state machine**: v2 `compaction_update` frames carrying a `compactionId` pin the boundary marker at the first frame, suppress in-flight patch replays, surface a failure notice on `failed`, and stay silent on `cancelled`; legacy id-less frames behave exactly as before.
- **Idle state usage**: an `state_update` frame at idle carrying a usage record is adopted for the turn footer.
- **Durable stop badges and turn footers**: stop-reason badges persist as transcript system messages and usage stamps persist on the assistant message, so a finished conversation looks the same after reload as it did live.
- **Durable agent images**: images streamed by the agent are stored as image content blocks (deduped per message) and re-render from the transcript on reload.
- **The missing binary gets named**: an ENOENT launch failure reports the configured command and points at installation or the Settings path field instead of a bare connection error.
- **Over-budget image notice**: a pasted or dropped image that would exceed the 10 MB pending-image budget is now announced by file name instead of being skipped quietly.

### Changed
- **Desktop PATH gaps no longer block connect**: POSIX launches resolve a bare command against PATH plus the common install dirs (`~/.opencode/bin`, `~/.local/bin`, `~/.bun/bin`, `/usr/local/bin`, `/opt/homebrew/bin`, `/usr/bin`); the auto-connect pre-check, diagnostics and the spawn itself all use the same resolver, so they can never disagree.
- **Effort ladder widened**: the default-effort selector offers the full ladder — minimal, low, medium, high, xhigh and max.
- **Auto-connect pre-checks reachability**: an unresolvable command shows the notice and reconnect button immediately rather than spawning a doomed subprocess.

### Fixed
- **Corrupted `data.json` degrades**: a plugin-data load failure now falls back to defaults with a visible Notice and sets the unreadable file aside as `data.corrupt-<timestamp>.json` — the plugin no longer bricks on a damaged file.
- **Save failures are visible**: a failed chat-data save surfaces a throttled Notice instead of being silently dropped by fire-and-forget call sites.
- **Session switch cancels the outgoing turn**: the in-flight turn is cancelled before the session pointer moves, so the cancel actually reaches that turn rather than no-op'ing against the session being switched into.
- **Handshake-raced closes stop reconnect storms**: a subprocess close that races an in-flight handshake no longer schedules a reconnect — the failed connect owns its teardown, so a dead binary is not respawned over and over.

## 0.1.35 - 2026-09-23

### Added
- **Notice updates**: `notice_update` frames (parsed permissively as an extension — not in the official ACP schema yet) render as level-labeled system messages in the transcript.
- **Compaction boundary**: a `compaction_update` inserts a visible "context compacted" marker that is persisted with the transcript, and the replay collector keeps the boundary at its original position across reloads.
- **Non-text chunk placeholder**: streamed chunks that are neither text nor image (audio, resources, …) no longer vanish — a placeholder naming the content type is shown once per message and persisted.
- **Keyboard-accessible toolbar dropdowns**: the model and effort selectors are proper listbox widgets now — focusable trigger, Enter/Space/arrows to open, arrow-key roving focus over options, Enter to choose, Escape and outside clicks to close, with visible focus styles.
- **Native list failure row**: the session dropdown shows an explicit failure line when the OpenCode native session listing cannot be read instead of silently omitting the section.

### Changed
- **Capability-gated attach button**: the image attach button is disabled with an explanatory tooltip when the agent declares `promptCapabilities.image: false`, mirroring the send-path rule that strips images.
- **Stable tool identity**: `tool_call`/`tool_call_update` `name` is carried onto the snapshot as `toolName` and preferred by sync-rule matching, and `planId` on v2 plan envelopes is accepted.

### Fixed
- **Retention spares pins**: automatic history retention now exempts pinned conversations from pruning regardless of age, and the setting description says so.
- **Unload tail persistence**: pending transcript saves are flushed during plugin unload, so the final messages of a just-closed session survive.
- **Toolbar optimistic-update rollback**: a failed model/agent/effort change surfaces a Notice with the error and reloads the authoritative options instead of leaving the label on the rejected value.
- **`tool_calls` stop reason**: turns ending to await tool results render their own badge instead of masquerading as a normal completion.
- **Cost currency honesty**: the usage line reports the currency the agent actually attached to the cost (falling back to USD only when none is given), so non-USD costs are no longer mislabeled.

## 0.1.34 - 2026-09-23

### Added
- **Non-text streamed content**: chunk content now parses permissively instead of being dropped at the schema gate — image payloads render inline through a dedicated assistant-image style, other typed payloads (audio, resources) ride along unpainted, and interleaved text keeps accumulating correctly.
- **Pinned conversations**: each session row gains a star button; pinned chats sort to the top of the dropdown, the rest by most recently active, and pins persist with the plugin data.
- **`data.json` schema versioning**: plugin data is saved under a schema version and older files are sanitized at load (v0→v1), so a truncated or hand-edited `data.json` degrades instead of crashing hydrate.
- **Native agent/model metadata**: the v1 native session listing reads each session's `agent` and `model` columns into `SessionMeta`.

### Fixed
- **Ref-preserving stop**: pressing stop returns plain queued prompts to the input but keeps entries carrying @-mention or image refs queued — the textarea cannot represent refs, and dropping them silently lost context.
- **No more silent error swallowing**: a turn error discarded while disconnected and a cosmetic enrichment save failure now leave a console trace.
- **Plan and update resilience**: plan entries with missing fields fall back to neutral defaults instead of dropping the whole update, and an unknown `sessionUpdate` kind warns once per kind rather than vanishing silently.
- **Side-chat close aborts the turn**: closing the side-chat panel mid-answer cancels the in-flight turn instead of leaving a orphaned stream running.
- **autoConnect actually honored**: the toggle now controls startup behavior — on auto-connects the view, off leaves the manual reconnect button as the entry point — and it defaults to on; a legacy stored `false` (which the dead toggle could never express before 0.1.34) migrates to keep existing auto-connect behavior, while an explicit off after this release is respected.

## 0.1.33 - 2026-09-23

### Added
- **OpenCode v2 database reads**: a forked `opencode.db` (v2) is now read through `session_message` — session listing, native content search, per-session usage, per-message stats and tool errors all recover under v2 via the same reader, keeping v1 working through the cached schema probe.
- **ACP v2-alpha dispatch pre-layer**: `plan_update` frames are coerced into the internal plan shape and config options carried inside `session_info_update` are picked up, so forward-compatible agents no longer lose those frames.
- **Reload-safe turn throughput**: completed-turn `tok/s` is persisted onto each assistant message (TurnStats) and restored with the transcript, so throughput survives a reload; native turn stats are computed client-side from chronological evidence and attached by message id only — never guessed positionally.
- **Leaner data.json**: text-only content blocks that merely duplicate the message text are elided from the persisted copy and rebuilt on load, shrinking the sidecar without the in-memory transcript ever seeing the elided form.
- **Context percentage everywhere**: the header meter and the per-turn usage line/title now share one clamped context-occupancy helper.

### Fixed
- **Forked-schema detection**: the schema probe spots `session_message`/`data_migration`/`session_v2`; a v1-shaped database holding live v2 data classifies as forked and degrades every native read with one clear warning instead of silently serving a stale mirror, while empty v1.18 scaffold tables still classify as v1.
- **Double-escaped literals**: the system prompt now instructs the agent to decode entities exactly once, so `&amp;`-style literals survive round-trips into notes.
- **load vs resume sync notice**: `syncRuntimeSession` no longer silently skips when the agent advertises neither `session/load` nor `session/resume`; it says so in a system message instead.

### Notes
- fork-from-latest-reply was evaluated and deliberately deferred — no anchored fork exists on the ACP side yet; see `docs/decisions/fork-from-latest-reply.md`.

## 0.1.32 - 2026-09-23

### Added
- **Elicitation support**: `elicitation/create` requests from the agent are routed through the permission banner queue — allow/decline map to the spec's accept/decline/cancel outcomes — instead of being auto-rejected with `-32601`; the capability is advertised at initialize.
- **Authentication handshakes**: `authMethods` from initialize are parsed and normalized, and a session creation that fails with an auth-required error authenticates with the preferred method and retries once per connection.
- **`opencode.db` v2 defense**: a cached schema probe classifies the native database as v1, incompatible or unknown; unknown or unreadable never blocks reads, while an incompatible (v2+) database degrades every native read path with a single clear warning instead of throwing on unexpected tables.
- **Turn throughput**: completed turns show a `tok/s` figure derived strictly from native output+thinking evidence over the measured wall clock, with the same number in the usage tooltip.
- **Full config-option surfacing**: the effort dropdown now presents the agent's own option list when it provides one; known tiers get localized labels and custom tiers keep the agent's names, falling back to the built-in list only when the agent sends none.
- **Selection-aware streaming**: markdown re-renders are deferred while the user is selecting text inside the chat, so a live selection survives mid-stream refreshes.

### Fixed
- **Stream routing and stale turns**: `session/update` frames are filtered by sessionId so side-chat traffic can no longer bleed into the main transcript; main and side chat hold independent stream slots, and the agent-call finally hook no longer pollutes a fresh turn past its generation guard.
- **Vault writes**: the filesystem delegate writes through the Obsidian vault API with corrected `normalizePath` handling instead of raw host writes.
- **Stop reasons**: refusal, max-tokens and cancelled turns render with their own badges instead of masquerading as a normal completion.
- **Leak and race hygiene**: `scheduleSave` is disposed-guarded, renderer and session-dropdown timers are cleaned up on teardown, permission requests with unparseable payloads surface a visible warning, and native plan refresh no longer races the streaming plan.
- **Render parity**: mermaid fences are left to Obsidian's post-processor (no copy button injected), rendered markdown placeholders carry `.markdown-rendered` so ordered-list markers survive theming, and the injected system prompt now declares XML escaping for path attributes as well as note bodies.

## 0.1.31 - 2026-09-23

### Added
- **Side chat `/btw`**: fork the current session into a throwaway scratch thread with its own panel — ask a tangential question without disturbing the main conversation. Follow-ups reuse the same fork, and closing the panel disposes it.
- **Native session content search**: the session dropdown now searches OpenCode-native message text in `opencode.db`, not just titles, and shows a snippet around the first match; results are race-guarded so a stale search response never paints over a newer query.
- **Auto session titles**: after the first completed exchange the title is derived from the opening user prompt (slash commands are skipped), so new chats stop being stuck at `Chat 21:00:00`; later manual renames are never overwritten.
- **Queue visualization and merging**: prompts queued while busy render as individual removable rows in the queue bar, and consecutive plain prompts drain as one merged send, while slash-like or context-carrying entries keep their own turn.
- **`/resume` command**: re-opens the session picker straight from the composer.

### Fixed
- **Fork integrity**: switching to a forked session rebuilds the transcript and surfaces sync errors instead of leaving a blank view.
- **Queue robustness**: early returns in the agent-call path still run the finally hook (busy flag released, queue drained), and one failing queued command no longer aborts the rest of the drain.
- **Permission requests**: parallel `session/request_permission` calls now queue behind each other instead of being force-rejected.
- **Note cache**: referenced-note bodies are cached in a bounded LRU that invalidates entries when the vault modifies a note.
- **Locale hygiene**: the locale listener no longer leaks across view reloads, and slash-command titles refresh when the language changes.
- **Capability gating**: `loadSession`, audio input and embedded-context features are gated by the negotiated agent capabilities; transcript restore keeps system messages; the image lightbox captures focus and restores it on close.

## 0.1.30 - 2026-09-22

### Added
- **Real native plan panel**: the OpenCode todo table is read from `opencode.db` and re-attached to the plan panel on session restore, resume and after every turn. (Claudian parity)
- **Native session facts**: the session dropdown badges each OpenCode session with its actual added/removed line and changed-file counts, and restored transcripts show per-message cost/token footers plus persisted tool errors replayed from native step-finish stats.
- **Capability gating**: `initialize` agent capabilities are normalized and gate UI surfaces (MCP http/sse option labels, feature availability) instead of assuming them.
- **`[[wikilinks]]` as context**: links typed in the composer are resolved against the vault and their note bodies attached as context before the prompt is sent.
- **Vault-operations system prompt**: the injected system prompt now carries Obsidian vault editing guidance — read-before-edit, frontmatter/wikilink preservation, quoted-data-is-never-instructions, and the XML-escaping rules learned from broken patches.
- **Image lightbox**: clicking any image in the transcript (assistant markdown or uploaded attachments) opens a dismissable full-size overlay.
- **Turn collapsing**: finished turns with thinking/tool steps fold behind a "N steps" header that expands on click and is keyboard-accessible.
- **Default thinking effort setting**: a `Default Thinking Effort` dropdown in settings applies low/medium/high effort to each newly created session.
- **Full-suite renderer coverage**: new test suites for the diff, thinking and tool-call renderers; en/zh dictionaries stay key-identical.

### Fixed
- **Permission requests worked end-to-end**: `session/request_permission` is registered under all wire aliases with the spec outcome shape — production requests no longer fail with `-32601` — and dismissing or overwriting the permission banner resolves the pending request instead of hanging the agent.
- **Crash recovery reachable**: subprocess deaths classify as `AcpProcessExitError` and surface a restart action; reconnect/ensureSession errors reach the UI, and the `safe` permission tier actually routes requests to the banner (the client stored a constant instead of the assigned mode).
- **Send/Stop integrity**: busy state is claimed synchronously to kill the double-send race, and Stop restores queued prompts into the composer rather than dropping them.
- **Tool rendering**: buffered tool calls finalize at turn end, orphan `tool_call_update` frames synthesize a card, partial diffs with only one side render, and apply-patch file headers survive the diff render.
- **Lifecycle leaks**: file command sources unregister on view close, the ACP child process disconnects on plugin unload, and non-JSON stdout lines log a warning instead of vanishing.
- **`/export` no longer clobbers**: exported notes carry a time component so same-day exports sit side by side.
- **i18n sweep**: thinking blocks, diffs, tool cards, permission locations, toolbar permission labels, ribbon/command names, MCP settings and ACP error messages moved from hardcoded English into the en/zh dictionaries.

## 0.1.29 - 2026-09-22

### Added
- **Real cost and context usage**: adopting a native OpenCode session (load, resume, or selection from the dropdown) now pulls actual cost and token totals from `opencode.db`, and per-response `_meta` usage (context fill, window size, cost) feeds the context meter instead of leaving it stale.
- **`/export` and `/copy`**: save the whole conversation as a dated Markdown note under the configured sync folder, or put the rendered transcript on the clipboard; user bubbles gained per-message copy buttons.
- **Session rename**: pencil action in the session dropdown opens an inline editor for the local session title.
- **Delete confirmation**: removing a session now requires a second confirming click, with the confirmation reverting automatically after a few seconds.
- **Full i18n coverage**: the interrupt indicator, queue badge, help/model/mode command output, builtin command titles and the context-meter tooltip moved into the en/zh dictionaries.

### Fixed
- **Transport correctness**: unknown JSON-RPC requests now answer with `-32601` instead of a silent hang, `stopReason` values outside the ACP enum are normalized, and the idle timeout aborts the underlying request stream rather than only the client-side wait. (Claudian parity)
- **Visible session errors**: fork, resume and reconnection failures are surfaced as notices instead of being swallowed.
- **Rewind truncation timing**: regenerate / edit-and-resend truncates the local transcript before the fresh agent session replays, so the rewind block and stored history stay consistent.
- **Structured history replay**: restoring a session re-renders persisted tool-call blocks (status, title, kind) and image attachments instead of dropping them; image parts sent with a user message are now persisted and re-rendered on restore.
- **Context meter honesty**: the meter no longer falls back to per-turn token totals as an approximation of context fill.

## 0.1.28 - 2026-09-22

### Added
- **Image pipeline completion**: pasted or picker-selected images now actually reach the agent — every send drains pending image parts into the prompt, drag-drop shares the same budgeted entry point, a paperclip button opens the file picker, and unsupported agents are gated with a notice. (Claudian parity)
- **Transcript replay on session load**: `session/load` and `session/resume` replay updates are collected and adopted, so opening a native OpenCode session renders its full conversation instead of an empty pane. (Claudian parity)
- **Regenerate / edit-and-resend**: user bubbles gain hover actions to re-run or edit any earlier turn. Since ACP has no server-side truncate, the rewind rotates to a fresh agent session and replays the retained turns as a context-only block, truncating the local transcript under the edited turn. (Claudian parity)

## 0.1.27 - 2026-09-22

### Added
- **OpenCode native session history**: the session dropdown now lists OpenCode's own terminal sessions read straight from the native `opencode.db` (in-process `node:sqlite`, falling back to a spawned Node helper, then the `sqlite3` CLI). Selecting one restores it over ACP `session/load` so the conversation can continue inside Obsidian. (Claudian parity)
- **Readonly execution tier**: a fourth permission mode that auto-allows only non-mutating tools (read/search/fetch), auto-rejects every write or execution without prompts, and downgrades client-side capabilities to file-write readonly with terminal execution disabled.
- **Session-loss surfacing**: agent-side "session no longer exists" failures during switching, connect and reconnect are classified into a dedicated error and reported in chat instead of failing silently.

### Fixed
- **Generation-fenced reconnection**: every subprocess connection now carries a generation number; stale connect continuations, reconnect timers and `session/update` notifications from a superseded transport can no longer mutate or tear down the live connection.

## 0.1.26 - 2026-08-28

### Fixed
- **Session persistence races**: serialized plugin-data writes, guarded stale stream callbacks, and flush pending stream saves during view shutdown so recent messages are not lost.
- **Permission fallback safety**: clients without a permission callback now select a rejection option rather than inadvertently allowing an operation.

### Changed
- **Session ownership**: moved persisted sessions and active-session state into `SessionRepository`, with explicit hydrate, snapshot, and pruning behavior.
- **Controller boundary**: `CoOberViewController` now depends on a minimal runtime port instead of the concrete plugin class.
- **Quality gate**: CI runs tests, and lint now requires zero warnings; MCP capability settings use the precise agent capability type.

## 0.1.25 - 2026-06-19

### Fixed
- **Stop button not working**: `stopGeneration()` now calls `c.cancel()` before resetting `busy=false`, preventing new sends from starting before the backend agent is properly cancelled.
- **`cancel()` abort order in ACP**: abort controller fires before clearing `activeStreamSessionId`, so `sendMessage()`'s `.finally()` can properly detect the cancelled state.
- **Missing "Interrupted" indicator**: when user clicks stop, the assistant message now shows a red "Interrupted · What should I do instead?" badge, matching claudian's UX.

### Added
- **Queue indicator**: when messages are sent while streaming, a "⌙ N message(s) queued" bar appears above the input area. (claudian parity)

## 0.1.24 - 2026-06-19

### Added
- **Write/Edit diff stats in header**: collapsed tool calls now show `+x -y` directly in the header, with dedicated monospace styling and green/red color coding. Empty status hidden on completion so stats align flush-right. (claudian parity)
- **SVG status icons**: replaced text `…`/`✓`/`✗` with Obsidian SVG icons (`loader` with spin animation, `check`, `x`, `circle`) for running/completed/failed/pending states. (claudian parity)
- **Per-tool expanded content rendering**: bash/execute shows command + stdout/stderr + exit code; read shows first 15 lines; search/grep shows up to 20 hoverable matches; fetch/web_search shows content preview + source URL; think shows up to 30 lines. (claudian parity)
- **apply_patch multi-file diff rendering**: parses `*** Add/Update/Delete File:` markers, renders each file as a bordered section with operation badge (ADD/UPDATE/DELETE) and inline diff. (claudian parity)
- **ContentBlocks ordering**: stream controller now tracks tool call order and persists `contentBlocks[]` on saved messages, preserving interleaved text/tool_use/thinking order on replay. (claudian parity)
- **extractDiffData utility**: extracts structured diff data from SDK `structuredPatch` format, or falls back to computing from Edit `old_string`/`new_string` and Write `content`. (claudian parity)

### Fixed
- **Horizontal scrollbar in dialog**: `.co-ober-messages` now has `overflow-x: hidden`, tool/thinking bodies clip horizontally with internal scroll only, `.diff-line` breaks long lines with `word-break: break-all`. (claudian parity)
- **Text selection disabled**: `.co-ober-message-content` and `.co-ober-text-block` now explicitly set `user-select: text` so chat content can be selected and copied. (claudian parity)
- **tool_use block rendering**: content blocks now check `toolCallStates` first (most reliable), fall back to DOM lookup, then render truncated ID placeholder. (robustness)

### Changed
- **`ToolKind` type extended**: added `'apply_patch'` to the union type for first-class apply_patch tool support.

## 0.1.23 - 2026-06-19

### Fixed
- **Plugin loading failure**: `local-resolver` in esbuild.config.mjs was marking all non-relative imports as `external`, causing `zod` / `tslib` to be unresolvable in Obsidian's runtime. Fixed by restricting the resolver to relative/absolute paths only.
- **Test version drift**: `CLIENT_VERSION` test hardcoded to v0.1.21 now reads from `package.json` dynamically.

## 0.1.22 - 2026-06-19

### Added
- **Zod schema validation layer**: `acpSchemas.ts` defines 12 Zod schemas for all `SessionUpdate` variants, replacing raw `as` assertions in `parseSessionUpdate()` (~33 casts eliminated).
- **Constants extraction**: `constants.ts` centralizes 16 magic numbers (timeouts, thresholds, limits) used across the codebase.
- **Cache fix**: `noteContentCache` in `CoOberViewController` now actually writes entries (was get-only, 0% hit rate); LRU eviction at 100 entries added.

### Changed
- **Type safety overhaul**: all `as Record<string, unknown>` casts in `AcpRequestHandler.ts` replaced with Zod `safeParse` calls. `AcpSubprocess` `onClose()` deduplication fixed.
- **send()/sendTextToAgent() deduplication**: ~80 shared lines extracted into `executeAgentCall()` private method. `send()` reduced from ~117 to ~50 lines.
- **i18n robustness**: `setLocale` now wraps listener invocations in try/catch to isolate failures.
- **`/clear` command fix**: resets `busy`, `genId`, `noteContentCache`, and `cacheSessionId` to prevent stale state leaks.

### Fixed
- **All 7 test failures resolved**: 523 tests now pass (0 failures). Fixed version mismatch, shell detection for .cmd/.bat, autocomplete wrapping, subprocess timeout mock, and stale cancel/abort assertion.

## 0.1.21 - 2026-06-19

### Changed
- **settings.ts refactored**: `render()` method reduced from 398 lines to 22 lines by extracting 11 section methods. Large block-rendering methods (addCustomAgentBlock, addCustomSkillBlock, addCommonModelToggle, addMcpServerBlock, addSyncRuleBlock, renameCustomAgent, renameCustomSkill) moved to `src/settings/settingBlocks.ts` as standalone functions with explicit dependencies.
- **DiffRenderer types cleaned**: `DiffHunk` and `DiffStats` interfaces made non-exported to eliminate conceptual overlap with `types.ts`.
- **Code quality pass**: comprehensive review of error handling patterns across the codebase; all `catch(e)` handlers verified to use proper error narrowing.

# Changelog

## 0.1.20 - 2026-06-19

### Fixed
- **New messages jump button redesign**: replaced accent-colored rectangular button with a subtle floating pill shape, arrow-down icon, hover effects, and slide-up entrance animation.
- **Toolbar send button**: migrated from text labels to Obsidian `setIcon` (`send`/`square`) with `.mod-stop` toggle.

### Changed
- **Session button icon**: replaced "···" text with Obsidian `history` icon.
- **New session button**: migrated text label to `plus-circle` icon.

## 0.1.19 - 2026-06-19

### Changed
- **Claudian-inspired visual overhaul**: transparent tool call and thinking block headers (removed card backgrounds), tree-branch style border-inline-start on expanded content, muted user message colors.
- **Auto-collapse on completion**: thinking blocks and tool call cards now auto-collapse when streaming completes or fails, matching Claudian's post-stream behavior.
- **Width-constrained expanded content**: expanded tool/thinking bodies are constrained by CSS `max-width` for readability, with no inline `maxHeight`/`overflowY` in JS.
- **Real-time thinking markdown rendering**: `scheduleThinkingRender()` renders live thinking content through Obsidian's `MarkdownRenderer` via RAF throttle instead of raw text.

## 0.1.18 - 2026-06-19

### Added
- **Unified collapsible component**: `setupCollapsible()` with scroll-into-view on expand, `onExpand` callback, and `scrollOnExpand` option — replaces 4 independent toggle implementations.
- **Independent DiffRenderer**: `splitIntoHunks()` smart hunk grouping, `computeDiffStats()`, new-file creation truncation at 20 lines, and `parseDiffLines()` for structured diff data.
- **Dedicated WriteEditRenderer**: separate rendering for Write/Edit tool calls with diff previews, `+N -M` stats, and collapsible diff content.
- **Thinking block content truncation**: expanded thinking blocks show first 30 lines with "Show all ›" button for full content, `max-height: 400px` with scroll for long content.
- **Tool call body scrolling**: expanded tool call cards get `max-height: 400px` + `overflow-y: auto` to handle long bash output or diff content.

### Changed
- **ToolCallRenderer** — refactored with `renderLinesExpanded()` truncation pattern, `renderToolBodyContent()` content-type dispatch, and Write/Edit delegation to `writeEditRenderer.ts`.
- **renderer.ts** — three-layer render frame scheduling (text/thinking/toolOutput) using `requestAnimationFrame` + Promise pipelines, replacing `setTimeout`-based throttling. Adds `flushTextRender()`, `flushThinkingRender()`, `scheduleToolRender()`.
- **StreamController** — calls `flushThinkingRender()`/`flushTextRender()` on content type transitions (agent ↔ thought) for consistent rendering.

## 0.1.17 - 2026-06-19

### Added
- **Structured message rendering system**: `ContentBlock` model, `Collapsible` component, `ThinkingBlockRenderer` with live timer, `ToolCallRenderer` with status indicators, `DiffRenderer` for unified diff display.
- **Tool call buffering**: `pendingToolBuffer` in `StreamController` prevents mid-stream tool call interleaving during streaming responses.

### Changed
- **renderer.ts** — new `renderStructuredMessage()`, `renderInline()`, `renderCompactBoundary()`, `renderSubagentBlock()`, `addTextCopyButton()`, `formatDuration()` methods. Full backward compatibility maintained.
- **CSS** — ~255 lines of new styles for structured blocks, thinking block animations, tool status states, compact boundary, response footer, and interrupt badge.

### Fixed
- `CLIENT_VERSION` in `acp.ts` now correctly matches `package.json` version (previous value `0.1.15` was stale).

## 0.1.16 - 2026-06-16

### Changed
- Complete rename from CoPilot to Co-Ober across all files, identifiers, and remote repository.

## 0.1.15 - 2026-06-15

### Added
- **Multi-source command architecture**: `CommandSource` abstraction with pluggable sources (builtin, ACP, file, skill, MCP).
- **File-based commands**: `.opencode/commands/*.md` auto-discovery with YAML frontmatter parsing and vault file watching.
- **Template expansion**: `$ARGUMENTS`, `$1`-`$9` placeholder substitution for file commands.
- **New builtin commands**: `/add-dir [path]`, `/resume`, `/fork`, `/model <id>`, `/mode <id>` with capability gating via `enabled()`.
- **Enhanced autocomplete**: two-row rendering (argument hint in grey italic + description), color-coded source badges (Builtin/ACP/Custom/MCP/Skill).
- **Command visibility gating**: `enabled()` function on `SlashCommandDef` filters commands dynamically based on provider capabilities.
- `commandRegistry.subscribe()` for live UI refresh on command list changes.
- `commandRegistry.getGrouped()` for category-grouped access.
- FrontmatterParser: supports scalars, inline arrays, block arrays, and nested mappings in YAML frontmatter.

### Fixed
- `/compact` now actually sends the compact request to the ACP agent instead of silently doing nothing.

### Changed
- `SlashCommandDef.type` renamed to `source` with expanded `CommandSourceType` union (`builtin` | `acp` | `file` | `mcp` | `skill`).
- Autocomplete items use flex-column layout with `.ac-row` containers for multi-line support.
- Badge CSS classes: `.ac-badge-builtin`, `.ac-badge-acp`, `.ac-badge-custom`, `.ac-badge-mcp`, `.ac-badge-skill`.

## 0.1.14 - 2026-06-14

### Fixed
- **@mention popup simplified**: each item shows only `@filename` with optional ✓ badge. Removed path prefix and secondary description text.
- CSS layout: replaced `space-between` with `gap`, added `flex: 1` to `.ac-label` so filename fills the row.
- Removed `.ac-desc` CSS (no longer used by @ items).

## 0.1.13 - 2026-06-14

### Improved
- **@ mention popup**: files sorted by last modified time (most recent first), grouped by folder, selected notes marked with ✓ badge.
- **Popover layout**: dropdown width matches input area, filename no longer hidden by long path, badge pushed to the right.

## 0.1.12 - 2026-06-14

### Fixed
- **CSS class name mismatch**: dropdown container used class `co-ober-autocomplete` but all CSS rules expected `co-ober-ac-dropdown`. The autocomplete popup (`/` and `@`) was completely unstyled and invisible.
- **Dropdown attached to `document.body`**: changed to mount inside the view's `inputAreaEl` container for correct positioning within Obsidian's iframe layout.
- **Missing CSS styles**: added rules for `ac-badge`, `ac-header`, `ac-separator`, and `<mark>` highlight in the dropdown.

## 0.1.11 - 2026-06-14

### Fixed (critical)
- **Autocomplete popover completely invisible**: `open()` method called `close()` (which nulls `dropdownEl`) but never re-created the dropdown DOM element. `render()` silently returned on the `if (!this.dropdownEl) return;` guard, causing both `/` slash commands and `@` file mentions to be completely non-functional.

## 0.1.10 - 2026-06-14

### Fixed
- Slash command popover not displaying: replaced dynamic `import()` with static import (esbuild bundle incompatibility).
- `/` character eaten on input: same root cause — popover now opens correctly, and `/<trigger>` is properly inserted on selection.
- @mention chip now shows `@name (path)` format for disambiguation.
- Popover search highlighting: matching keywords wrapped in `<mark>` in @mention mode.
- Note content caching: same file not re-read across messages in the same session.
- ContextMention constructor updated from `Vault` to `App` for future metadata cache access.

## 0.1.9 - 2026-06-14

### Features
- Slash command system overhaul: `CommandRegistry` with builtin + ACP proxy commands.
- New builtin slash commands: `/new` (new session), `/clear` (clear display), `/help` (show all commands).
- ACP `available_commands_update` notifications now sync into the registry automatically.
- Popover UI (`Autocomplete`) upgraded with category grouping, type badges (ACP/Builtin), and improved keyboard navigation.
- Command alias support (`/summarize` → `/compact`).
- `addSystemMessage()` renderer method for richly formatted system messages.
- Slash command interception in `send()` — builtin commands execute locally without ACP round-trip.

### Housekeeping
- Remove dead `isBuiltInCommand()` from executor (replaced by `CommandRegistry.isBuiltin()`).
- Import cleanup: inline `import('../types')` replaced with proper top-level imports.

## 0.1.8 - 2026-06-14

### Refactoring
- Comprehensive architecture review: unified types, security hardening, memory lifecycle management.
- Extract Windows command resolution to dedicated utility module.
- safeClone polyfill for structuredClone cross-environment compatibility.
- SyncEngine path security: deduplicate redundant isSafePath check.
- TerminalManager: robust command parsing with proper token splitting, stderr capture, output truncation.

### Fixed
- Cancel race condition: send RPC before clearing local streaming state.
- PermissionBanner show() semantics: eliminate fragile double-assignment pattern.
- disposeConnection ordering: notify onClose before clearing transport.
- methodCache cleared on reconnect to avoid stale method names.
- console.debug usage_update noise: conditional on DEBUG_CO_OBER env var.
- Remove duplicate sessionInfo parsing in extractSessionSnapshot.
- Remove dead code AcpClient.requestPermission (unused, handled by AcpRequestHandler).
- SessionUpdateNormalizer memory leak: add trimMap eviction (200/100 entry caps).
- ChatInput: add dispose() with global event listener cleanup + locale unsubscribe.
- InputToolbar: add dispose() with locale unsubscribe.
- PermissionBanner: add dispose() with locale unsubscribe.
- CoOberView.onClose: integrate input/toolbar/permissionBanner dispose().
- pruneSessions deferred via setTimeout to avoid blocking save IO.

### Housekeeping
- Unified UsageInfo type definition, removed 3 duplicate interfaces.
- OpencodeClient.permissionMode typed as PermissionLevel (was string).
- AgentRuntime.permissionMode explicitly typed.
- Inline import('../types') references replaced with top-level imports.

## 0.1.7 - 2026-06-12

### Refactoring
- Strip `injection.ts` to just `BASE_IDENTITY` and `buildSystemPrompt()` — agent now explores vault autonomously using its own tools rather than relying on programmatic context injection.
- Remove intelligent sync classification (`intelligentFolder`) and its related UI/Settings/i18n.
- Remove conversational memory system (`UserPreferenceStore`).

### Fixed
- Restore `@mention` notes content injection that was broken during refactoring.

### Documentation
- Replace BRAT and manual installation with Obsidian Community Plugins marketplace.
- Remove ACP capability matrix from README.
- Polish README tone and formatting.

### Features
- Enhanced agent identity: Co-Ober now understands Obsidian's bi-directional linking, graph view, backlinks, tags, daily notes, and templates — speaks naturally as an Obsidian-native AI partner.
- Plugin detection: automatically detects enabled Obsidian plugins (Dataview, Tasks, Calendar, Templater, Kanban) and injects awareness into agent system prompt.
- Workflow fluency: agent scans vault structure (Daily/Journal, Templates, Projects folders) and adapts responses based on user's organizational patterns.
- Contextual awareness: agent knows which heading/section the user's cursor is in and whether they're inside a task list, bullet list, blockquote, table, or code block.
- Conversational memory: learns user's writing style and preferences over time, adapting response tone accordingly.
- Intelligent sync placement: new "Intelligent Placement" toggle on sync rules routes AI output to smart folders (Meetings, Tasks, Journal, Learning) based on content analysis.

## 0.1.5 - 2026-06-11

### Fixed
- Pass Obsidian plugin review v2: replace bare `document` fallback with `activeDocument` global for popout window compatibility (5 files).
- Eliminate remaining control-character regex by using charCodeAt loop instead of regex literal.

## 0.1.4 - 2026-06-11

### Fixed
- Pass Obsidian plugin review: replace `style.setProperty` with `setCssProps`, split control-character regex, fix `async onclick` promise returns, suppress `display` deprecation with compatibility note.
- Popout window compatibility: replace bare `document`/`clearTimeout`/`setTimeout`/`requestAnimationFrame` with `window.*` / `ownerDocument` across all modules.
- Type safety: add type guards for unsafe any access, wrap non-Error rejections, remove unnecessary type assertions.
- Command ID/name no longer include plugin name.
- Plugin now passes Obsidian community plugin review checklist (no Errors, no Warnings — only one Recommendation for `display` deprecation held back by minAppVersion 1.8.0).

## 0.1.3 - 2026-06-10

### Features
- Tool call blocks now show icons per tool kind (read/edit/write/execute/glob/grep/search).
- Tool call headers now display the filename being operated on, extracted from ACP locations or rawInput.

### Fixed
- `SyncEngine.isTFile` uses `instanceof TFile` instead of duck-type property checks.
- Add `setIcon` to obsidian mock and fix test expectations for updated `addToolCall`/`updateToolCall` signatures.

## 0.1.2 - 2026-06-09

### Features
- Tool call blocks now display the filename being operated on (read/write/edit) in the header, extracted from ACP `locations` or `rawInput.file_path`.

### Fixed
- Windows command injection: `quoteCmdArg` now escapes backslashes before quotes, preventing cmd.exe quote boundary bypass.
- `AcpSubprocess.shutdown` now sends SIGKILL after timeout (previously only resolved the promise) and sets `closed = true` to prevent spurious close-listener calls.
- Inverted condition in `CoOberViewController.send()` — `inlineEditPanel.clearState()` was called when there was no pending edit instead of when there was one.
- `stopGeneration` now clears the prompt queue before aborting, preventing queued messages from resuming after the user requests a stop.
- `onClose` now awaits `stopGeneration()` to cancel in-flight generation and prevent post-destroy DOM/timer writes.
- SVG arc-meter clip-path ID is now unique per view instance, fixing clipping when multiple Co-Ober leaves are open simultaneously.
- `SyncEngine.isTFile` uses `instanceof TFile` instead of duck-type property checks.
- Sync engine validates that resolved note paths do not contain path traversal sequences before writing.

## 0.1.1 - 2026-06-07

### Security
- Add ALLOWED_COMMANDS whitelist to TerminalManager to prevent arbitrary command execution.
- Remove unconditional shell:true (only .cmd/.bat use shell on Windows).
- Terminate terminal processes on ACP disconnect.
- Show MCP environment variable security warning in settings UI.

### Features
- Prompt input is always usable during streaming. Messages typed while the agent is responding are queued and sent automatically when the current turn finishes.
- Tab / Shift+Tab cycles agent modes forward and backward.
- Stop button interrupts the current response and drains queued prompts.

### Refactoring
- Extract AcpRequestHandler from AcpClient (FS, terminal, and permission request logic). AcpClient reduced from ~920 to ~690 lines.
- Replace setInterval polling in TerminalManager.waitForExit with process exit event.
- Add genId guard to prevent stale finally blocks from corrupting state during stop+drain.

### Fixed
- closeSession no longer silently swallows errors.
- Add session race condition guard in send() after syncRuntimeSession.
- Send errors now correctly set streaming state to false.

## 0.1.0 - 2026-05-31

First public beta release.

### Changed
- Context arc meter moved to right of "Co-Ober" title in header.
- All slash commands now route through ACP agent — removed local `compact` interception.
- `isBuiltInCommand()` always returns false; no commands are handled locally.
- Toolbar redesigned as single row: model selector, mode cycle button, effort dropdown, permission cycle, send button.
- Context arc meter moved to header bar, freeing toolbar space.
- Mode selector changed from segmented button group to single click-to-cycle button.
- Permission toggle uses color-coded border (green/amber/orange) instead of dot indicator.
- Sending indicator merged into send button (button turns red "Stop" during generation).

## 0.0.41 - 2026-05-30

### Changed
- Context meter redesigned as semicircle arc gauge — SVG arc fills from left to right, percentage text on right.
- Effort selector now uses custom hover dropdown instead of native `<select>`, matching model selector style.
- All toolbar elements now use consistent custom UI (no native form controls).

## 0.0.40 - 2026-05-30

### Fixed
- Fix token usage tracking: restore `response.usage` handling from prompt response (primary token source).
- Fix token usage tracking: `usage_update` notification now merges with existing response usage instead of overwriting.
- Fix toolbar spacing: consistent 6px gap between elements, model selector flex fills, permission toggle auto-pushes right.

## 0.0.39 - 2026-05-30

### Fixed
- Fix session stability: `send()` no longer shows error UI when connection is already lost.
- Fix session stability: reconnect now shows a recovery prompt instead of silently losing the in-flight message.
- Fix session stability: `ensureRuntimeSession` falls back to creating a new session when sync fails.
- Fix abort race condition in `AcpJsonRpcTransport` — abort handler checks if request is still pending.
- Fix token usage tracking: enhanced `parseSessionUpdate` field fallback for different server versions.
- Remove dead `response.usage` code path (opencode returns empty object from prompt).

### Changed
- Toolbar split into two rows: top row (model selector + mode buttons), bottom row (effort + context meter + permission + send).
- Idle timeout now disabled when set to 0 (short-circuit instead of wrapping in timeout logic).
- Added debug logging for `usage_update` notifications.

## 0.0.38 - 2026-05-30

### Added
- Add a compact "liquid glass" context usage meter in the toolbar.
- Context meter shows percentage, warning/critical states, and token details on hover.

### Changed
- Usage updates now refresh the toolbar meter during streaming and after final response usage is received.

## 0.0.37 - 2026-05-30

### Changed
- Agent mode selector now uses segmented button group instead of native `<select>`.
- Added permission mode toggle in toolbar (safe → plan → yolo cycle).
- Permission toggle shows color indicator (green/yellow/orange) for current mode.

## 0.0.36 - 2026-05-30

### Fixed
- Fix model list not loading on initial connection - now syncs saved session before loading toolbar options.
- Fix model list not loading after reconnect - clears session state on disconnect so reconnect forces reload.
- Fix abort handler in `AcpJsonRpcTransport` to properly reject with `AcpAbortError`.

### Changed
- Model selector now uses custom hover dropdown instead of native `<select>`, with provider grouping.
- Idle timeout is now configurable via Settings (default 300000ms, 0 to disable).
- `disposeConnection()` now clears session state (sessionId, stream handler, normalizer).

## 0.0.35 - 2026-05-30

### Fixed
- Fix toolbar options not loading after reconnect - now calls `loadToolbarOptions()` after connection establishment.
- Fix abort handler in `AcpJsonRpcTransport` to not prematurely reject with `AcpAbortError`, allowing proper request cleanup.

### Changed
- Prompt requests now use transport-level timeout of 0 (disabled), matching claudian's `ACP_PROMPT_TURN_TIMEOUT_MS` approach. The idle timeout in `AgentRuntime` handles cancellation instead.
- `AgentRuntime.sendMessage` now throws `AcpTimeoutError` instead of generic error for timeout, providing better error classification.

## 0.0.34 - 2026-05-28

### Fixed
- Fix session output interruption by removing unnecessary server cancel request during abort.
- Fix error banner showing on user-initiated cancellation (AcpAbortError now properly suppressed).
- Fix plugin not reconnecting when view opens - now always attempts connection on view open.

### Changed
- `stopGeneration()` now only calls `abort()` without sending `session/cancel` to server.
- `AcpJsonRpcTransport` no longer sends cancel request when abort signal is triggered.
- View now always tries to connect when opened, regardless of `autoConnect` setting.

## 0.0.33 - 2026-05-28

### Added
- Enhance `PermissionBanner` with tool kind badge, location list, and input parameter summary.
- Add CSS styles for new permission UI elements (kind badge, locations, input summary).

### Changed
- Permission banner now shows: tool type badge (e.g., READ, EDIT, EXECUTE), file paths (up to 3), and key input parameters.
- Improved permission banner layout with better visual hierarchy.

## 0.0.32 - 2026-05-28

### Added
- Add `writeTextFile` method to `FsDelegate` for vault file writing with boundary protection.
- Register `fs/write_text_file` handler for OpenCode agent to write vault files.
- Add `readonly` option to `FsCapabilityMode` for read-only file system access.
- Update `clientCapabilities.fs.writeTextFile` based on FS capability mode.

### Changed
- FS capability mode now supports three options: `enabled` (read/write), `readonly` (read only), `disabled` (no access).
- Default FS capability mode is `enabled` (read & write).

## 0.0.31 - 2026-05-28

### Added
- Add `TerminalManager` class for terminal process lifecycle management (create, output, kill, release, waitForExit).
- Register 5 terminal handlers: `terminal/create`, `terminal/output`, `terminal/kill`, `terminal/release`, `terminal/wait_for_exit`.
- Declare `clientCapabilities.terminal = true` in ACP initialize request.
- Add `TerminalCapabilityMode` setting (enabled/disabled) to control terminal access.
- Add terminal timeout setting (default 30000ms) and max output buffer size setting (default 100000 bytes).
- Add `setTerminalCapabilityMode()` method to `AcpClient` and `AgentRuntime`.
- Add unit tests for `TerminalManager` lifecycle operations.

### Security
- Terminal commands run in vault directory by default.
- Output buffer limited to prevent OOM.
- Process timeout prevents hanging commands.

## 0.0.30 - 2026-05-28

### Added
- Add `FsDelegate` class for vault-boundary file system access with path traversal protection.
- Register `fs/read_text_file` handler for OpenCode agent to read vault files.
- Declare `clientCapabilities.fs` in ACP initialize request.
- Add `FsCapabilityMode` setting (enabled/disabled) to control file system access.
- Add `setFsCapabilityMode()` method to `AcpClient` and `AgentRuntime`.
- Add unit tests for `FsDelegate` vault boundary checks and file reading.

### Changed
- Agent can now read files within the vault boundary when FS capability is enabled.
- File size limited by `maxNoteSize` setting (default 8000 bytes).
- Files exceeding the limit are truncated with `... [truncated]` suffix.

## 0.0.29 - 2026-05-28

### Added
- Add `AbortSignal` support to `AcpJsonRpcTransport.request()` for request-level cancellation.
- Add `AcpAbortError` error type for aborted requests.
- Add `abort()` method to `AcpClient` and `AgentRuntime` for external cancellation.
- Add error classification UI with retry/restart buttons for timeout and process exit errors.
- Add `addError()` action parameter to `ChatRenderer` for inline error actions.

### Changed
- `AcpClient.sendMessage()` now uses `AbortController` for cancellation.
- `stopGeneration()` calls `abort()` to immediately cancel in-flight JSON-RPC requests.
- Removed DOM references from `ChatState` (`currentTextEl`, `ThinkingState.el`, `pendingTools[].parentEl`, `toolCallEls`, `planEl`).
- Error messages now show contextual action buttons (retry for timeout, restart for process exit).

### Tested
- Updated tests for `ChatState`, `AcpClient`, and `CoOberViewController` to reflect new abort behavior.

## 0.0.28 - 2026-05-26

### Changed
- Extracted business/session/streaming logic from `CoOberView` into new `CoOberViewController` class.
- View now handles only DOM creation, UI event binding, and Obsidian lifecycle hooks.
- Controller owns connection management, session lifecycle, message sending, toolbar sync, and state.
- View delegates all operations to controller via `ControllerDeps` and `ControllerCallbacks` interfaces.

## 0.0.27 - 2026-05-26

### Fixed
- Eliminated all 33 ESLint `@typescript-eslint/no-explicit-any` warnings across codebase.
- Replaced `as any` casts in `buildMcpServers()` with proper `McpServerConfig` discriminated union narrowing.
- Replaced `as any` casts in `addMcpServerBlock()` with `Extract<McpServerConfig, ...>` type assertions.
- Replaced `Object.assign` + `delete` pattern in MCP type switching with direct array entry replacement.
- Used `Record<string, unknown>[]` instead of `any[]` in `parseSessionUpdate` content mapping.

## 0.0.26 - 2026-05-26

### Added
- Introduce `SessionUpdateNormalizer` in client to encapsulate and normalize session updates and chunks into `NormalizedUpdate` states.
- Offload chunk aggregation logic from `StreamController` to client-side.

## 0.0.25 - 2026-05-26

### Tooling
- Add ESLint, Prettier, simple-git-hooks, and lint-staged configuration for conservative TypeScript linting and formatting.
- Ignore generated build artifacts, release output, and local QA vault data.
- Add a non-blocking CI lint step.

### Documentation
- Add English and Chinese ACP capability matrices to the README.

### Known issues
- `npm run lint` currently reports 32 warnings in existing source files.

## 0.0.24 - 2026-05-26

### Added
- Add typed ACP agent capabilities covering session, prompt, MCP, and authentication metadata.
- Show OpenCode authentication methods in the welcome view with terminal login guidance when reported by the agent.

### Changed
- Drive session dropdown controls, image drag-and-drop, and MCP type options from negotiated agent capabilities.
- Disable unsupported session and MCP actions with localized explanatory labels.

### Tested
- Add unit coverage for welcome auth method rendering, session capability combinations, image drop rejection, and MCP type disabling.

## 0.0.23 - 2026-05-26

### Added
- Add `requestWithFallback` to `AcpClient` to gracefully handle method name changes across different OpenCode CLI versions, falling back to legacy JSON-RPC method aliases when encountering `-32601` (Method not found) errors. Cache successful method names to eliminate redundant fallback attempts on subsequent calls.

## 0.0.22

### Added
- Added support for `http` and `sse` MCP servers in settings and ACP configuration output.
- Added support for `terminal` content in `tool_call_update` payloads for future terminal capabilities.
- Added `mimeType` property to `PromptPart.resource` in types.
- Added unit tests covering the new discriminated unions for MCP server configurations.

### Changed
- Converted `McpServerConfig` into a discriminated union.
- Updated settings UI to display a Type dropdown for selecting `stdio`, `http`, or `sse` MCP servers.

## 0.0.21 - 2026-05-26

### Changed
- Add comprehensive unit tests for full module coverage (36 test files, 403 tests):
  - `utils/vault.ts` — 12 tests for getVaultPath function
  - `client/agent.ts` — 34 tests for AgentRuntime delegation and permission handling
  - `client/AcpMethodNames.ts` — 25 tests for ACP method name aliases
  - `view/renderer.ts` — 31 tests for ChatRenderer message rendering
  - `view/dragDropManager.ts` — 13 tests for drag/drop file handling
  - `view/keybindingManager.ts` — 11 tests for keyboard shortcuts
  - `view/sessionDropdown.ts` — 12 tests for session list UI
  - `view/autocomplete.ts` — 19 tests for autocomplete dropdown
  - `i18n/locale.test.ts` — 5 tests for locale completeness validation

## 0.0.20 - 2026-05-26

### Fixed
- Sync manifest.json version to match package.json
- Fix TypeScript type errors in streamController.test.ts
- Remove coverage directory (should have been deleted by PR #20)

### Changed
- Add PLANNING_REPORT.md with architecture and planning report
- Improve test coverage for ChatInput, StreamController, getLocale, AcpSubprocess

## 0.0.19 - 2026-05-25

### Changed
- Integrate AcpJsonRpcTransport into AcpClient, replacing inline readline/JSON-RPC logic
- Integrate AcpSubprocess into AcpClient, replacing direct child_process.spawn usage
- AcpClient now delegates transport to AcpJsonRpcTransport and process lifecycle to AcpSubprocess
- Add 37 new unit tests for AcpJsonRpcTransport, AcpSubprocess, and AcpErrors (202 total)

## 0.0.18 - 2026-05-25

### Changed
- Extract ACP client layer into modular components for better maintainability:
  - `AcpMethodNames.ts` — Logical method name aliases for OpenCode CLI version compatibility
  - `AcpJsonRpcTransport.ts` — JSON-RPC transport with timeout support and notification handlers
  - `AcpSubprocess.ts` — Process lifecycle management (spawn, shutdown, stderr capture)
  - `AcpErrors.ts` — Hierarchical error types (transport, protocol, timeout, process exit)

## 0.0.17 - 2026-05-25

### Fixed
- Add `reject_always` to permission option kinds for correct safe-mode rejection handling.
- Parse and store `agentCapabilities` from ACP initialize response for capability negotiation.
- Persist `sessionInfo` (sessionId, title, cwd) from `session_info_update` into client snapshot.
- Add `audio` content type to `PromptPart` for ACP protocol alignment.
- Support MCP server environment variable configuration in settings UI and ACP transport.

## 0.0.16 - 2026-05-25

### Added
- Extract WelcomeView component from CoOberView for welcome page rendering and connection status display.
- Add event-driven i18n locale change mechanism (`onLocaleChange`) so child components self-manage locale updates instead of relying on parent imperative calls.
- Add unit tests for DragDropManager (6 tests), PermissionBanner (3 tests), InlineEditPanel (5 tests), and Mutex (3 tests).

### Changed
- ChatInput, InputToolbar, ChatRenderer, InlineEditPanel, DragDropManager, PermissionBanner, and WelcomeView register their own locale change listeners in constructors.
- Simplify CoOberView.refreshLocale() by removing manual child component locale update calls.

## 0.0.15 - 2026-05-25

### Fixed
- Sanitize sync note paths to prevent path traversal, absolute paths, drive letters, and illegal filename characters.
- Support `rawInput.path` fallback in sync rule path matching alongside existing `filePath`.
- Restore custom system prompt value display in Settings text area.
- Extract actual edited content from fenced code blocks in inline edit responses, stripping surrounding explanation text.
- Clean up ACP stream lifecycle: clear `activeStreamSessionId` and `chunkHandler` on complete/cancel, null out process reference on close.
- Use `once('close')` with kill fallback and 2s timeout in `disconnect()` to prevent hangs.

### Changed
- Extract drag-and-drop logic into `DragDropManager` component.
- Extract permission approval UI into `PermissionBanner` component.
- Extract inline edit diff panel into `InlineEditPanel` component.
- Replace manual ACP stdout buffer concatenation with `readline` interface for cleaner JSON-RPC line parsing.
- Change agent request timeout from fixed 5-minute total to idle timeout that resets on each streaming chunk.
- Add `Mutex` to `SyncEngine.process()` and session management to prevent concurrent Vault write conflicts and session race conditions.

## 0.0.14 - 2026-05-23

### Changed
- Defer OpenCode connection until first user action (send message or create session).
- Remove automatic connection during plugin startup, settings page load, and view initialization.
- Change autoConnect default from true to false for new installations.
- Update README documentation to reflect lazy connection behavior.

### Tested
- Add regression tests for deferred connection behavior.
- Verify plugin loads without blocking on OpenCode connection.

## 0.0.13 - 2026-05-22

### Fixed
- Preserve configured MCP servers when restoring existing OpenCode sessions.
- Initialize autocomplete after the chat input area is created.
- Deduplicate Co-Ober side leaves during plugin reload/open stress scenarios.
- Make Co-Ober view cleanup safe before the view finishes opening.

### Tested
- Add regression coverage for MCP session restore, autocomplete initialization, side leaf deduplication, and early view cleanup.
- Run high-pressure Obsidian regression smoke tests.

## 0.0.12 - 2026-05-22

### Changed
- Document custom agents and reusable custom skills in the English and Chinese feature lists.
- Mark completed roadmap and phase-plan items as done.

## 0.0.11 - 2026-05-22

### Added
- Add local custom agents and reusable custom skills with settings management and prompt injection.
- Load runtime agents, models, and skills/commands in Settings, and manage common models there.
- Limit the chat model selector to configured common models when common models are selected.

### Changed
- Apply configured default agent, model, and effort to newly created OpenCode sessions.

### Tested
- Add regression coverage for custom agent validation, prompt composition, common model filtering, runtime settings loading, and default session options.

## 0.0.10 - 2026-05-21

### Fixed
- Keep ACP permission requests responsive when the Obsidian permission UI handler fails by falling back to a safe reject decision.
- Align ACP initialize client metadata with the plugin release version.

### Tested
- Re-ran the full test suite five times during pressure testing and added ACP regression coverage for permission fallback handling.
- Cover live plugin settings language refresh alongside open chat view refresh.

## 0.0.9 - 2026-05-21

### Changed
- Mark inline edit with diff preview as complete and add regression coverage for preview, apply, discard, and locale refresh behavior.

## 0.0.8 - 2026-05-21

### Fixed
- Apply saved English/Chinese language settings on plugin startup and refresh both the plugin settings tab and open Co-Ober views immediately after changing language in Settings.
- Complete i18n coverage for runtime notices, toolbar tooltips, inline edit UI and prompt, usage tooltips, sync failure messages, ACP errors, and default session titles.
- Harden permission handling so `safe` mode does not auto-approve tool requests when no UI permission handler is available.
- Prevent connection failures from blocking sidebar initialization, and avoid false “connected” states after failed reconnect attempts.
- Reject pending ACP requests when the OpenCode process exits or stdin is unavailable.
- Clear stale inline-edit state after apply, discard, session reset, or subsequent sends.
- Surface sync rule failures in the chat UI instead of only logging them to the console.
- Use byte-accurate note truncation and real file sizes for image attachment limits.

### Changed
- Split normal build and release packaging so `npm run build` validates version consistency without mutating release artifacts, while `npm run release` prepares release files.
- Update GitHub release workflow to use the release packaging script.

## 0.0.7 - 2026-05-21

### Added
- AI Edit Selection command: select text in any note and invoke to open sidebar with inline edit request
- SessionDropdown component extracted from main view
- Autocomplete component extracted from main view
- parseSessionUpdate, mergeAvailableCommands, extractConfigMeta ACP utilities
- Test coverage for chatState, session, mention, resolver, sync engine, and acp modules

## 0.0.6 - 2026-05-21

### Added
- Add configurable MCP server support for new OpenCode sessions
- Add Settings UI for enabling MCP servers with command and argument configuration

### Changed
- Sync local release artifacts automatically during production builds

## 0.0.5 - 2026-05-21

### Fixed
- Harden sync note generation for nested folders and non-string tool outputs
- Tighten Obsidian workspace, view, and sync typings to remove unsafe production casts

### Changed
- Remove ACP connection debug logs from production runtime
- Restore code block copy button labels through localized UI text

## 0.0.4 - 2026-05-21

### Added
- Add UI language setting with English/Chinese locale switch in Settings → Appearance

### Changed
- Wire i18n dictionaries through settings and interface labels for bilingual UX
- Refresh README with updated i18n feature notes and roadmap status

## 0.0.3 - 2026-05-20

### Fixed
- Fix `@` mention trigger false-positives in emails and paths
- Eliminate internal `(client as any).acp` property access with typed `setClientHandlers()`
- Log ACP write failures instead of silent returns
- Limit total pending image data to 10MB to prevent OOM
- Replace `any` with proper types in ACP protocol parsing and stream handling

## 0.0.2 - 2026-05-20

### Fixed
- Align default permission mode with safer behavior
- Persist auto-scroll setting and apply live to open views
- Prevent duplicate image attachments after sending
- Isolate sync rule failures and improve path pattern matching
- Update session timestamps during streaming output
- Improve Windows ACP spawn robustness without unsafe shells
- Stabilize auto-reference and connection status updates

## 0.0.1 - 2026-05-19

Initial release.

### Added
- Full OpenCode agent integration in Obsidian sidebar via ACP protocol
- Streaming responses with markdown, thinking blocks, tool calls, and plan panels
- Session management with persistence across restarts
- `@mention` notes to inject vault content as context
- Sync engine: tool call results written back to vault as notes
- Diff rendering for file edit operations
- Per-turn token usage and cost display
- Toolbar with model name, elapsed time, and stop button
- Resizable input area with drag handle
- Drag & drop files and images
- Session search and message timestamps
- Code block copy buttons
- Wikilink injection for vault file paths
- Auto-reconnect on OpenCode process crash
- Request timeout (5 minutes)
- Configurable session limits (max messages, retention days)
- Keyboard shortcuts: `Ctrl+N`, `Ctrl+L`, `Ctrl+Shift+C`
- Smart auto-scroll with "New messages" button
- GitHub Actions CI/CD with automatic release on tag push
