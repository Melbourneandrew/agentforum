import { Effect, Either } from "effect";
import { describe, expect, it } from "vitest";
import { authorizeZoneTarget } from "./zone-authority.js";
const zone = "a".repeat(32),
  other = "b".repeat(32),
  hostname = "forum.example.com";
const grant = { action: "zone:attach", zoneId: zone, hostname };
const route = { pattern: `${hostname}/*`, zone_id: zone };
const denied = async (target: unknown, grants: unknown = []) => {
  const result = await Effect.runPromise(
    Effect.either(authorizeZoneTarget(target, grants)),
  );
  expect(Either.isLeft(result) && result.left.stage).toBe("authorization");
};
describe("separate exact zone authority (pure, no credentials/providers)", () => {
  it("generic workers.dev target needs no zone grant and retains its trusted origin", async () => {
    const target = {
      workers_dev: true,
      vars: { CANONICAL_ORIGIN: "https://fixture.owner.workers.dev" },
      routes: [],
      custom_domains: [],
    };
    const original = structuredClone(target);
    await Effect.runPromise(authorizeZoneTarget(target));
    expect(target).toEqual(original);
  });
  it.each([
    { routes: [route] },
    { route },
    { routes: [{ pattern: hostname, zone_id: zone, custom_domain: true }] },
    { custom_domains: [{ hostname, zone_id: zone }] },
  ])("requires separate authority for attachment %j", async (target) => {
    await denied(target);
    const original = structuredClone(target);
    await Effect.runPromise(authorizeZoneTarget(target, [grant]));
    expect(target).toEqual(original);
  });
  it.each(
    [
      [{ ...grant, zoneId: other }],
      [{ ...grant, hostname: "other.example.com" }],
      [grant, { ...grant, zoneId: other }],
      [grant, grant],
      [{ ...grant, action: "worker:deploy" }],
      [{ ...grant, dnsEdit: true }],
    ].map((grants) => ({ grants })),
  )(
    "denies wrong/extra/duplicate/read-indicator authority %j",
    async ({ grants }) => {
      await denied({ routes: [route] }, grants);
    },
  );
  it("extra zone grant on zone-free target is not silently accepted", async () => {
    await denied({}, [grant]);
  });
  it.each([
    { routes: null },
    { custom_domains: null },
    { routes: [{ ...route, pattern: "127.0.0.1/*" }] },
    { routes: [`${hostname}/*`] },
    { routes: [{ pattern: `${hostname}/*`, zone_name: "example.com" }] },
    { routes: [{ ...route, pattern: "*.example.com/*" }] },
    { routes: [{ ...route, pattern: "https://forum.example.com:443/*" }] },
    { routes: [{ ...route, pattern: "https://user@forum.example.com/*" }] },
    { routes: [{ ...route, pattern: "https://%66orum.example.com/*" }] },
    { routes: [{ ...route, pattern: "forum.example.com/*?x=1" }] },
    { routes: [{ ...route, custom_domain: true }] },
    { routes: [route, route] },
    { route, routes: [route] },
    { custom_domains: [hostname] },
    { custom_domains: [{ hostname, zone_id: zone, extra: true }] },
  ])("denies ambiguous/expanded attachment %j", async (target) => {
    await denied(target, [grant]);
  });
});
