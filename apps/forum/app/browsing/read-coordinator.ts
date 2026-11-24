/** Browser-independent first-party read scheduling; no DOM, data engine or bootstrap. */
export const searchDebounceMs = 250;
export interface ReadPorts<Input, Result> {
  readonly read: (input: Input, signal: AbortSignal) => Promise<Result>;
  readonly intent: (input: Input) => void;
  readonly pending: (input: Input) => void;
  readonly commit: (input: Input, result: Result) => void;
  readonly failure: (input: Input) => void;
  readonly settled: (input: Input) => void;
  readonly delay?: (milliseconds: number, run: () => void) => () => void;
}
const delay = (milliseconds: number, run: () => void) => {
  const timer = setTimeout(run, milliseconds);
  return () => {
    clearTimeout(timer);
  };
};
const nothing = () => undefined;

/** Invalidate immediately, not when the next debounced read finally starts. */
export const makeReadCoordinator = <Input, Result>(
  ports: ReadPorts<Input, Result>,
) => {
  let revision = 0;
  let active = true;
  let cancelTimer: () => void = nothing;
  let abortRead: () => void = nothing;
  const invalidate = () => {
    revision++;
    cancelTimer();
    cancelTimer = nothing;
    abortRead();
    abortRead = nothing;
    return revision;
  };
  const start = async (input: Input, version: number) => {
    if (!active || version !== revision) return;
    const controller = new AbortController();
    abortRead = () => {
      controller.abort();
    };
    const current = () =>
      active && version === revision && !controller.signal.aborted;
    ports.pending(input);
    try {
      const result = await ports.read(input, controller.signal);
      if (current()) ports.commit(input, result);
    } catch {
      // Never expose dependency/exception payloads to the document or diagnostics.
      if (current()) ports.failure(input);
    } finally {
      if (current()) {
        abortRead = nothing;
        ports.settled(input);
      }
    }
  };
  return {
    change(input: Input) {
      if (!active) return;
      const version = invalidate();
      ports.intent(input);
      cancelTimer = (ports.delay ?? delay)(searchDebounceMs, () => {
        cancelTimer = nothing;
        void start(input, version);
      });
    },
    navigate(input: Input) {
      if (!active) return;
      const version = invalidate();
      ports.intent(input);
      void start(input, version);
    },
    dispose() {
      active = false;
      invalidate();
    },
  };
};
