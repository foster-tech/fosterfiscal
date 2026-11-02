import { createHash, randomUUID } from "node:crypto";

import {
  authenticateDgiiTest,
  DgiiAuthenticationError,
  DgiiAuthSession,
} from "../authentication";
import { Ecf31Input, parseEcf31Input, prepareEcf31 } from "./prepare";
import {
  DgiiGatewayError,
  DgiiStatusResult,
  queryEcfResultTest,
  queryTrackIdsTest,
  ReceptionResult,
  submitEcfTest,
} from "./gateway";
import { encryptSignedXml, loadStorageEncryptionKey } from "./storage-crypto";
import {
  DGII_TARGET_ENVIRONMENT,
  SubmissionRecord,
  SubmissionRepository,
} from "./submission-types";

export type SubmissionServiceConfig = {
  enabled: boolean;
  p12Base64: string;
  certificatePassword: string;
  storageEncryptionKeyBase64: string;
};

type PreparedEcf = Awaited<ReturnType<typeof prepareEcf31>>;

export type SubmissionDependencies = {
  repository: SubmissionRepository;
  prepare?: typeof prepareEcf31;
  authenticate?: (config: {
    p12Base64: string;
    certificatePassword: string;
  }) => Promise<DgiiAuthSession>;
  submit?: (input: {
    xml: string;
    issuerRnc: string;
    encf: string;
    token: string;
  }) => Promise<ReceptionResult>;
  queryStatus?: (trackId: string, token: string) => Promise<DgiiStatusResult>;
  queryTrackIds?: typeof queryTrackIdsTest;
  now?: () => Date;
};

export class SubmissionServiceError extends Error {
  constructor(
    public readonly code:
      | "submission_disabled"
      | "invalid_idempotency_key"
      | "idempotency_conflict"
      | "document_conflict"
      | "not_found"
      | "configuration",
    message: string,
    public readonly httpStatus: number,
    public readonly recordId?: string,
  ) {
    super(message);
    this.name = "SubmissionServiceError";
  }
}

function canonicalize(value: unknown): string {
  if (value === null || typeof value !== "object") return JSON.stringify(value);
  if (Array.isArray(value)) return `[${value.map(canonicalize).join(",")}]`;
  return `{${Object.entries(value as Record<string, unknown>)
    .sort(([a], [b]) => a.localeCompare(b))
    .map(([key, child]) => `${JSON.stringify(key)}:${canonicalize(child)}`)
    .join(",")}}`;
}

export function hashStructuredInput(value: unknown): string {
  return createHash("sha256").update(canonicalize(value), "utf8").digest("hex");
}

function sha256(value: string): string {
  return createHash("sha256").update(value, "utf8").digest("hex");
}

function validateIdempotencyKey(value: string | null): string {
  const key = value?.trim() ?? "";
  if (key.length < 8 || key.length > 200 || /[^\x21-\x7e]/.test(key)) {
    throw new SubmissionServiceError(
      "invalid_idempotency_key",
      "Idempotency-Key deve ter de 8 a 200 caracteres ASCII visiveis",
      400,
    );
  }
  return key;
}

function parsedInput(raw: unknown): Ecf31Input {
  const parsed = parseEcf31Input(raw);
  if (!parsed.value) {
    // prepareEcf31 produz o erro detalhado antes de este ponto no fluxo normal.
    throw new Error("Entrada validada deixou de ser reconhecida");
  }
  return parsed.value;
}

function safeDiagnostic(error: DgiiGatewayError | DgiiAuthenticationError) {
  if (error instanceof DgiiGatewayError) {
    return {
      stage: error.stage,
      category: error.type,
      message: error.message,
      httpStatus: error.httpStatus,
      possibleReceipt: error.afterPossibleReceipt,
    };
  }
  return {
    stage: error.stage,
    category: error.category,
    message: error.diagnostic,
    httpStatus: error.httpStatus,
    possibleReceipt: false,
  };
}

function authConfig(config: SubmissionServiceConfig) {
  return {
    p12Base64: config.p12Base64,
    certificatePassword: config.certificatePassword,
  };
}

