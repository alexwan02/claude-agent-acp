/**
 * The marks of a `session/load` history replay, for an AIR client.
 *
 * ACP has no signal that a replay is over other than the `session/load`
 * response. The adapter replays the transcript while the Claude Code CLI
 * starts, so the whole history reaches the client long before the response.
 * AIR shows the history as soon as it sees the end mark, instead of waiting
 * for the response.
 *
 * The keys go into the notification `_meta` (`params._meta`), beside
 * `sessionId` and `update`. They are the keys AIR already reads from the
 * JetBrains cloud agent:
 *
 * - `loadSessionReplayIndex`: the 0-based position of the notification in the
 *   replay. It is on every replayed notification of the loaded session.
 * - `loadSessionEndOfRecordedHistory: true`: only on the last one.
 *
 * `loadSessionReplaySize` (the last index, not the count) is not sent: the
 * total is not known until the replay ends.
 */

export const LOAD_REPLAY_INDEX_KEY = "loadSessionReplayIndex";
export const LOAD_REPLAY_END_KEY = "loadSessionEndOfRecordedHistory";

/** A session update notification, v1 or v2: both have these fields. */
export type ReplayNotification = {
  sessionId: string;
  _meta?: { [key: string]: unknown } | null;
};

/**
 * The sender of one history replay. The replay sends each of its updates with
 * {@link sessionUpdate} and then calls {@link finish} once.
 */
export interface LoadReplay<N> {
  sessionUpdate(notification: N): Promise<void>;
  /** `complete` is false when the replay stopped part way or failed. */
  finish(complete: boolean): Promise<void>;
}

/** A {@link LoadReplay} that sends each update as is. */
export function unmarkedLoadReplay<N>(send: (notification: N) => Promise<void>): LoadReplay<N> {
  return { sessionUpdate: send, finish: async () => {} };
}

/**
 * Marks the replayed notifications of one session.
 *
 * The last notification is known only when the replay ends, so the marker
 * holds the latest replayed notification of the session and sends it when the
 * next one arrives, or with the end mark at {@link finish}. Any other
 * notification that arrives while one is held waits behind it, so nothing is
 * reordered. For example, a subagent's replayed history goes to its own
 * session id and gets no mark, but it still goes out after the parent's held
 * `tool_call`. A live update of the loaded session that the CLI start sends
 * during the replay also waits, and gets no mark.
 *
 * Each method hands its notifications to `deliver` synchronously and in
 * order, before it awaits any of them.
 */
export class LoadReplayMarker<N extends ReplayNotification> {
  private nextIndex = 0;
  private held: N | undefined;
  private queued: N[] = [];
  private finished = false;

  constructor(
    private readonly sessionId: string,
    private readonly deliver: (notification: N) => Promise<void>,
  ) {}

  /** A notification that the replay sends. Only one of the loaded session gets a mark. */
  replayed(notification: N): Promise<void> {
    if (this.finished || notification.sessionId !== this.sessionId) return this.other(notification);
    const marked = withMeta(notification, { [LOAD_REPLAY_INDEX_KEY]: this.nextIndex++ });
    const ready = this.release();
    this.held = marked;
    return this.sendAll(ready);
  }

  /** A notification that is not part of the replay. It gets no mark. */
  other(notification: N): Promise<void> {
    if (this.held === undefined) return this.deliver(notification);
    this.queued.push(notification);
    return Promise.resolve();
  }

  /**
   * Sends what is still held. The held notification gets the end mark when
   * `complete` is true. A replay that stopped part way gets none, which tells
   * the client that the replay is truncated.
   */
  finish(complete: boolean): Promise<void> {
    this.finished = true;
    const held = this.held;
    const ready = this.release();
    if (complete && held !== undefined) ready[0] = withMeta(held, { [LOAD_REPLAY_END_KEY]: true });
    return this.sendAll(ready);
  }

  /** The held notification and the ones queued behind it, in order. */
  private release(): N[] {
    const ready = this.held === undefined ? [] : [this.held, ...this.queued];
    this.held = undefined;
    this.queued = [];
    return ready;
  }

  private async sendAll(notifications: N[]): Promise<void> {
    await Promise.all(notifications.map((notification) => this.deliver(notification)));
  }
}

/** `notification` with `meta` merged into its `_meta`. The existing keys stay. */
function withMeta<N extends ReplayNotification>(notification: N, meta: Record<string, unknown>): N {
  return { ...notification, _meta: { ...(notification._meta ?? {}), ...meta } };
}
