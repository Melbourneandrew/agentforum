import { tracing } from "cloudflare:workers";
import { Cause, Data, Deferred, Effect, Exit, Fiber, Option } from "effect";
import { describe, expect, it } from "vitest";
import {
  OperationalTracing,
  nativeOperationalTracingLayer,
  operationalTracingLayer,
} from "../src/telemetry/operational-tracing.js";

class DomainFailure extends Data.TaggedError("DomainFailure")<{
  secret: string;
}> {}
// Our driver contract double, never a fake cloudflare:workers module and never
// evidence of platform sampling, export, propagation or native span capture.
class Recorder {
  readonly names: string[] = [];
  readonly attributes: Record<string, boolean | number | string | undefined>[] =
    [];
  readonly statuses: { code: string }[] = [];
  ended = 0;
  constructor(readonly failingStage = "none") {}
  startSpan(name: string) {
    this.names.push(name);
    if (this.failingStage === "start")
      throw new Error("private-driver-failure");
    return {
      setAttributes: (
        attributes: Record<string, boolean | number | string | undefined>,
      ) => {
        this.attributes.push(attributes);
        if (this.failingStage === "attributes")
          throw new Error("private-driver-failure");
      },
      setStatus: (status: {
        code: "unset" | "ok" | "error";
        message?: string;
      }) => {
        this.statuses.push(status);
        if (this.failingStage === "status")
          throw new Error("private-driver-failure");
      },
      end: () => {
        this.ended++;
        if (this.failingStage === "end")
          throw new Error("private-driver-failure");
      },
    };
  }
}
const run = <A, E, R>(program: Effect.Effect<A, E, R>, recorder: Recorder) =>
  Effect.flatMap(OperationalTracing, (service) =>
    service.operation("identity.insert", program),
  ).pipe(Effect.provide(operationalTracingLayer(recorder)));

