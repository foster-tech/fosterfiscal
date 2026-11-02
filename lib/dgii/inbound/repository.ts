import postgres from "postgres";

import type { EncryptedXml } from "../ecf/storage-crypto";

export type InboundDocumentKind = "ecf" | "commercial_approval";

export type InboundDocumentInsert = {
  id: string;
  kind: InboundDocumentKind;
  senderRnc: string;
  receiverRnc: string;
  encf: string;
  xmlHash: string;
  encryptedXml: EncryptedXml;
  encryptedResponse: EncryptedXml | null;
};

export interface InboundRepository {
  createSeed(input: {
    id: string;
    seedHash: string;
    expiresAt: Date;
  }): Promise<void>;
  consumeSeed(seedHash: string, consumedAt: Date): Promise<boolean>;
  claimDocument(input: InboundDocumentInsert): Promise<"stored" | "duplicate">;
}

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

export class PostgresInboundRepository implements InboundRepository {
  async createSeed(input: {
    id: string;
    seedHash: string;
    expiresAt: Date;
  }): Promise<void> {
    const sql = database();
    await sql.begin(async (transaction) => {
      await transaction`
        DELETE FROM dgii_inbound_auth_seeds
        WHERE expires_at < NOW() - INTERVAL '1 day'
      `;
      await transaction`
        INSERT INTO dgii_inbound_auth_seeds (id, seed_hash, expires_at)
        VALUES (${input.id}, ${input.seedHash}, ${input.expiresAt})
      `;
    });
  }

  async consumeSeed(seedHash: string, consumedAt: Date): Promise<boolean> {
    const rows = await database()<Array<{ id: string }>>`
      UPDATE dgii_inbound_auth_seeds
      SET consumed_at = ${consumedAt}
      WHERE seed_hash = ${seedHash}
        AND consumed_at IS NULL
        AND expires_at >= ${consumedAt}
      RETURNING id
    `;
    return rows.length === 1;
  }

  async claimDocument(input: InboundDocumentInsert): Promise<"stored" | "duplicate"> {
    const rows = await database()<Array<{ id: string }>>`
      INSERT INTO dgii_inbound_documents (
        id, document_kind, sender_rnc, receiver_rnc, encf, xml_hash,
        xml_ciphertext, xml_iv, xml_auth_tag,
        response_xml_ciphertext, response_xml_iv, response_xml_auth_tag
      ) VALUES (
        ${input.id}, ${input.kind}, ${input.senderRnc}, ${input.receiverRnc},
        ${input.encf}, ${input.xmlHash}, ${input.encryptedXml.ciphertext},
        ${input.encryptedXml.iv}, ${input.encryptedXml.authTag},
        ${input.encryptedResponse?.ciphertext ?? null},
        ${input.encryptedResponse?.iv ?? null},
        ${input.encryptedResponse?.authTag ?? null}
      )
      ON CONFLICT (document_kind, sender_rnc, receiver_rnc, encf) DO NOTHING
      RETURNING id
    `;
    return rows.length === 1 ? "stored" : "duplicate";
  }
}
