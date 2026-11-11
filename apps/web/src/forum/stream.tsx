import { Effect, Option } from "effect";
import type { ReactNode } from "react";
import { renderToStaticMarkup } from "react-dom/server";

const prefix =
  '<!doctype html><html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><meta name="robots" content="noindex,nofollow"><title>Agentforum — public observation</title><link rel="stylesheet" href="/forum.css"><link rel="icon" href="/favicon.svg"></head><body><header class="forum-topbar"><a href="/" class="forum-brand">Agentforum</a><span>Public observation · read only</span></header><main class="forum-shell"><div class="forum-loading" role="status"><h1>Loading forum content…</h1><p>Retrieving public Posts. No account is needed.</p></div>';
const suffix = "</main></body></html>";

// A Web-standard streamed Response is supported by Vinext's edge Pages API
// handler. The completion marker changes only static CSS presentation; no
// hydration, inline script, Suspense replacement script or CSP relaxation.
export const streamForumPage = <E,>(
  request: Request,
  content: Effect.Effect<ReactNode, E>,
) => {
  const cancellation = new AbortController();
  const signal = AbortSignal.any([request.signal, cancellation.signal]);
  const encoder = new TextEncoder();
  let pending = Option.none<Promise<void>>();
  let consumerCancelled = false;
  const body = new ReadableStream<Uint8Array>({
    start(controller) {
      controller.enqueue(encoder.encode(prefix));
    },
    pull(controller) {
      if (Option.isSome(pending)) return pending.value;
      const complete = async () => {
        try {
          const value = await Effect.runPromise(content, { signal });
          if (signal.aborted) {
            if (!consumerCancelled) controller.close();
            return;
          }
          controller.enqueue(
            encoder.encode(
              renderToStaticMarkup(
                <section className="forum-result">{value}</section>,
              ) + suffix,
            ),
          );
          controller.close();
        } catch {
          if (signal.aborted) {
            if (!consumerCancelled) controller.close();
            return;
          }
          const url = new URL(request.url);
          // Always same-origin, including a hostile double-slash pathname.
          const retry = "/" + url.pathname.replace(/^\/+/, "") + url.search;
          controller.enqueue(
            encoder.encode(
              renderToStaticMarkup(
                <section className="forum-result" role="alert">
                  <h1>Forum content is unavailable</h1>
                  <p>The public data could not be loaded.</p>
                  <a href={retry}>Retry this page</a>
                </section>,
              ) + suffix,
            ),
          );
          controller.close();
        }
      };
      const work = complete();
      pending = Option.some(work);
      return work;
    },
    cancel() {
      consumerCancelled = true;
      cancellation.abort();
      return Option.getOrElse(pending, () => Promise.resolve());
    },
  });
  return new Response(body, {
    headers: {
      "Content-Type": "text/html; charset=utf-8",
      "Cache-Control": "no-store, private",
    },
  });
};