describe("non-read operational tracing in actual workerd", () => {
  it("uses the real native API with observability disabled without pretending it exported spans", async () => {
    expect(navigator.userAgent).toContain("Cloudflare-Workers");
    const span = tracing.startSpan("identity.insert");
    expect(span.isTraced).toBe(false);
    expect(span.spanContext().traceId).toBe("0".repeat(32));
    span.setAttributes({ "agentforum.operation": "identity.insert" });
    span.setStatus({ code: "ok" });
    span.end();
    expect(
      await Effect.runPromise(
        Effect.flatMap(OperationalTracing, (service) =>
          service.operation("credential.lookup", Effect.succeed(42)),
        ).pipe(Effect.provide(nativeOperationalTracingLayer)),
      ),
    ).toBe(42);
  });
  it("records only a fixed vocabulary and executes the original operation exactly once", async () => {
    const recorder = new Recorder();
    let calls = 0;
    expect(
      await Effect.runPromise(
        run(
          Effect.sync(() => {
            calls++;
            return "unmodified-result";
          }),
          recorder,
        ),
      ),
    ).toBe("unmodified-result");
    expect(calls).toBe(1);
    expect(recorder.names).toEqual(["identity.insert"]);
    expect(recorder.attributes).toEqual([
      {
        "service.name": "agentforum-api",
        "db.system.name": "postgresql",
        "db.operation.name": "INSERT",
        "agentforum.operation": "identity.insert",
      },
      { "agentforum.outcome": "success" },
    ]);
    expect(recorder.statuses).toEqual([{ code: "ok" }]);
    expect(recorder.ended).toBe(1);
  });
  it("preserves the typed original failure without publishing its sensitive payload or stack", async () => {
    const recorder = new Recorder();
    const secret =
      "key=plaintext&cursor=checkpoint&metadata=private&postgresql://user:password@host";
    const failure = new DomainFailure({ secret });
    const exit = await Effect.runPromiseExit(
      run(Effect.fail(failure), recorder),
    );
    expect(Exit.isFailure(exit)).toBe(true);
    if (Exit.isFailure(exit))
      expect(Cause.failureOption(exit.cause)).toEqual(Option.some(failure));
    expect(
      JSON.stringify({
        attributes: recorder.attributes,
        statuses: recorder.statuses,
        names: recorder.names,
      }),
    ).not.toContain(secret);
    expect(recorder.statuses).toEqual([{ code: "error" }]);
    expect(recorder.attributes.at(-1)).toEqual({
      "agentforum.outcome": "failure",
    });
    expect(recorder.ended).toBe(1);
  });
  it("does not swallow defects or report their uncontrolled exception messages", async () => {
    const recorder = new Recorder();
    const defect = new Error("secret-payload-defect");
    const exit = await Effect.runPromiseExit(run(Effect.die(defect), recorder));
    expect(Exit.isFailure(exit)).toBe(true);
    if (Exit.isFailure(exit))
      expect(Cause.dieOption(exit.cause)).toEqual(Option.some(defect));
    expect(JSON.stringify(recorder.attributes)).not.toContain(defect.message);
    expect(recorder.ended).toBe(1);
  });
  it("preserves interruption and releases the native span around the same fiber", async () => {
    const recorder = new Recorder();
    await Effect.runPromise(
      Effect.gen(function* () {
        const ready = yield* Deferred.make<boolean>();
        const fiber = yield* Effect.fork(
          run(
            Deferred.succeed(ready, true).pipe(Effect.zipRight(Effect.never)),
            recorder,
          ),
        );
        yield* Deferred.await(ready);
        const exit = yield* Fiber.interrupt(fiber);
        expect(
          Exit.isFailure(exit) && Cause.isInterruptedOnly(exit.cause),
        ).toBe(true);
      }),
    );
    expect(recorder.attributes.at(-1)).toEqual({
      "agentforum.outcome": "interrupted",
    });
    expect(recorder.ended).toBe(1);
  });
  it("never fails or retries the domain operation when instrumentation fails", async () => {
    for (const stage of ["start", "attributes", "status", "end"]) {
      const recorder = new Recorder(stage);
      let calls = 0;
      expect(
        await Effect.runPromise(
          run(
            Effect.sync(() => ++calls),
            recorder,
          ),
        ),
      ).toBe(1);
      expect(calls).toBe(1);
      expect(recorder.ended).toBe(stage === "start" ? 0 : 1);
      const failure = new DomainFailure({ secret: "unchanged" });
      const failed = await Effect.runPromiseExit(
        run(Effect.fail(failure), new Recorder(stage)),
      );
      expect(Exit.isFailure(failed)).toBe(true);
      if (Exit.isFailure(failed))
        expect(Cause.failureOption(failed.cause)).toEqual(Option.some(failure));
    }
  });
  it("uses a SELECT classification for credential lookups, without credential values", async () => {
    const recorder = new Recorder();
    await Effect.runPromise(
      Effect.flatMap(OperationalTracing, (service) =>
        service.operation("credential.lookup", Effect.void),
      ).pipe(Effect.provide(operationalTracingLayer(recorder))),
    );
    expect(recorder.names).toEqual(["credential.lookup"]);
    expect(recorder.attributes[0]).toMatchObject({
      "db.operation.name": "SELECT",
    });
  });
  it("keeps new material publication spans bounded and distinguishes edge from database work", async () => {
    const recorder = new Recorder();
    await Effect.runPromise(
      Effect.flatMap(OperationalTracing, (service) =>
        Effect.all([
          service.operation("publication.edge_signal", Effect.void),
          service.operation("publication.rate_limit", Effect.void),
          service.operation("publication.transaction", Effect.void),
        ]),
      ).pipe(Effect.provide(operationalTracingLayer(recorder))),
    );
    expect(recorder.names).toEqual([
      "publication.edge_signal",
      "publication.rate_limit",
      "publication.transaction",
    ]);
    expect(recorder.attributes[0]).toMatchObject({
      "agentforum.dependency": "edge-rate-limit",
    });
    expect(recorder.attributes[0]).not.toHaveProperty("db.system.name");
    expect(recorder.attributes[2]).toMatchObject({
      "db.system.name": "postgresql",
      "db.operation.name": "TRANSACTION",
    });
    expect(recorder.ended).toBe(3);
  });
});
