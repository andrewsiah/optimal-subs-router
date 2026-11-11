---
name: optimal-subs-router
description: Use when someone has two or more LLM subscriptions with 5-hour and weekly usage limits, at one provider or several, behind one router or agent launcher, and wants it to try the subscriptions in the order that lets the least allowance expire unused. Builds a deterministic once-a-minute rotation with no model calls, plus a simulator to check it on their own request log.
---

# Rotate LLM subscriptions so allowance doesn't expire unused

## The rule

Every minute, sort the accounts and give the router that order:

1. Accounts with room come first. An account has no room if it is switched off, its quota can't be read, or any of its windows is at 98% or more.
2. Among accounts with room, those with a 5-hour window go first. That allowance is use-it-or-lose-it: an idle 5-hour window can't be spent later.
3. Inside each group, the account whose weekly limit resets soonest goes first. Its remainder is the next to expire.
4. Hold a new order for 15 minutes while its first account still has room, so the router doesn't flap. If the first account runs out, switch at once.

The reference implementation is `src/rotation.mjs`. It has no dependencies, so copy it rather than rewriting it. `decide()` returns `{ order, change, reason }`.

Don't put a model in this loop. It's a sort over a few numbers.

## Steps

1. **Find the quota source.** You need each account's weekly window (`used` %, `resetsAt`), its 5-hour window if it has one, and whether it is on. Use whatever the router, the provider's usage API or its CLI reports per account. If nothing reports the provider's own percentages and reset times, stop and tell the user. Guessing from local token counts leads to wrong decisions.
2. **Copy `src/rotation.mjs`** and map each account to `{ id, on, error, weekly, fiveHour, other }`. Put model-specific weekly windows in `other`.
3. **Write the adapter.** It reads the accounts, calls `decide()` with the current order and the last change time, and installs `order` when `change` is true.
   - `examples/rotate-from-json.mjs` does the deciding part: it takes a JSON array of accounts in the router's current order (a file or `-` for stdin), prints `{ time, order, change, reason, applied }`, and with `--apply CMD` pipes a new order to CMD as a JSON array. It records the change time in `$ROTATION_DIR/state.json` (default `~/.local/state/optimal-subs-router`) only after CMD exits 0, and refuses to run CMD if it can't write there. With `--apply` it holds a lock (a loopback port derived from the state directory) for the whole run.
   - The install command writes the order into whatever sets account priority or failover order in the router, then reads it back to check it.
4. **Run it dry first.** Schedule the adapter every minute (systemd timer, launchd or cron) without applying for a day. Log every decision as one JSON line. Show the user a few decisions, then switch on applying.
5. **Make it safe.** Add these to the install side; the example only covers deciding and recording.
   - Use a lock so two runs can't overlap, and one that the operating system frees when a run dies, such as listening on a loopback port derived from the state directory: a second run finds the port taken and exits. Lock files can go stale, and breaking stale ones safely is harder than it looks.
   - Put a timeout on every external call. Stop any helper process on exit, error or signal.
   - Never print or rewrite credentials. If you snapshot router config that holds keys, keep the copy private (0600).
   - Before each write, snapshot the router config and account metadata. After it, check that only the account order changed. If anything else changed, or the write or its check failed, put the old order back and leave a STOPPED marker that makes every later run refuse until a person checks the snapshot and deletes it. Don't restore other settings automatically, since only the person knows which change was intended.
   - Leave paid API-key fallbacks the way the user had them.
6. **Check the rule on their traffic** (next section). Report the numbers to the user, including if round-robin or their current order does as well.

## Check it on your own log

`src/simulate.mjs` replays a request log against the accounts and compares the rule, round-robin and every fixed order (with up to 5 accounts; above that, only the order in the file):

```bash
node src/simulate.mjs accounts.json demand.jsonl 2026-01-31T00:00:00Z 4 1
#                     accounts      requests     end of the week   weeks  demand scale
```

It takes the week ending at the given time and repeats it for `weeks` weeks. The first week is a warm-up; it reports the rest. The output gives each policy's `servedShare` (share of demand the subscriptions could serve), `allOutHoursPerWeek` (hours a week no account had quota left), `unservedHoursPerWeek` (hours a week more than 1% of the work asked went unserved) and `accountSwitchesPerWeek`, plus the mean and range over the fixed orders it ran. Rows with an invalid time, no `work` or token fields at all, or a negative or non-numeric value are dropped; the CLI reports how many in the top-level `invalidRows`. A row with some token fields counts the missing ones as 0.

`demand.jsonl` has one request per line: `{"t": ISO, "in", "out", "cache_read", "cache_write"}` token counts, or a precomputed `{"t", "work"}`. Most routers' usage logs can be mapped to these fields. Keep only successful requests that could have gone to these accounts.

`accounts.json` is a list of `{ id, weeklyResetsAt, weeklyWork, fiveHourPct, maxPctPerHour }`. Calibrate it from the account's own quota history (the weekly and 5-hour `used` % over time, as your router or the provider reports it):

- `weeklyResetsAt`: any past or future weekly reset time. Only the weekday and hour matter.
- `weeklyWork`: one week's allowance in work units. Take a stretch in one week where the weekly `used` % rose steadily and only this account served. Then `weeklyWork = 100 × (sum of workUnits() of its requests) / (rise in weekly used %)`.
- `fiveHourPct`: how much of the weekly allowance one 5-hour window holds, in percent. Take a 5-hour window whose `used` rose a lot (from near 0% to near 100% is best). Then `fiveHourPct = 100 × (rise in weekly used %) / (rise in 5-hour used %)`. For example, weekly up 12 points while the 5-hour window went up 100 gives 12. Use the median over several windows, or `null` if the plan has no 5-hour window.
- `maxPctPerHour` (optional): the fastest rise in weekly `used` % per hour you've seen. Leave it out for no cap.

The README's numbers come from a synthetic benchmark (`npm run bench`), not from anyone's real traffic. In it the rule beats round-robin when usage has quiet spells and demand is near the combined allowance: about 5 points of demand served with three busy weeks then a quiet week, about 4 after a break, and about 2 when usage swings day to day. Under steady nonstop demand the rule, round-robin and random tie. With busy weekdays and quiet weekends the rule is about half a point behind. A user with different plans or traffic can get a different ranking, which is why the simulator is included.

## Pitfalls

- A reading whose `resetsAt` has passed is stale; that window has renewed. `hasRoom()` treats it that way, so refresh the quota rather than trusting the old percentage.
- A 5-hour window starts at the first request after the last one ended, not on a fixed clock.
- Weekly resets are fixed per account and move in exact 7-day steps.
- Don't add expired 5-hour allowance to expired weekly allowance. They overlap.
- The 98% guard keeps a small reserve. Provider percentages are rounded, so a window at 99% can already be refusing requests.
- Under steady demand, round-robin does as well as the rule in simulation; the rule gains when usage has quiet spells or after a break, and can be slightly behind with busy weekdays and quiet weekends. The rule also keeps one conversation on one account for longer, and prompt caches are per account. That is reasoning, not a measurement. If the user's numbers favour round-robin and their router supports it, say so.
- The rule ignores providers. Mixing subscriptions from different providers only helps if the router can send the same task to either.
