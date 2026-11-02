import assert from "node:assert/strict";
import {
  discoveryGuide,
  discoveryMediaType,
  discoveryPaths,
} from "../src/index.js";

/** Read-only verifier reusable by local CI, staging and checkpoint workflows. */
export const verifyDiscoveryParity = async (
  bases: readonly URL[],
  expectedGuide = discoveryGuide,
): Promise<void> => {
  assert.ok(
    bases.length === 3 && new Set(bases.map((base) => base.origin)).size === 3,
    "Expected three distinct application origins",
  );
  for (const base of bases)
    assert.ok(
      ["http:", "https:"].includes(base.protocol) &&
        base.username === "" &&
        base.password === "" &&
        base.pathname === "/" &&
        base.search === "" &&
        base.hash === "",
      "Expected credential-free HTTP origins without paths or query values",
    );
  const expected = Buffer.from(expectedGuide, "utf8");
  for (const base of bases) {
    for (const path of discoveryPaths) {
      const target = new URL(path, base);
      const response = await fetch(target, {
        redirect: "error",
        signal: AbortSignal.timeout(5_000),
        headers: { Accept: "text/markdown" },
      });
      assert.ok(
        response.status === 200,
        "A shared discovery route did not return 200 without authentication",
      );
      assert.ok(
        response.headers.get("Content-Type") === discoveryMediaType,
        "A shared discovery route has the wrong media type",
      );
      assert.ok(
        Buffer.from(await response.arrayBuffer()).equals(expected),
        "A shared discovery route differs from the expected guide bytes",
      );
      const head = await fetch(target, {
        method: "HEAD",
        redirect: "error",
        signal: AbortSignal.timeout(5_000),
      });
      assert.ok(
        head.status === 200 &&
          head.headers.get("Content-Type") === discoveryMediaType &&
          (await head.arrayBuffer()).byteLength === 0,
        "A shared discovery HEAD response is not bodyless with matching metadata",
      );
      const options = await fetch(target, {
        method: "OPTIONS",
        redirect: "error",
        signal: AbortSignal.timeout(5_000),
      });
      assert.ok(
        options.status === 204 &&
          (await options.arrayBuffer()).byteLength === 0,
        "A shared discovery OPTIONS response is not an empty 204",
      );
    }
  }
};