function publicRecord(record: SubmissionRecord, replay: boolean) {
  return {
    id: record.id,
    environment: record.environment,
    issuerRnc: record.issuerRnc,
    encf: record.encf,
    status: record.status === "submitting" ? "indeterminate" : record.status,
    idempotentReplay: replay,
    trackIdReceived: Boolean(record.trackId),
    receptionHttpStatus: record.receptionHttpStatus,
    official: {
      code: record.dgiiStatusCode,
      status: record.dgiiStatusText,
      sequenceUsed: record.sequenceUsed,
      messages: record.messages,
    },
    diagnostic: record.diagnostic,
    submittedAt: record.submittedAt?.toISOString() ?? null,
    lastCheckedAt: record.lastCheckedAt?.toISOString() ?? null,
    createdAt: record.createdAt.toISOString(),
    updatedAt: record.updatedAt.toISOString(),
  };
}

async function prepareAndIdentify(
  raw: unknown,
  config: SubmissionServiceConfig,
  prepare: typeof prepareEcf31,
): Promise<{ prepared: PreparedEcf; input: Ecf31Input }> {
  const prepared = await prepare(raw, authConfig(config));
  return { prepared, input: parsedInput(raw) };
}

export async function sendTestEcf(
  raw: unknown,
  idempotencyHeader: string | null,
  config: SubmissionServiceConfig,
  dependencies: SubmissionDependencies,
) {
  if (!config.enabled) {
    throw new SubmissionServiceError(
      "submission_disabled",
      "O envio testecf esta desabilitado no servidor",
      503,
    );
  }
  const idempotencyKey = validateIdempotencyKey(idempotencyHeader);
  if (!config.p12Base64 || !config.certificatePassword) {
    throw new SubmissionServiceError(
      "configuration",
      "Certificado digital nao configurado",
      503,
    );
  }
  if (!config.storageEncryptionKeyBase64) {
    throw new SubmissionServiceError(
      "configuration",
      "Chave de criptografia do armazenamento nao configurada",
      503,
    );
  }

  const prepare = dependencies.prepare ?? prepareEcf31;
  const { prepared, input } = await prepareAndIdentify(raw, config, prepare);
  const inputHash = hashStructuredInput(raw);
  const xmlHash = sha256(prepared.xml);
  const encryptionKey = loadStorageEncryptionKey(config.storageEncryptionKeyBase64);
  const encryptedXml = encryptSignedXml(prepared.xml, encryptionKey);
  const claim = await dependencies.repository.claim({
    id: randomUUID(),
    environment: DGII_TARGET_ENVIRONMENT,
    issuerRnc: input.issuer.rnc,
    encf: input.document.eNCF,
    idempotencyKey,
    inputHash,
    xmlHash,
    encryptedXml,
    status: "submitting",
  });

  if (claim.kind === "idempotency_conflict") {
    throw new SubmissionServiceError(
      "idempotency_conflict",
      "A Idempotency-Key ja foi usada com dados diferentes",
      409,
      claim.record.id,
    );
  }
  if (claim.kind === "document_conflict") {
    throw new SubmissionServiceError(
      "document_conflict",
      "O RNC emissor e o e-NCF ja estao associados a outra entrada",
      409,
      claim.record.id,
    );
  }
  if (claim.kind === "existing") return publicRecord(claim.record, true);

  const authenticate = dependencies.authenticate ?? authenticateDgiiTest;
  let session: DgiiAuthSession;
  try {
    session = await authenticate(authConfig(config));
  } catch (error: unknown) {
    if (!(error instanceof DgiiAuthenticationError)) throw error;
    const updated = await dependencies.repository.update(claim.record.id, {
      status: "authentication_failed",
      diagnostic: safeDiagnostic(error),
    });
    return publicRecord(updated, false);
  }

  const submit = dependencies.submit ?? submitEcfTest;
  await dependencies.repository.update(claim.record.id, {
    status: "indeterminate",
    submittedAt: (dependencies.now ?? (() => new Date()))(),
    diagnostic: {
      stage: "submit",
      category: "attempt_started",
      message: "Tentativa de recepcao iniciada; aguarde o resultado persistido",
      possibleReceipt: true,
    },
  });
  try {
    const result = await submit({
      xml: prepared.xml,
      issuerRnc: input.issuer.rnc,
      encf: input.document.eNCF,
      token: session.token,
    });
    const received = Boolean(result.trackId);
    const updated = await dependencies.repository.update(claim.record.id, {
      status: received ? "received" : "rejected",
      trackId: result.trackId,
      receptionHttpStatus: result.httpStatus,
      diagnostic: received
        ? null
        : {
            stage: "submit",
            category: "dgii_rejection",
            message: result.message ?? result.error ?? "Recepcao sem TrackId",
            possibleReceipt: false,
          },
    });
    return publicRecord(updated, false);
  } catch (error: unknown) {
    if (!(error instanceof DgiiGatewayError)) throw error;
    const status = error.type === "authentication"
      ? "authentication_failed"
      : error.type === "http" && error.httpStatus !== null && error.httpStatus < 500
        ? "rejected"
        : error.afterPossibleReceipt
        ? "indeterminate"
        : "communication_failure";
    const updated = await dependencies.repository.update(claim.record.id, {
      status,
      receptionHttpStatus: error.httpStatus,
      diagnostic: safeDiagnostic(error),
    });
    return publicRecord(updated, false);
  }
}

