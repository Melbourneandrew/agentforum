import { afterEach, describe, expect, it, vi } from "vitest";
import {
  makeReadCoordinator,
  searchDebounceMs,
} from "../app/browsing/read-coordinator";

const setup = () => {
  const pendingReads: {
    readonly input: string;
    readonly signal: AbortSignal;
    readonly result: ReturnType<typeof Promise.withResolvers<string>>;
  }[] = [];
  const ports = {
    read: vi.fn((input: string, signal: AbortSignal) => {
      const result = Promise.withResolvers<string>();
      pendingReads.push({ input, signal, result });
      return result.promise;
    }),
    intent: vi.fn<(input: string) => void>(),
    pending: vi.fn<(input: string) => void>(),
    commit: vi.fn<(input: string, result: string) => void>(),
    failure: vi.fn<(input: string) => void>(),
    settled: vi.fn<(input: string) => void>(),
  };
  return { ports, pendingReads, coordinator: makeReadCoordinator(ports) };
};
const flush = async () => {
  await Promise.resolve();
  await Promise.resolve();
};
afterEach(() => vi.useRealTimers());
describe("first-party pending-read/debounce coordinator (not production browser evidence)", () => {
  it("debounces rapid Text Query intents without declaring fake loading before a read", async () => {
    vi.useFakeTimers();
    const { coordinator, ports, pendingReads } = setup();
    coordinator.change("s");
    await vi.advanceTimersByTimeAsync(searchDebounceMs - 1);
    expect(ports.pending).not.toHaveBeenCalled();
    coordinator.change("sun");
    coordinator.change("sunrise");
    await vi.advanceTimersByTimeAsync(searchDebounceMs);
    expect(ports.read).toHaveBeenCalledTimes(1);
    expect(ports.pending).toHaveBeenCalledWith("sunrise");
    expect(ports.settled).not.toHaveBeenCalled();
    pendingReads[0]?.result.resolve("real read value");
    await flush();
    expect(ports.commit).toHaveBeenCalledWith("sunrise", "real read value");
    expect(ports.settled).toHaveBeenCalledWith("sunrise");
  });
  it("invalidates an in-flight response immediately on new typing, even before debounce expires", async () => {
    vi.useFakeTimers();
    const { coordinator, ports, pendingReads } = setup();
    coordinator.navigate("old URL");
    coordinator.change("new URL");
    expect(pendingReads[0]?.signal.aborted).toBe(true);
    pendingReads[0]?.result.resolve("obsolete result ignoring cancellation");
    await flush();
    expect(ports.commit).not.toHaveBeenCalled();
    expect(ports.settled).not.toHaveBeenCalled();
    await vi.advanceTimersByTimeAsync(searchDebounceMs);
    pendingReads[1]?.result.resolve("current result");
    await flush();
    expect(ports.commit).toHaveBeenCalledExactlyOnceWith(
      "new URL",
      "current result",
    );
  });
  it("keeps the latest result/loading/URL owner when actual promises resolve out of order", async () => {
    const { coordinator, ports, pendingReads } = setup();
    coordinator.navigate("first page");
    coordinator.navigate("second page");
    pendingReads[1]?.result.resolve("second page data");
    await flush();
    pendingReads[0]?.result.resolve("first page data late");
    await flush();
    expect(ports.commit).toHaveBeenCalledExactlyOnceWith(
      "second page",
      "second page data",
    );
    expect(ports.settled).toHaveBeenCalledExactlyOnceWith("second page");
    expect(ports.failure).not.toHaveBeenCalled();
  });
  it("navigation/popstate/retry bypass debounce and invalidate older timers/reads", async () => {
    vi.useFakeTimers();
    const { coordinator, ports, pendingReads } = setup();
    coordinator.change("pending typed search");
    coordinator.navigate("restored history URL");
    expect(ports.read).toHaveBeenCalledTimes(1);
    await vi.advanceTimersByTimeAsync(searchDebounceMs * 2);
    expect(ports.read).toHaveBeenCalledTimes(1);
    pendingReads[0]?.result.resolve("restored data");
    await flush();
    expect(ports.commit).toHaveBeenCalledWith(
      "restored history URL",
      "restored data",
    );
  });
  it("reports only current fixed failure, clears pending and permits a fresh retry", async () => {
    const { coordinator, ports, pendingReads } = setup();
    coordinator.navigate("retry URL");
    pendingReads[0]?.result.reject(new Error("private exception payload"));
    await flush();
    expect(ports.failure).toHaveBeenCalledExactlyOnceWith("retry URL");
    expect(ports.settled).toHaveBeenCalledWith("retry URL");
    coordinator.navigate("retry URL");
    pendingReads[1]?.result.resolve("recovered");
    await flush();
    expect(ports.commit).toHaveBeenCalledWith("retry URL", "recovered");
  });
  it("ignores stale failures and permanently stops timers/reads on disposal", async () => {
    vi.useFakeTimers();
    const { coordinator, ports, pendingReads } = setup();
    coordinator.navigate("old");
    coordinator.change("new");
    pendingReads[0]?.result.reject(new Error("stale private failure"));
    await flush();
    expect(ports.failure).not.toHaveBeenCalled();
    coordinator.dispose();
    await vi.advanceTimersByTimeAsync(searchDebounceMs);
    coordinator.navigate("after disposal");
    expect(ports.read).toHaveBeenCalledTimes(1);
    expect(ports.commit).not.toHaveBeenCalled();
    expect(ports.settled).not.toHaveBeenCalled();
  });
});
