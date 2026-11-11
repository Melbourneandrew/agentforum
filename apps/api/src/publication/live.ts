import { Layer } from "effect";
import {
  databaseBindingsLayer,
  directDatabaseLayer,
} from "../database/database.js";
import {
  credentialConfigurationLayer,
  credentialCryptographyLayer,
} from "../identity/credentials.js";
import { identityRepositoryLayer } from "../identity/repository.js";
import { authenticationLayer } from "../identity/service.js";
import {
  PostIdentifiers,
  postIdentifiersLayer,
  postRepositoryLayer,
} from "../posts/repository.js";
import { edgeAbuseSignalLayer } from "./edge.js";
import { publicationLayer } from "./service.js";
export const publicationLive = (
  bindings: unknown,
  identifiers: Layer.Layer<PostIdentifiers> = postIdentifiersLayer,
) => {
  const direct = directDatabaseLayer.pipe(
    Layer.provide(databaseBindingsLayer(bindings)),
  );
  const authentication = authenticationLayer.pipe(
    Layer.provide(
      Layer.merge(
        identityRepositoryLayer.pipe(Layer.provide(direct)),
        credentialCryptographyLayer.pipe(
          Layer.provide(credentialConfigurationLayer(bindings)),
        ),
      ),
    ),
  );
  return publicationLayer.pipe(
    Layer.provide(
      Layer.mergeAll(
        authentication,
        postRepositoryLayer.pipe(
          Layer.provide(identifiers),
          Layer.provide(direct),
        ),
        edgeAbuseSignalLayer(bindings),
      ),
    ),
  );
};
