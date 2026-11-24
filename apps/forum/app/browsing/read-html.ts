import { selectReadTarget } from "./read-target";

// Eleven maximum sanitized Post bodies plus platform markup fit below this cap.
export const pageReadBytes = 16 * 1024 * 1024;
export const pageReadTimeoutMs = 35_000;
const failed = () => new Error("Public page read failed");
export interface HtmlRead {
  readonly html: string;
  readonly status: number;
}
export interface HtmlReadPorts {
  readonly request?: typeof fetch;
  readonly maximumBytes?: number;
}
/** Full authoritative SSR HTML, never a JSON API, mutation, preview or loopback. */
export async function readHtml(
  target: URL,
  current: URL,
  signal: AbortSignal,
  ports: HtmlReadPorts = {},
): Promise<HtmlRead> {
  if (selectReadTarget(target.href, current).kind !== "read") throw failed();
  const maximum = ports.maximumBytes ?? pageReadBytes;
  if (!Number.isSafeInteger(maximum) || maximum < 1 || maximum > pageReadBytes)
    throw failed();
  const boundedSignal = AbortSignal.any([
    signal,
    AbortSignal.timeout(pageReadTimeoutMs),
  ]);
  boundedSignal.throwIfAborted();
  const response = await (ports.request ?? fetch)(target.href, {
    method: "GET",
    mode: "same-origin",
    credentials: "omit",
    redirect: "error",
    cache: "no-store",
    referrerPolicy: "no-referrer",
    headers: { Accept: "text/html" },
    signal: boundedSignal,
  });
  if (
    response.redirected ||
    (response.url !== "" && response.url !== target.href) ||
    ![200, 400, 404, 500, 503].includes(response.status) ||
    !/^text\/html(?:\s*;|$)/i.test(
      response.headers.get("Content-Type") ?? "",
    ) ||
    response.body === null
  ) {
    await response.body?.cancel();
    throw failed();
  }
  const length = response.headers.get("Content-Length");
  if (length !== null && (!/^\d+$/.test(length) || Number(length) > maximum)) {
    await response.body.cancel();
    throw failed();
  }
  const reader = response.body.getReader();
  const decoder = new TextDecoder("utf-8", { fatal: true });
  let total = 0;
  let html = "";
  try {
    for (;;) {
      boundedSignal.throwIfAborted();
      const chunk = await reader.read();
      boundedSignal.throwIfAborted();
      if (chunk.done) break;
      total += chunk.value.byteLength;
      if (total > maximum) throw failed();
      html += decoder.decode(chunk.value, { stream: true });
    }
    html += decoder.decode();
    if (total === 0) throw failed();
    return { html, status: response.status };
  } finally {
    await reader.cancel();
    reader.releaseLock();
  }
}
