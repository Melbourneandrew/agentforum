import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { once } from "node:events";
import { createServer } from "node:http";
import { resolve } from "node:path";
import { setTimeout } from "node:timers/promises";
import { PostRecord, SearchResult } from "@agentforum/contracts";
import { Either, Option, Redacted, Schema } from "effect";

// CLI ownership only: no application-to-application runtime imports. The API's
// existing local command owns its DB, migrations, secrets and Worker finalizers.
export const startObservationFixture = async () => {
  const reservation = createServer();
  await new Promise<void>((done, reject) => {
    reservation.once("error", reject);
    reservation.listen(0, "127.0.0.1", done);
  });
  const { port } = Schema.decodeUnknownSync(
    Schema.Struct({ port: Schema.Int }),
  )(reservation.address());
  await new Promise<void>((done, reject) =>
    reservation.close((error) => {
      if (error) reject(error);
      else done();
    }),
  );
  const apiOrigin = "http://127.0.0.1:" + String(port);
  const api = spawn(
    process.execPath,
    ["--import", "tsx", "scripts/database-dev.ts"],
    {
      cwd: resolve("../api"),
      detached: true,
      stdio: ["ignore", "pipe", "pipe"],
      env: {
        ...process.env,
        LOCAL_API_PORT: String(port),
        WRANGLER_SEND_METRICS: "false",
      },
    },
  );
  // Private runtime output can contain config. Drain it, never echo it.
  api.stdout.resume();
  api.stderr.resume();
  const status = { failed: false };
  api.on("error", () => {
    status.failed = true;
  });
  let mode: "normal" | "failure" | "redirect" = "normal";
  let gate = Promise.resolve();
  let release = () => {
    /* The initial gate is already open. */
  };
  let forbidden = 0;
  let credentials = 0;
  let searches = 0;
  const proxy = createServer((request, response) => {
    const forward = async () => {
      const url = new URL(request.url ?? "/", apiOrigin);
      if (
        request.method !== "GET" ||
        url.origin !== apiOrigin ||
        url.pathname !== "/v1/search"
      ) {
        forbidden++;
        response.writeHead(405);
        response.end();
        return;
      }
      searches++;
      if (
        request.headers.authorization !== undefined ||
        request.headers.cookie !== undefined
      )
        credentials++;
      await gate;
      if (mode === "failure") {
        response.writeHead(503);
        response.end("controlled dependency failure");
        return;
      }
      if (mode === "redirect") {
        response.writeHead(302, {
          Location: "/v1/publish?payload=must-not-follow",
        });
        response.end();
        return;
      }
      const upstream = await fetch(url, {
        headers: { Accept: "application/json" },
        redirect: "manual",
      });
      const headers = new Headers(upstream.headers);
      for (const key of [
        "content-encoding",
        "content-length",
        "transfer-encoding",
      ])
        headers.delete(key);
      response.writeHead(upstream.status, Object.fromEntries(headers));
      response.end(Buffer.from(await upstream.arrayBuffer()));
    };
    void forward().catch(() => {
      if (!response.headersSent) response.writeHead(503);
      response.end();
    });
  });
  const stop = async () => {
    release();
    try {
      if (proxy.listening) {
        proxy.closeAllConnections();
        await new Promise<void>((done, reject) =>
          proxy.close((error) => {
            if (error) reject(error);
            else done();
          }),
        );
      }
    } finally {
      if (
        api.pid !== undefined &&
        api.exitCode === null &&
        api.signalCode === null
      ) {
        const exited = once(api, "exit");
        process.kill(-api.pid, "SIGTERM");
        await exited;
      }
    }
  };
  try {
    let ready = false;
    for (let attempt = 0; attempt < 300; attempt++) {
      if (status.failed || api.exitCode !== null || api.signalCode !== null)
        throw new Error(
          "Owned API fixture exited; private configuration not logged",
        );
      try {
        const response = await fetch(apiOrigin + "/v1/health", {
          signal: AbortSignal.timeout(500),
        });
        if (response.status === 200) {
          ready = true;
          break;
        }
      } catch {
        /* startup only */
      }
      await setTimeout(100);
    }
    assert.ok(ready, "Owned API/PostgreSQL fixture did not become ready");
    await new Promise<void>((done, reject) => {
      proxy.once("error", reject);
      proxy.listen(0, "127.0.0.1", done);
    });
    const address = Schema.decodeUnknownSync(
      Schema.Struct({ port: Schema.Int }),
    )(proxy.address());
    const origin = "http://127.0.0.1:" + String(address.port);
    const search = (payload: unknown) =>
      fetch(
        apiOrigin +
          "/v1/search?payload=" +
          encodeURIComponent(JSON.stringify(payload)),
        { signal: AbortSignal.timeout(10000) },
      );
    const allPosts = async () => {
      const posts: Schema.Schema.Type<typeof PostRecord>[] = [];
      let cursor = Option.none<string>();
      do {
        const payload = {
          limit: 50,
          ...Option.match(cursor, {
            onNone: () => ({}),
            onSome: (cursor) => ({ cursor }),
          }),
        };
        const response = await search(payload);
        assert.equal(response.status, 200);
        const page = Schema.decodeUnknownSync(SearchResult)(
          await response.json(),
        );
        posts.push(...page.posts);
        assert.ok(
          posts.length <= 1000,
          "Owned fixture returned unbounded results",
        );
        assert.equal(
          new Set(posts.map((post) => post.id)).size,
          posts.length,
          "Actual API cursor repeated Posts",
        );
        cursor = page.page_cursor;
      } while (Option.isSome(cursor));
      return posts;
    };
    const publish = async (
      key: Redacted.Redacted,
      body: string,
      metadata: Readonly<Record<string, unknown>>,
      replyTo = Option.none<string>(),
    ) => {
      const response = await fetch(apiOrigin + "/v1/publish", {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          Authorization: "Bearer " + Redacted.value(key),
        },
        body: JSON.stringify({
          body,
          metadata,
          ...Option.match(replyTo, {
            onNone: () => ({}),
            onSome: (reply_to) => ({ reply_to }),
          }),
        }),
      });
      assert.equal(response.status, 201, "Actual fixture publication failed");
      return Schema.decodeUnknownSync(PostRecord)(await response.json());
    };
    const register = async () => {
      const response = await fetch(apiOrigin + "/v1/register", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: "{}",
      });
      assert.equal(response.status, 201, "Actual fixture signup failed");
      const decoded = Schema.decodeUnknownEither(
        Schema.Struct({ api_key: Schema.Redacted(Schema.NonEmptyString) }),
      )(await response.json());
      if (Either.isLeft(decoded))
        throw new Error("Signup key shape invalid; private value not logged");
      return decoded.right.api_key;
    };
    const seed = async () => {
      const key = await register();
      const parent = await publish(
        key,
        "# Actual parent\n\nPublic integration content.",
        {
          title: "Actual parent",
          nested: { items: [{ safe: false, value: null }] },
        },
      );
      const reply = await publish(
        key,
        "Actual direct reply",
        { title: "Actual reply" },
        Option.some(parent.id),
      );
      const hostile = await publish(
        key,
        "# Hostile fixture\n\n<script>window.__untrustedExecuted=true</script>\n\n[do not run](" +
          apiOrigin +
          "/v1/publish?payload=untrusted)\n\n![do not load](https://untrusted.invalid/tracker.png)",
        {
          title: '<img src="https://untrusted.invalid/image" onerror="run()">',
          nested: {
            items: [{ value: "<iframe src=evil>", flag: false, empty: null }],
          },
        },
      );
      const fallback = await publish(
        key,
        "> ".repeat(100) + "Actual deep Markdown",
        { title: "Actual fallback Post" },
      );
      for (let index = 0; index < 46; index++)
        await publish(key, "Actual pagination fixture " + String(index), {
          title: "Pagination fixture " + String(index),
        });
      for (let group = 0; group < 7; group++) {
        const nextKey = await register();
        for (let index = 0; index < 50; index++)
          await publish(
            nextKey,
            "Actual deep fixture " + String(group) + "-" + String(index),
            { title: "Deep fixture " + String(group) + "-" + String(index) },
          );
      }
      return { parent, reply, hostile, fallback };
    };
    return {
      origin,
      apiOrigin,
      search,
      searchCount: () => searches,
      stop,
      allPosts,
      seed,
      concurrentPost: async () =>
        publish(await register(), "Actual concurrent publication", {
          title: "Concurrent publication",
        }),
      fail: () => {
        mode = "failure";
      },
      redirect: () => {
        mode = "redirect";
      },
      recover: () => {
        mode = "normal";
      },
      hold: () => {
        gate = new Promise<void>((done) => {
          release = done;
        });
        return () => {
          release();
          gate = Promise.resolve();
        };
      },
      assertBoundary: () => {
        assert.equal(
          forbidden,
          0,
          "Observer followed a redirect or attempted a non-read API route",
        );
        assert.equal(credentials, 0, "Observer forwarded browser credentials");
      },
    };
  } catch (error) {
    await stop();
    throw error;
  }
};
