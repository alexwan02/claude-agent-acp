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
 * next one arrives, or with the end mark at {@link finish}. Every other message
 * that comes while one is held waits behind it in one FIFO queue, so nothing is
 * reordered. For example, a subagent's replayed history goes to its own
 * session id and gets no mark, but it still goes out after the parent's held
 * `tool_call`. A live `tool_call` update of the loaded session and the
 * `session/request_permission` of that tool call also wait, in call order.
 *
 * When the held notification goes out, the marker hands it and then each
 * queued message to the connection synchronously and in order, before it
 * awaits any of them.
 *
 * Each live sender ({@link other}) gets the result of its own message: its
 * promise settles when the connection settles that message, and a request
 * resolves with its response. A replayed notification cannot work that way.
 * The replay awaits each update before it sends the next, and the held update
 * goes out only with the next update or at {@link finish}. So
 * {@link replayed} settles when the update before it is delivered, which keeps
 * the replay in step with the client, and it does not reject. The first
 * delivery error of a replayed notification rejects {@link finish}. So the
 * error fails the replay, and not a later update or a live sender.
 */
export class LoadReplayMarker<N extends ReplayNotification> {
  private nextIndex = 0;
  private held: N | undefined;
  /** The messages that wait behind {@link held}, in call order. */
  private queued: (() => void)[] = [];
  private finished = false;
  /** The deliveries of the replayed notifications that have not settled. */
  private readonly inFlight = new Set<Promise<void>>();
  private failure: { error: unknown } | undefined;

  constructor(
    private readonly sessionId: string,
    private readonly deliver: (notification: N) => Promise<void>,
  ) {}

  /** A notification that the replay sends. Only one of the loaded session gets a mark. */
  replayed(notification: N): Promise<void> {
    if (this.finished) return call(() => this.deliver(notification));
    if (notification.sessionId !== this.sessionId) {
      if (this.held === undefined) return call(() => this.deliver(notification));
      this.queued.push(() => void this.track(notification));
      return Promise.resolve();
    }
    const marked = withMeta(notification, { [LOAD_REPLAY_INDEX_KEY]: this.nextIndex++ });
    const previous = this.release(false);
    this.held = marked;
    return previous;
  }

  /**
   * A message that is not part of the replay, such as a live update or a
   * permission request. It gets no mark. `send` runs at once when nothing is
   * held. Otherwise it runs right after the held notification goes out. The
   * promise settles with the result of `send`.
   */
  other<T>(send: () => Promise<T>): Promise<T> {
    if (this.held === undefined) return call(send);
    return new Promise<T>((resolve, reject) => {
      this.queued.push(() => void call(send).then(resolve, reject));
    });
  }

  /**
   * Sends what is still held. The held notification gets the end mark when
   * `complete` is true. A replay that stopped part way gets none, which tells
   * the client that the replay is truncated. Rejects with the first delivery
   * error of a replayed notification.
   */
  async finish(complete: boolean): Promise<void> {
    this.finished = true;
    void this.release(complete);
    await Promise.all(this.inFlight);
    if (this.failure) throw this.failure.error;
  }

  /**
   * Sends the held notification, with the end mark when `end` is true, and
   * then the queued messages. Settles when the held notification is delivered.
   */
  private release(end: boolean): Promise<void> {
    const held = this.held;
    const queued = this.queued;
    this.held = undefined;
    this.queued = [];
    if (held === undefined) return Promise.resolve();
    const delivered = this.track(end ? withMeta(held, { [LOAD_REPLAY_END_KEY]: true }) : held);
    for (const send of queued) send();
    return delivered;
  }

  /** Delivers a replayed notification and keeps its error for {@link finish}. */
  private track(notification: N): Promise<void> {
    const delivered = call(() => this.deliver(notification)).catch((error: unknown) => {
      this.failure ??= { error };
    });
    this.inFlight.add(delivered);
    void delivered.then(() => this.inFlight.delete(delivered));
    return delivered;
  }
}

