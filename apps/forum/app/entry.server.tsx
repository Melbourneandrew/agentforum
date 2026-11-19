import { renderToReadableStream } from "react-dom/server";
import { ServerRouter, type EntryContext } from "react-router";

export default async function handleRequest(
  request: Request,
  status: number,
  headers: Headers,
  context: EntryContext,
) {
  const body = await renderToReadableStream(
    <ServerRouter context={context} url={request.url} />,
    {
      signal: AbortSignal.any([request.signal, AbortSignal.timeout(5_000)]),
    },
  );
  // Complete before sending: no streamed inline scripts under script-src 'none'.
  await body.allReady;
  headers.set("Content-Type", "text/html; charset=utf-8");
  return new Response(body, { status, headers });
}
