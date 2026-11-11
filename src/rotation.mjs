// Which subscription account should the router try first?
//
// Rule: accounts with room come first. Among them, accounts that have a 5-hour
// window go first (that allowance is use-it-or-lose-it), then the rest. Inside
// each group, the account whose weekly limit resets soonest goes first.
//
// An account looks like:
//   { id, on?: boolean, error?: string,
//     weekly:   { used: 0..100, resetsAt: ISO },          // required
//     fiveHour: { used: 0..100, resetsAt: ISO } | null,   // null if the plan has none
//     other?:   [{ used: 0..100 }] }                      // e.g. model-specific weekly windows
// `used` is the percentage the vendor reports for that window.

export const FULL = 98; // At or above this percentage a window counts as used up.
export const HOLD_MS = 15 * 60_000; // Keep a new order this long while its first account still has room.
const WEEK_MS = 7 * 24 * 3_600_000;

// A window whose reset time has passed has renewed since it was read.
function usedNow(window, now) {
  const reset = Date.parse(window.resetsAt);
  return Number.isFinite(reset) && reset <= now ? 0 : window.used;
}

export function weeklyResetAt(account, now = Date.now()) {
  let reset = Date.parse(account.weekly?.resetsAt);
  if (!Number.isFinite(reset)) return Infinity;
  while (reset <= now) reset += WEEK_MS; // Weekly limits renew on a fixed 7-day cycle.
  return reset;
}

export function hasRoom(account, now = Date.now()) {
  if (account.on === false || account.error || !Number.isFinite(Date.parse(account.weekly?.resetsAt))) return false;
  const windows = [account.weekly, account.fiveHour, ...(account.other || [])].filter(Boolean);
  return windows.every(w => Number.isFinite(w.used) && w.used >= 0 && usedNow(w, Number(now)) < FULL);
}

export function compareAccounts(a, b, now = Date.now()) {
  const roomA = hasRoom(a, now), roomB = hasRoom(b, now);
  if (roomA !== roomB) return roomA ? -1 : 1;
  const group = x => (x.fiveHour ? 0 : 1);
  return group(a) - group(b) ||
    (weeklyResetAt(a, now) - weeklyResetAt(b, now) || 0) ||
    String(a.id).localeCompare(String(b.id), 'en');
}

export function orderAccounts(accounts, now = Date.now()) {
  return accounts.toSorted((a, b) => compareAccounts(a, b, now)).map(a => a.id);
}

// Decide whether to install a new order. A recent change is held while the
// current first account still has room, so the router doesn't flap; running
// out always switches at once.
export function decide({ accounts, currentOrder, lastChangeAt, now = Date.now(), holdMs = HOLD_MS }) {
  const order = orderAccounts(accounts, now);
  const first = accounts.find(a => a.id === currentOrder[0]);
  const firstHasRoom = first ? hasRoom(first, now) : false;
  const recent = Number.isFinite(Date.parse(lastChangeAt)) && Number(now) - Date.parse(lastChangeAt) < holdMs;
  const unchanged = order.length === currentOrder.length && order.every((id, i) => id === currentOrder[i]);
  const reason = unchanged ? 'unchanged' : !firstHasRoom ? 'first-account-out-of-room' : recent ? 'hold' : 'rule';
  return { order, change: reason === 'rule' || reason === 'first-account-out-of-room', reason };
}
