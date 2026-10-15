import { describe, it, expect } from "vitest";
import {
  LOAD_REPLAY_END_KEY,
  LOAD_REPLAY_INDEX_KEY,
  LoadReplayMarker,
  LoadReplays,
  type ReplayNotification,
} from "../load-replay-marks.js";

type Note = ReplayNotification & { name: string };

function recorder() {
  const sent: Note[] = [];
  const send = async (notification: Note) => {
    sent.push(notification);
  };
  const marker = new LoadReplayMarker<Note>("s", send);
  return { sent, marker, send };
}

const note = (name: string, sessionId = "s", _meta?: Note["_meta"]): Note => ({
  sessionId,
  name,
  ...(_meta !== undefined ? { _meta } : {}),
});

describe("LoadReplayMarker", () => {
  it("indexes the replayed notifications in order and marks only the last as the end", async () => {
    const { sent, marker } = recorder();
    await marker.replayed(note("a"));
    await marker.replayed(note("b"));
    await marker.replayed(note("c"));
    await marker.finish(true);

    expect(sent).toEqual([
      { sessionId: "s", name: "a", _meta: { [LOAD_REPLAY_INDEX_KEY]: 0 } },
      { sessionId: "s", name: "b", _meta: { [LOAD_REPLAY_INDEX_KEY]: 1 } },
      {
        sessionId: "s",
        name: "c",
        _meta: { [LOAD_REPLAY_INDEX_KEY]: 2, [LOAD_REPLAY_END_KEY]: true },
      },
    ]);
  });

  it("holds the latest replayed notification until the next one arrives", async () => {
    const { sent, marker } = recorder();
    await marker.replayed(note("a"));
    expect(sent).toEqual([]);
    await marker.replayed(note("b"));
    expect(sent.map((n) => n.name)).toEqual(["a"]);
  });

  it("keeps the existing _meta keys", async () => {
    const { sent, marker } = recorder();
    await marker.replayed(note("a", "s", { claudeCode: { x: 1 }, other: true }));
    await marker.finish(true);

    expect(sent[0]._meta).toEqual({
      claudeCode: { x: 1 },
      other: true,
      [LOAD_REPLAY_INDEX_KEY]: 0,
      [LOAD_REPLAY_END_KEY]: true,
    });
  });

  it("sends nothing for an empty replay", async () => {
    const { sent, marker } = recorder();
    await marker.finish(true);
    expect(sent).toEqual([]);
  });

  it("sends no end mark for a replay that stopped part way", async () => {
    const { sent, marker } = recorder();
    await marker.replayed(note("a"));
    await marker.replayed(note("b"));
    await marker.finish(false);

    expect(sent.map((n) => n._meta)).toEqual([
      { [LOAD_REPLAY_INDEX_KEY]: 0 },
      { [LOAD_REPLAY_INDEX_KEY]: 1 },
    ]);
  });

  it("marks no notification of another session and keeps the order", async () => {
    const { sent, marker } = recorder();
    // Nothing is held yet, so the child notification goes out at once.
    await marker.replayed(note("child-0", "child"));
    await marker.replayed(note("spawn"));
    await marker.replayed(note("child-1", "child"));
    await marker.replayed(note("child-2", "child"));
    expect(sent.map((n) => n.name)).toEqual(["child-0"]);
    await marker.replayed(note("after"));
    await marker.finish(true);

    expect(sent.map((n) => [n.name, n._meta])).toEqual([
      ["child-0", undefined],
      ["spawn", { [LOAD_REPLAY_INDEX_KEY]: 0 }],
      ["child-1", undefined],
      ["child-2", undefined],
      ["after", { [LOAD_REPLAY_INDEX_KEY]: 1, [LOAD_REPLAY_END_KEY]: true }],
    ]);
  });

  it("puts the end mark on the last notification of the session when a child notification follows it", async () => {
    const { sent, marker } = recorder();
    await marker.replayed(note("spawn"));
    await marker.replayed(note("child", "child"));
    await marker.finish(true);

    expect(sent.map((n) => [n.name, n._meta])).toEqual([
      ["spawn", { [LOAD_REPLAY_INDEX_KEY]: 0, [LOAD_REPLAY_END_KEY]: true }],
      ["child", undefined],
    ]);
  });

  it("sends a live notification unmarked, after the held replayed one", async () => {
    const { sent, marker, send } = recorder();
    await marker.replayed(note("a"));
    const live = marker.other(() => send(note("live")));
    await marker.replayed(note("b"));
    await live;
    await marker.finish(true);
    await marker.other(() => send(note("later")));

    expect(sent.map((n) => [n.name, n._meta])).toEqual([
      ["a", { [LOAD_REPLAY_INDEX_KEY]: 0 }],
      ["live", undefined],
      ["b", { [LOAD_REPLAY_INDEX_KEY]: 1, [LOAD_REPLAY_END_KEY]: true }],
      ["later", undefined],
    ]);
  });

  it("sends a message at once when nothing is held", async () => {
    const { sent, marker, send } = recorder();
    await marker.other(() => send(note("first")));
    expect(sent.map((n) => n.name)).toEqual(["first"]);
  });

  it("keeps the call order of the replayed, the live, and the other session's messages", async () => {
    const { sent, marker, send } = recorder();
    await marker.replayed(note("a"));
    const live = marker.other(() => send(note("live-1")));
    await marker.replayed(note("child", "child"));
    const request = marker.other(async () => {
      await send(note("request"));
      return "answer";
    });
    const live2 = marker.other(() => send(note("live-2")));
    await marker.finish(true);

    await expect(request).resolves.toBe("answer");
    await Promise.all([live, live2]);
    expect(sent.map((n) => n.name)).toEqual(["a", "live-1", "child", "request", "live-2"]);
  });

  it("settles a live sender when its own message is delivered", async () => {
    let releaseLive!: () => void;
    const liveGate = new Promise<void>((resolve) => (releaseLive = resolve));
    const { marker } = recorder();
    await marker.replayed(note("a"));
    let liveSettled = false;
    const live = marker
      .other(() => liveGate)
      .then(() => {
        liveSettled = true;
      });
    await marker.finish(true);
    await new Promise((resolve) => setImmediate(resolve));
    expect(liveSettled).toBe(false);

    releaseLive();
    await live;
    expect(liveSettled).toBe(true);
  });

  it("gives each sender its own delivery error", async () => {
    const sent: string[] = [];
    const marker = new LoadReplayMarker<Note>("s", async (notification) => {
      if (notification.name === "a") throw new Error("a lost");
      sent.push(notification.name);
    });
    await marker.replayed(note("a"));
    const live = marker.other(async () => {
      throw new Error("live lost");
    });
    const liveError = live.then(
      () => undefined,
      (error: Error) => error.message,
    );

    // The error of `a` does not reach the update after it, nor the live sender.
    await expect(marker.replayed(note("b"))).resolves.toBeUndefined();
    expect(await liveError).toBe("live lost");
    // The replay gets the error of its own update when it finishes.
    await expect(marker.finish(true)).rejects.toThrow("a lost");
    expect(sent).toEqual(["b"]);
  });

  it("does not fail the replay with the error of a live sender", async () => {
    const { marker } = recorder();
    await marker.replayed(note("a"));
    const live = marker.other(async () => {
      throw new Error("live lost");
    });
    await expect(marker.finish(true)).resolves.toBeUndefined();
    await expect(live).rejects.toThrow("live lost");
  });
});

