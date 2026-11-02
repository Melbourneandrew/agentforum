import assert from "node:assert/strict";
import { once } from "node:events";
import { createServer } from "node:http";
import { describe, expect, it } from "vitest";
import { discoveryGuide, discoveryMediaType } from "../src/index.js";
import { verifyDiscoveryParity } from "../scripts/parity.js";

describe("reusable parity verification against real HTTP fixtures", () => {
  it("checks six distinct routes without credentials and rejects stale bytes, wrong media and repeated origins", async () => {
    let mode: "valid" | "stale" | "media" = "valid";
    let credentialsSeen = false;
    const requested = new Set<string>();
    const servers = [0, 1, 2].map((index) =>
      createServer((request, response) => {
        credentialsSeen ||=
          request.headers.authorization !== undefined ||
          request.headers.cookie !== undefined;
        requested.add(
          `${String(index)}:${request.method ?? ""}:${request.url ?? ""}`,
        );
        if (request.method === "OPTIONS") {
          response.writeHead(204);
          response.end();
          return;
        }
        response.setHeader(
          "Content-Type",
          index === 2 && mode === "media" ? "text/plain" : discoveryMediaType,
        );
        response.end(
          index === 2 && mode === "stale"
            ? `${discoveryGuide}stale`
            : discoveryGuide,
        );
      }),
    );
    try {
      const bases: URL[] = [];
      for (const server of servers) {
        server.listen(0, "127.0.0.1");
        await once(server, "listening");
        const address = server.address();
        assert.ok(address !== null && typeof address === "object");
        bases.push(new URL(`http://127.0.0.1:${String(address.port)}`));
      }
      await verifyDiscoveryParity(bases);
      expect(credentialsSeen).toBe(false);
      expect(requested.size).toBe(18);
      mode = "stale";
      await expect(verifyDiscoveryParity(bases)).rejects.toThrow(
        "differs from the expected guide bytes",
      );
      mode = "media";
      await expect(verifyDiscoveryParity(bases)).rejects.toThrow(
        "wrong media type",
      );
      const first = bases[0];
      assert.ok(first);
      await expect(
        verifyDiscoveryParity([first, first, first]),
      ).rejects.toThrow("distinct application origins");
    } finally {
      await Promise.all(
        servers.map(
          (server) =>
            new Promise<void>((resolve, reject) => {
              server.closeAllConnections();
              server.close((error) => {
                if (error) reject(error);
                else resolve();
              });
            }),
        ),
      );
    }
  });
});
