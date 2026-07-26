import {
  bundleFromJSON,
  type SerializedBundle,
} from "@sigstore/bundle";
import { TrustedRoot } from "@sigstore/protobuf-specs";
import {
  toSignedEntity,
  toTrustMaterial,
  Verifier,
} from "@sigstore/verify";
import trustedRootJson from "./trusted-root.json" with { type: "json" };
import {
  RELEASE_OWNER,
  RELEASE_REPOSITORY,
  RELEASE_WORKFLOW_PATH,
} from "./constants";
import { UpdateError } from "./errors";
import { sha256Bytes } from "./hash";
import type { ReleaseManifest } from "./manifest";

// TUF-verified Sigstore public-good root snapshot from:
// https://tuf-repo-cdn.sigstore.dev/targets/trusted_root.json
// Keep this embedded trust root fresh when preparing a release that rotates it.
const IN_TOTO_STATEMENT_TYPE = "https://in-toto.io/Statement/v1";
const SLSA_PROVENANCE_TYPE = "https://slsa.dev/provenance/v1";
const GITHUB_ACTIONS_ISSUER = "https://token.actions.githubusercontent.com";
const CERTIFICATE_REPOSITORY_OID = [1, 3, 6, 1, 4, 1, 57264, 1, 5];
const CERTIFICATE_REF_OID = [1, 3, 6, 1, 4, 1, 57264, 1, 6];

export interface VerifiedReleaseSubjects {
  readonly sha256ByName: ReadonlyMap<string, string>;
}

export function verifyReleaseAttestation(input: {
  bundle: unknown;
  manifest: ReleaseManifest;
  manifestBytes: Uint8Array;
}): VerifiedReleaseSubjects {
  try {
    const serialized = input.bundle as SerializedBundle;
    const bundle = bundleFromJSON(serialized);
    const trustedRoot = TrustedRoot.fromJSON(trustedRootJson);
    const verifier = new Verifier(toTrustMaterial(trustedRoot), {
      ctlogThreshold: 1,
      tlogThreshold: 1,
    });
    const identity = [
      "https://github.com",
      RELEASE_OWNER,
      RELEASE_REPOSITORY,
      RELEASE_WORKFLOW_PATH,
    ].join("/");
    verifier.verify(toSignedEntity(bundle), {
      extensions: { issuer: GITHUB_ACTIONS_ISSUER },
      subjectAlternativeName: `^${escapeRegex(identity)}@refs/tags/${escapeRegex(input.manifest.tag)}$`,
      oids: [
        {
          oid: { id: CERTIFICATE_REPOSITORY_OID },
          value: Buffer.from(`${RELEASE_OWNER}/${RELEASE_REPOSITORY}`),
        },
        {
          oid: { id: CERTIFICATE_REF_OID },
          value: Buffer.from(`refs/tags/${input.manifest.tag}`),
        },
      ],
    });

    const statement = parseStatement(serialized);
    const subjects = new Map<string, string>();
    for (const subject of statement.subject) {
      if (subjects.has(subject.name)) {
        throw new Error(`Duplicate attestation subject: ${subject.name}`);
      }
      subjects.set(subject.name, subject.digest.sha256);
    }
    const manifestDigest = sha256Bytes(input.manifestBytes);
    if (subjects.get("release-manifest.json") !== manifestDigest) {
      throw new Error("The attestation does not cover the downloaded release manifest");
    }
    for (const asset of input.manifest.assets) {
      if (subjects.get(asset.name) !== asset.sha256) {
        throw new Error(`The attestation does not match release asset ${asset.name}`);
      }
    }
    return { sha256ByName: subjects };
  } catch (error) {
    if (error instanceof UpdateError) throw error;
    throw new UpdateError(
      "UPDATE_ATTESTATION_INVALID",
      "The release was not signed by the official ArchCode release workflow",
      { cause: error },
    );
  }
}

function parseStatement(bundle: SerializedBundle): {
  subject: Array<{ name: string; digest: { sha256: string } }>;
} {
  const envelope = (bundle as {
    dsseEnvelope?: {
      payload?: unknown;
      payloadType?: unknown;
    };
  }).dsseEnvelope;
  if (
    envelope === undefined
    || envelope.payloadType !== "application/vnd.in-toto+json"
    || typeof envelope.payload !== "string"
  ) {
    throw new Error("Attestation bundle is missing an in-toto DSSE envelope");
  }
  const value = JSON.parse(Buffer.from(envelope.payload, "base64").toString("utf8")) as unknown;
  if (!isRecord(value)
    || value._type !== IN_TOTO_STATEMENT_TYPE
    || value.predicateType !== SLSA_PROVENANCE_TYPE
    || !Array.isArray(value.subject)) {
    throw new Error("Attestation statement is not SLSA provenance v1");
  }
  const subject = value.subject.map((candidate) => {
    if (!isRecord(candidate)
      || typeof candidate.name !== "string"
      || !isRecord(candidate.digest)
      || typeof candidate.digest.sha256 !== "string"
      || !/^[0-9a-f]{64}$/.test(candidate.digest.sha256)) {
      throw new Error("Attestation subject is invalid");
    }
    return {
      name: candidate.name,
      digest: { sha256: candidate.digest.sha256 },
    };
  });
  return { subject };
}

function escapeRegex(value: string): string {
  return value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}
