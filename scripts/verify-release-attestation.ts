import { resolve } from "node:path";
import {
  RELEASE_ATTESTATION_ASSET_NAME,
  RELEASE_MANIFEST_ASSET_NAME,
} from "../apps/server/src/updater/constants";
import { parseReleaseManifest } from "../apps/server/src/updater/manifest";
import { verifyReleaseAttestation } from "../apps/server/src/updater/trust";

const assetDirectory = Bun.argv[2];
if (assetDirectory === undefined) {
  throw new Error(
    "Usage: bun run scripts/verify-release-attestation.ts <release-asset-directory>",
  );
}

const directory = resolve(assetDirectory);
const manifestFile = Bun.file(
  resolve(directory, RELEASE_MANIFEST_ASSET_NAME),
);
const manifestBytes = new Uint8Array(await manifestFile.arrayBuffer());
const manifest = parseReleaseManifest(
  JSON.parse(new TextDecoder().decode(manifestBytes)) as unknown,
);
const bundle = await Bun.file(
  resolve(directory, RELEASE_ATTESTATION_ASSET_NAME),
).json();

verifyReleaseAttestation({
  bundle,
  manifest,
  manifestBytes,
});

console.log(
  `Verified ArchCode ${manifest.tag} release attestation with the embedded updater trust root`,
);
