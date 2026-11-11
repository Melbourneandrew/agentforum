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
import { nativePostRepositoryLayer } from "../posts/repository.js";
import { edgeAbuseSignalLayer } from "./edge.js";
import { publicationLayer } from "./service.js";
export const publicationLive = (bindings: unknown) => {
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
        nativePostRepositoryLayer.pipe(Layer.provide(direct)),
        edgeAbuseSignalLayer(bindings),
      ),
    ),
  );
};