/**
 * The replay markers of one connection, by session id. Every outbound message
 * of a session goes through {@link send}, so it waits behind the held
 * notification of a replay of that session. A message of a subagent child
 * session of the replaying session waits in the same queue, so the messages of
 * the whole session tree keep the call order. When no session of the tree
 * replays, {@link send} sends at once.
 */
export class LoadReplays<N extends ReplayNotification> {
  private readonly markers = new Map<string, Replaying<N>>();
  /**
   * The session of each URL elicitation that went to the queue of a replay.
   * The completion notification names only the elicitation. The entry goes
   * when the completion comes, or when the request settles without accept,
   * because then no completion comes.
   */
  private readonly elicitations = new Map<string, string>();

  constructor(private readonly deliver: (notification: N) => Promise<void>) {}

  /**
   * The marked replay of `sessionId`, or `undefined` when that session already
   * replays. `isChild` tells if a session is a subagent child session of
   * `sessionId`, at any depth. A live message of such a child, such as an
   * update or a permission request, then waits in the queue of `sessionId`.
   */
  start(
    sessionId: string,
    isChild: (sessionId: string) => boolean = () => false,
  ): LoadReplay<N> | undefined {
    if (this.markers.has(sessionId)) return undefined;
    const marker = new LoadReplayMarker<N>(sessionId, this.deliver);
    this.markers.set(sessionId, { marker, isChild });
    return {
      sessionUpdate: (notification) => marker.replayed(notification),
      finish: (complete) => {
        this.markers.delete(sessionId);
        return marker.finish(complete);
      },
    };
  }

  /** Runs `send`, which sends one message of `sessionId`, in the queue of that session. */
  send<T>(sessionId: unknown, send: () => Promise<T>): Promise<T> {
    const marker = this.marker(sessionId);
    return marker ? marker.other(send) : call(send);
  }

  /** Runs `send`, which sends an elicitation request, in the queue of the session that `params` names. */
  createElicitation<T>(params: object, send: () => Promise<T>): Promise<T> {
    // A request names a session, or the request that it belongs to. Only a
    // URL request names an elicitation id.
    const { sessionId, elicitationId } = params as { sessionId?: unknown; elicitationId?: unknown };
    const marker = this.marker(sessionId);
    if (!marker) return call(send);
    const sent = marker.other(send);
    if (typeof sessionId === "string" && typeof elicitationId === "string") {
      this.elicitations.set(elicitationId, sessionId);
      const forget = () => void this.elicitations.delete(elicitationId);
      sent.then((response) => {
        if ((response as { action?: unknown } | undefined)?.action !== "accept") forget();
      }, forget);
    }
    return sent;
  }

  /** Runs `send`, which completes an elicitation, in the queue of the session of its request. */
  completeElicitation<T>(elicitationId: string, send: () => Promise<T>): Promise<T> {
    const sessionId = this.elicitations.get(elicitationId);
    this.elicitations.delete(elicitationId);
    return this.send(sessionId, send);
  }

  /** The marker of the replay of `sessionId`, or of the replay whose child `sessionId` is. */
  private marker(sessionId: unknown): LoadReplayMarker<N> | undefined {
    if (typeof sessionId !== "string" || this.markers.size === 0) return undefined;
    const own = this.markers.get(sessionId);
    if (own) return own.marker;
    for (const replaying of this.markers.values()) {
      if (replaying.isChild(sessionId)) return replaying.marker;
    }
    return undefined;
  }
}

/** A replay in progress: its marker, and the test for the child sessions of its session. */
type Replaying<N extends ReplayNotification> = {
  marker: LoadReplayMarker<N>;
  isChild: (sessionId: string) => boolean;
};

/** The promise of `send`, or a rejected promise when `send` throws. */
function call<T>(send: () => Promise<T>): Promise<T> {
  try {
    return send();
  } catch (error) {
    return Promise.reject(error);
  }
}

/** `notification` with `meta` merged into its `_meta`. The existing keys stay. */
function withMeta<N extends ReplayNotification>(notification: N, meta: Record<string, unknown>): N {
  return { ...notification, _meta: { ...(notification._meta ?? {}), ...meta } };
}
