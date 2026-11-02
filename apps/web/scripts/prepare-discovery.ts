import { writeDiscoveryAssets } from "@agentforum/discovery-assets/build";
await writeDiscoveryAssets(new URL("../public/", import.meta.url));