describe("LoadReplays", () => {
  it("queues the messages of a replaying session only, an elicitation completion included", async () => {
    const sent: string[] = [];
    const replays = new LoadReplays<Note>(async (notification) => {
      sent.push(notification.name);
    });
    const record = (name: string) => async () => {
      sent.push(name);
    };
    const replay = replays.start("s")!;
    expect(replays.start("s")).toBeUndefined();
    await replay.sessionUpdate(note("a"));

    const created = replays.createElicitation(
      { sessionId: "s", elicitationId: "e1" },
      record("create e1"),
    );
    const completed = replays.completeElicitation("e1", record("complete e1"));
    await replays.send("other", record("other session"));
    await replays.send(undefined, record("no session"));
    expect(sent).toEqual(["other session", "no session"]);

    await replay.finish(true);
    await Promise.all([created, completed]);
    expect(sent).toEqual(["other session", "no session", "a", "create e1", "complete e1"]);

    // After the replay, a message of the session goes out at once.
    await replays.send("s", record("later"));
    expect(sent.at(-1)).toBe("later");
  });

  it("queues the messages of a child session of the replaying session", async () => {
    const sent: string[] = [];
    const replays = new LoadReplays<Note>(async (notification) => {
      sent.push(notification.name);
    });
    const record = (name: string) => async () => {
      sent.push(name);
    };
    const replay = replays.start("s", (sessionId) => sessionId === "child")!;
    await replay.sessionUpdate(note("a"));

    const parent = replays.send("s", record("parent tool_call"));
    const child = replays.send("child", record("child update"));
    const request = replays.send("child", async () => {
      sent.push("child request");
      return "allow";
    });
    await replays.send("stranger", record("stranger"));
    expect(sent).toEqual(["stranger"]);

    await replay.finish(true);
    await expect(request).resolves.toBe("allow");
    await Promise.all([parent, child]);
    expect(sent).toEqual(["stranger", "a", "parent tool_call", "child update", "child request"]);
  });

  it("forgets a URL elicitation that settles without accept", async () => {
    const sent: string[] = [];
    const replays = new LoadReplays<Note>(async (notification) => {
      sent.push(notification.name);
    });
    const respond = (action: string) => async () => {
      sent.push(`create ${action}`);
      return { action };
    };
    const replay = replays.start("s")!;
    await replay.sessionUpdate(note("a"));
    const declined = replays.createElicitation(
      { sessionId: "s", elicitationId: "declined" },
      respond("decline"),
    );
    const failed = replays.createElicitation({ sessionId: "s", elicitationId: "failed" }, () =>
      Promise.reject(new Error("lost")),
    );
    const accepted = replays.createElicitation(
      { sessionId: "s", elicitationId: "accepted" },
      respond("accept"),
    );
    await replay.finish(true);
    await expect(declined).resolves.toEqual({ action: "decline" });
    await expect(failed).rejects.toThrow("lost");
    await expect(accepted).resolves.toEqual({ action: "accept" });

    // While a new replay holds an update, only the completion of the accepted
    // elicitation still knows its session and waits in the queue.
    const before = sent.length;
    const again = replays.start("s")!;
    await again.sessionUpdate(note("b"));
    await replays.completeElicitation("declined", async () => void sent.push("complete declined"));
    await replays.completeElicitation("failed", async () => void sent.push("complete failed"));
    const completed = replays.completeElicitation(
      "accepted",
      async () => void sent.push("complete accepted"),
    );
    expect(sent.slice(before)).toEqual(["complete declined", "complete failed"]);
    await again.finish(true);
    await completed;
    expect(sent.slice(before)).toEqual([
      "complete declined",
      "complete failed",
      "b",
      "complete accepted",
    ]);
  });

  it("does not record a URL elicitation when no replay of its session runs", async () => {
    const sent: string[] = [];
    const replays = new LoadReplays<Note>(async (notification) => {
      sent.push(notification.name);
    });
    await replays.createElicitation({ sessionId: "s", elicitationId: "e1" }, async () => {
      sent.push("create e1");
      return { action: "accept" };
    });
    const replay = replays.start("s")!;
    await replay.sessionUpdate(note("a"));
    // The completion does not know the session, so it does not wait.
    await replays.completeElicitation("e1", async () => void sent.push("complete e1"));
    expect(sent).toEqual(["create e1", "complete e1"]);
    await replay.finish(true);
  });
});
