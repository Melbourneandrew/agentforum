// Pure exact attachment scope. Worker/D1 grants and provider read indicators are
// not zone authority. This consumes only the trusted parent's separate grants.
import { isIP } from "node:net";
import { Effect, Schema } from "effect";
import { AccountId, failure } from "./model.js";
const Hostname = Schema.String.pipe(
  Schema.pattern(
    /^(?=.{1,253}$)(?:[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?\.)+[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?$/,
  ),
  Schema.filter((hostname) => isIP(hostname) === 0),
);
export const ZoneGrant = Schema.Struct({
  action: Schema.Literal("zone:attach"),
  zoneId: AccountId,
  hostname: Hostname,
});
const Route = Schema.Struct({
  pattern: Schema.NonEmptyString,
  zone_id: AccountId,
  custom_domain: Schema.optional(Schema.Boolean),
});
const Domain = Schema.Struct({ hostname: Hostname, zone_id: AccountId });
const Dictionary = Schema.Record({ key: Schema.String, value: Schema.Unknown });
const invalid = () =>
  failure("authorization", "zone-target-or-authority-invalid");
export const authorizeZoneTarget = (target: unknown, authority: unknown = []) =>
  Effect.gen(function* () {
    const raw = yield* Schema.decodeUnknown(Dictionary)(target).pipe(
      Effect.mapError(invalid),
    );
    const grants = yield* Schema.decodeUnknown(Schema.Array(ZoneGrant))(
      authority,
      { onExcessProperty: "error" },
    ).pipe(Effect.mapError(invalid));
    const routes = yield* Schema.decodeUnknown(Schema.Array(Route))(
      raw.routes === undefined ? [] : raw.routes,
      { onExcessProperty: "error" },
    ).pipe(Effect.mapError(invalid));
    const singular =
      raw.route === undefined || raw.route === ""
        ? []
        : [
            yield* Schema.decodeUnknown(Route)(raw.route, {
              onExcessProperty: "error",
            }).pipe(Effect.mapError(invalid)),
          ];
    if (singular.length && routes.length) return yield* Effect.fail(invalid());
    const domains = yield* Schema.decodeUnknown(Schema.Array(Domain))(
      raw.custom_domains === undefined ? [] : raw.custom_domains,
      { onExcessProperty: "error" },
    ).pipe(Effect.mapError(invalid));
    const targets = [
      ...domains.map((domain) => ({
        zoneId: domain.zone_id,
        hostname: domain.hostname,
      })),
    ];
    for (const route of [...routes, ...singular]) {
      // Require an explicit exact DNS hostname and zone ID. Wildcard hosts,
      // zone-name inference, userinfo/ports/query/fragments/encoded hostnames deny.
      const match = /^(?:https?:\/\/)?([^/?#:]+)(?:\/[^?#]*)?$/.exec(
        route.pattern,
      );
      const hostname = yield* Schema.decodeUnknown(Hostname)(match?.[1]).pipe(
        Effect.mapError(invalid),
      );
      if (route.custom_domain && route.pattern !== hostname)
        return yield* Effect.fail(invalid());
      targets.push({ zoneId: route.zone_id, hostname });
    }
    const key = (value: {
      readonly zoneId: string;
      readonly hostname: string;
    }) => `${value.zoneId}:${value.hostname}`;
    const requested = new Set(targets.map(key));
    const approved = new Set(grants.map(key));
    // Exact one-to-one set: no duplicate attachment, unused/extra broad grant or
    // accidental use of a grant for another zone/hostname. Never infer coverage.
    if (
      requested.size !== targets.length ||
      approved.size !== grants.length ||
      requested.size !== approved.size ||
      [...requested].some((value) => !approved.has(value))
    )
      return yield* Effect.fail(
        failure("authorization", "zone-attachment-authority-mismatch"),
      );
  });
