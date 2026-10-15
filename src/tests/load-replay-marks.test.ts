import { describe, it, expect } from "vitest";
import {
  LOAD_REPLAY_END_KEY,
  LOAD_REPLAY_INDEX_KEY,
  LoadReplayMarker,
  type ReplayNotification,
} from "../load-replay-marks.js";

type Note = ReplayNotification & { name: string };

function recorder() {
  const sent: Note[] = [];
  const marker = new LoadReplayMarker<Note>("s", async (notification) => {
    sent.push(notification);
  });
  return { sent, marker };
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
    const { sent, marker } = recorder();
    await marker.replayed(note("a"));
    await marker.other(note("live"));
    await marker.replayed(note("b"));
    await marker.finish(true);
    await marker.other(note("later"));

    expect(sent.map((n) => [n.name, n._meta])).toEqual([
      ["a", { [LOAD_REPLAY_INDEX_KEY]: 0 }],
      ["live", undefined],
      ["b", { [LOAD_REPLAY_INDEX_KEY]: 1, [LOAD_REPLAY_END_KEY]: true }],
      ["later", undefined],
    ]);
  });
});