async function authenticateForQuery(
  config: SubmissionServiceConfig,
  dependencies: SubmissionDependencies,
): Promise<DgiiAuthSession> {
  const authenticate = dependencies.authenticate ?? authenticateDgiiTest;
  return authenticate(authConfig(config));
}

export async function refreshTestEcfStatus(
  id: string,
  config: SubmissionServiceConfig,
  dependencies: SubmissionDependencies,
) {
  let stored = await dependencies.repository.findById(id);
  if (!stored || stored.environment !== DGII_TARGET_ENVIRONMENT) {
    throw new SubmissionServiceError("not_found", "Submissao nao encontrada", 404);
  }

  const queryable = ["submitting", "received", "processing", "not_found", "indeterminate", "communication_failure"];
  if (!queryable.includes(stored.status)) return publicRecord(stored, false);

  let session: DgiiAuthSession;
  try {
    session = await authenticateForQuery(config, dependencies);
  } catch (error: unknown) {
    if (!(error instanceof DgiiAuthenticationError)) throw error;
    stored = await dependencies.repository.update(id, {
      status: "communication_failure",
      lastCheckedAt: (dependencies.now ?? (() => new Date()))(),
      diagnostic: safeDiagnostic(error),
    });
    return publicRecord(stored, false);
  }

  if (!stored.trackId) {
    const queryTrackIds = dependencies.queryTrackIds ?? queryTrackIdsTest;
    try {
      const reconciliation = await queryTrackIds(
        stored.issuerRnc,
        stored.encf,
        session.token,
      );
      if (reconciliation.candidates.length !== 1) {
        stored = await dependencies.repository.update(id, {
          status: "indeterminate",
          lastCheckedAt: (dependencies.now ?? (() => new Date()))(),
          diagnostic: {
            stage: "reconcile_track_id",
            category: reconciliation.candidates.length === 0
              ? "not_found"
              : "ambiguous",
            message: reconciliation.candidates.length === 0
              ? "A consulta oficial ainda nao encontrou TrackId para o RNC/e-NCF"
              : "A consulta oficial retornou mais de um TrackId; revisao manual necessaria",
            candidateCount: reconciliation.candidates.length,
            possibleReceipt: true,
          },
        });
        return publicRecord(stored, false);
      }
      stored = await dependencies.repository.update(id, {
        trackId: reconciliation.candidates[0].trackId,
        status: "received",
        lastCheckedAt: (dependencies.now ?? (() => new Date()))(),
        diagnostic: null,
      });
    } catch (error: unknown) {
      if (!(error instanceof DgiiGatewayError)) throw error;
      stored = await dependencies.repository.update(id, {
        status: "communication_failure",
        lastCheckedAt: (dependencies.now ?? (() => new Date()))(),
        diagnostic: safeDiagnostic(error),
      });
      return publicRecord(stored, false);
    }
  }

  const queryStatus = dependencies.queryStatus ?? queryEcfResultTest;
  if (!stored.trackId) throw new Error("TrackId ausente apos reconciliacao");
  try {
    const result = await queryStatus(stored.trackId, session.token);
    stored = await dependencies.repository.update(id, {
      status: result.normalizedStatus,
      dgiiStatusCode: result.code,
      dgiiStatusText: result.officialStatus,
      sequenceUsed: result.sequenceUsed,
      messages: result.messages,
      lastCheckedAt: (dependencies.now ?? (() => new Date()))(),
      diagnostic: null,
    });
  } catch (error: unknown) {
    if (!(error instanceof DgiiGatewayError)) throw error;
    stored = await dependencies.repository.update(id, {
      status: "communication_failure",
      lastCheckedAt: (dependencies.now ?? (() => new Date()))(),
      diagnostic: safeDiagnostic(error),
    });
  }
  return publicRecord(stored, false);
}
