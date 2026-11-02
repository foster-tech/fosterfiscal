import postgres from "postgres";

import {
  ClaimResult,
  DGII_TARGET_ENVIRONMENT,
  SubmissionInsert,
  JsonObject,
  SubmissionPatch,
  SubmissionRecord,
  SubmissionRepository,
  SubmissionStatus,
  StoredDgiiMessage,
} from "./submission-types";

type DbRow = {
  id: string;
  environment: string;
  issuer_rnc: string;
  encf: string;
  idempotency_key: string;
  input_hash: string;
  xml_hash: string;
  signed_xml_ciphertext: Buffer;
  signed_xml_iv: Buffer;
  signed_xml_auth_tag: Buffer;
  status: string;
  track_id: string | null;
  reception_http_status: number | null;
  dgii_status_code: number | null;
  dgii_status_text: string | null;
  sequence_used: boolean | null;
  messages: StoredDgiiMessage[] | null;
  diagnostic: JsonObject | null;
  submitted_at: Date | null;
  last_checked_at: Date | null;
  created_at: Date;
  updated_at: Date;
};

let client: ReturnType<typeof postgres> | undefined;

function database(): ReturnType<typeof postgres> {
  const connectionString = process.env.DATABASE_URL;
  if (!connectionString) throw new Error("DATABASE_URL nao configurada");
  client ??= postgres(connectionString, {
    max: 1,
    prepare: false,
    connect_timeout: 10,
    idle_timeout: 20,
  });
  return client;
}

function record(row: DbRow): SubmissionRecord {
  if (row.environment !== DGII_TARGET_ENVIRONMENT) {
    throw new Error("Ambiente persistido inesperado");
  }
  return {
    id: row.id,
    environment: DGII_TARGET_ENVIRONMENT,
    issuerRnc: row.issuer_rnc,
    encf: row.encf,
    idempotencyKey: row.idempotency_key,
    inputHash: row.input_hash,
    xmlHash: row.xml_hash,
    encryptedXml: {
      ciphertext: Buffer.from(row.signed_xml_ciphertext),
      iv: Buffer.from(row.signed_xml_iv),
      authTag: Buffer.from(row.signed_xml_auth_tag),
    },
    status: row.status as SubmissionStatus,
    trackId: row.track_id,
    receptionHttpStatus: row.reception_http_status,
    dgiiStatusCode: row.dgii_status_code,
    dgiiStatusText: row.dgii_status_text,
    sequenceUsed: row.sequence_used,
    messages: row.messages ?? [],
    diagnostic: row.diagnostic,
    submittedAt: row.submitted_at,
    lastCheckedAt: row.last_checked_at,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
  };
}

export class PostgresSubmissionRepository implements SubmissionRepository {
  async claim(input: SubmissionInsert): Promise<ClaimResult> {
    const sql = database();
    const inserted = await sql<DbRow[]>`
      INSERT INTO dgii_ecf_submissions (
        id, environment, issuer_rnc, encf, idempotency_key, input_hash,
        xml_hash, signed_xml_ciphertext, signed_xml_iv, signed_xml_auth_tag, status
      ) VALUES (
        ${input.id}, ${input.environment}, ${input.issuerRnc}, ${input.encf},
        ${input.idempotencyKey}, ${input.inputHash}, ${input.xmlHash},
        ${input.encryptedXml.ciphertext}, ${input.encryptedXml.iv},
        ${input.encryptedXml.authTag}, ${input.status}
      )
      ON CONFLICT DO NOTHING
      RETURNING *
    `;
    if (inserted[0]) return { kind: "claimed", record: record(inserted[0]) };

    const byKey = await sql<DbRow[]>`
      SELECT * FROM dgii_ecf_submissions
      WHERE environment = ${input.environment}
        AND idempotency_key = ${input.idempotencyKey}
      LIMIT 1
    `;
    if (byKey[0]) {
      const existing = record(byKey[0]);
      return existing.inputHash === input.inputHash
        ? { kind: "existing", record: existing }
        : { kind: "idempotency_conflict", record: existing };
    }

    const byDocument = await sql<DbRow[]>`
      SELECT * FROM dgii_ecf_submissions
      WHERE environment = ${input.environment}
        AND issuer_rnc = ${input.issuerRnc}
        AND encf = ${input.encf}
      LIMIT 1
    `;
    if (!byDocument[0]) {
      throw new Error("Nao foi possivel resolver o conflito atomico da submissao");
    }
    const existing = record(byDocument[0]);
    return existing.inputHash === input.inputHash
      ? { kind: "existing", record: existing }
      : { kind: "document_conflict", record: existing };
  }

  async findById(id: string): Promise<SubmissionRecord | null> {
    const rows = await database()<DbRow[]>`
      SELECT * FROM dgii_ecf_submissions WHERE id = ${id} LIMIT 1
    `;
    return rows[0] ? record(rows[0]) : null;
  }

  async update(id: string, patch: SubmissionPatch): Promise<SubmissionRecord> {
    const sql = database();
    const current = await this.findById(id);
    if (!current) throw new Error("Submissao nao encontrada");

    const next = { ...current, ...patch };
    const rows = await sql<DbRow[]>`
      UPDATE dgii_ecf_submissions SET
        status = ${next.status},
        track_id = ${next.trackId},
        reception_http_status = ${next.receptionHttpStatus},
        dgii_status_code = ${next.dgiiStatusCode},
        dgii_status_text = ${next.dgiiStatusText},
        sequence_used = ${next.sequenceUsed},
        messages = ${sql.json(next.messages)},
        diagnostic = ${next.diagnostic ? sql.json(next.diagnostic) : null},
        submitted_at = ${next.submittedAt},
        last_checked_at = ${next.lastCheckedAt},
        updated_at = NOW()
      WHERE id = ${id}
      RETURNING *
    `;
    if (!rows[0]) throw new Error("Submissao nao encontrada");
    return record(rows[0]);
  }
}
