import assert from "node:assert/strict";
import test from "node:test";

import { DgiiAuthSession } from "../authentication";
import {
  DgiiGatewayError,
  DgiiStatusResult,
  submitEcfTest,
} from "./gateway";
import {
  refreshTestEcfStatus,
  sendTestEcf,
  SubmissionServiceError,
} from "./submission-service";
import {
  ClaimResult,
  SubmissionInsert,
  SubmissionPatch,
  SubmissionRecord,
  SubmissionRepository,
} from "./submission-types";
import { ECF31_SCHEMA } from "./xsd";

const NOW = new Date("2026-10-15T22:00:00.000Z");
const KEY = Buffer.alloc(32, 7).toString("base64");

const input = {
  document: {
    eNCF: "E310000000001",
    sequenceExpirationDate: "31-12-2027",
    incomeType: "01" as const,
    paymentType: 1 as const,
    amountsIncludeTax: false,
  },
  issuer: {
    rnc: "132071506",
    legalName: "Fostertech Solutions SRL",
    address: "C. Maximo Aviles Blonda #12, Julieta Morales, IM Plaza 2B, Santo Domingo, D.N.",
    issueDate: "15-10-2026",
  },
  buyer: {
    rnc: "133286556",
    legalName: "J E Garrido Holding EIRL",
  },
  items: [{
    name: "SERVICIO DE PRUEBA",
    kind: 2 as const,
    billingIndicator: 1 as const,
    quantity: "1.00",
    unitPrice: "100.0000",
  }],
  totals: {
    taxableAmount: "100.00",
    exemptAmount: "0.00",
    itbis: "18.00",
    total: "118.00",
  },
  signatureDateTime: "15-10-2026 18:00:00",
};

const prepared = {
  xml: '<?xml version="1.0" encoding="utf-8"?><ECF>signed</ECF>',
  totals: {
    taxableAmount: "100.00",
    taxableI1: "100.00",
    taxableI2: "0.00",
    taxableI3: "0.00",
    exemptAmount: "0.00",
    itbis: "18.00",
    itbisI1: "18.00",
    itbisI2: "0.00",
    itbisI3: "0.00",
    total: "118.00",
    lines: [{ amount: "100.00" }],
  },
  steps: [],
  schema: ECF31_SCHEMA,
};

function auth(): DgiiAuthSession {
  return {
    success: true,
    stage: "completed",
    httpStatus: 200,
    durationMs: 1,
    steps: [],
    authentication: { tokenReceived: true, issuedAt: null, expiresAt: null },
    verification: {
      certificateAndPrivateKey: "matched_and_current",
      signatureProfile: "valid",
      localCryptographicSignature: "valid",
      transmittedPayload: "byte_identical",
    },
    token: "secret-test-token",
  };
}

class MemoryRepository implements SubmissionRepository {
  readonly records = new Map<string, SubmissionRecord>();

  async claim(value: SubmissionInsert): Promise<ClaimResult> {
    const byKey = [...this.records.values()].find(
      (row) => row.environment === value.environment && row.idempotencyKey === value.idempotencyKey,
    );
    if (byKey) return byKey.inputHash === value.inputHash
      ? { kind: "existing", record: byKey }
      : { kind: "idempotency_conflict", record: byKey };
    const byDocument = [...this.records.values()].find(
      (row) => row.environment === value.environment && row.issuerRnc === value.issuerRnc && row.encf === value.encf,
    );
    if (byDocument) return byDocument.inputHash === value.inputHash
      ? { kind: "existing", record: byDocument }
      : { kind: "document_conflict", record: byDocument };
    const row: SubmissionRecord = {
      ...value,
      trackId: null,
      receptionHttpStatus: null,
      dgiiStatusCode: null,
      dgiiStatusText: null,
      sequenceUsed: null,
      messages: [],
      diagnostic: null,
      submittedAt: null,
      lastCheckedAt: null,
      createdAt: NOW,
      updatedAt: NOW,
    };
    this.records.set(row.id, row);
    return { kind: "claimed", record: row };
  }

  async findById(id: string): Promise<SubmissionRecord | null> {
    return this.records.get(id) ?? null;
  }

  async update(id: string, patch: SubmissionPatch): Promise<SubmissionRecord> {
    const current = this.records.get(id);
    if (!current) throw new Error("not found");
    const updated = { ...current, ...patch, updatedAt: NOW };
    this.records.set(id, updated);
    return updated;
  }
}

const config = {
  enabled: true,
  p12Base64: "configured",
  certificatePassword: "configured",
  storageEncryptionKeyBase64: KEY,
};

function dependencies(repository: SubmissionRepository) {
  return {
    repository,
    prepare: async () => prepared,
    authenticate: async () => auth(),
    now: () => NOW,
  };
}

test("recepcao com TrackId e chamadas concorrentes enviam uma unica vez", async () => {
  const repository = new MemoryRepository();
  let sends = 0;
  const deps = {
    ...dependencies(repository),
    submit: async () => {
      sends += 1;
      return { httpStatus: 200, durationMs: 3, trackId: "track-1", error: null, message: null };
    },
  };
  const [first, second] = await Promise.all([
    sendTestEcf(input, "same-key-123", config, deps),
    sendTestEcf(input, "same-key-123", config, deps),
  ]);
  assert.equal(sends, 1);
  assert.equal(first.id, second.id);
  assert.deepEqual(new Set([first.idempotentReplay, second.idempotentReplay]), new Set([false, true]));
  assert.equal((await repository.findById(first.id))?.status, "received");
});

test("a mesma Idempotency-Key com payload diferente e rejeitada", async () => {
  const repository = new MemoryRepository();
  const deps = {
    ...dependencies(repository),
    submit: async () => ({ httpStatus: 200, durationMs: 1, trackId: "track-2", error: null, message: null }),
  };
  await sendTestEcf(input, "conflict-key", config, deps);
  await assert.rejects(
    sendTestEcf({ ...input, buyer: { ...input.buyer, legalName: "OUTRO COMPRADOR" } }, "conflict-key", config, deps),
    (error: unknown) => error instanceof SubmissionServiceError && error.code === "idempotency_conflict",
  );
});

test("rejeicao de recepcao preserva diagnostico e nao cria TrackId", async () => {
  const repository = new MemoryRepository();
  const result = await sendTestEcf(input, "rejected-key", config, {
    ...dependencies(repository),
    submit: async () => ({
      httpStatus: 200,
      durationMs: 1,
      trackId: null,
      error: "E001",
      message: "e-NCF no autorizado",
    }),
  });
  assert.equal(result.status, "rejected");
  assert.equal(result.trackIdReceived, false);
  assert.match(String(result.diagnostic?.message), /no autorizado/);
});

test("timeout depois do POST fica indeterminado e a repeticao nao reenvia", async () => {
  const repository = new MemoryRepository();
  let sends = 0;
  const deps = {
    ...dependencies(repository),
    submit: async () => {
      sends += 1;
      throw new DgiiGatewayError("submit", "timeout", "timeout", null, true);
    },
  };
  const first = await sendTestEcf(input, "timeout-key", config, deps);
  const replay = await sendTestEcf(input, "timeout-key", config, deps);
  assert.equal(first.status, "indeterminate");
  assert.equal(replay.idempotentReplay, true);
  assert.equal(sends, 1);
});

test("token expirado na recepcao e classificado sem retry automatico", async () => {
  const repository = new MemoryRepository();
  let sends = 0;
  const result = await sendTestEcf(input, "expired-token", config, {
    ...dependencies(repository),
    submit: async () => {
      sends += 1;
      throw new DgiiGatewayError("submit", "authentication", "Nao autorizado", 401, false);
    },
  });
  assert.equal(result.status, "authentication_failed");
  assert.equal(sends, 1);
});

test("consulta evolui de em processamento para aceito", async () => {
  const repository = new MemoryRepository();
  const sent = await sendTestEcf(input, "pending-final", config, {
    ...dependencies(repository),
    submit: async () => ({ httpStatus: 200, durationMs: 1, trackId: "track-final", error: null, message: null }),
  });
  let attempt = 0;
  const queryStatus = async (): Promise<DgiiStatusResult> => {
    attempt += 1;
    const accepted = attempt === 2;
    return {
      httpStatus: 200,
      durationMs: 1,
      trackId: "track-final",
      code: accepted ? 1 : 3,
      officialStatus: accepted ? "Aceptado" : "En Proceso",
      normalizedStatus: accepted ? "accepted" : "processing",
      issuerRnc: input.issuer.rnc,
      encf: input.document.eNCF,
      sequenceUsed: accepted,
      receivedAt: null,
      messages: [],
    };
  };
  const pending = await refreshTestEcfStatus(sent.id, config, {
    ...dependencies(repository), queryStatus,
  });
  const final = await refreshTestEcfStatus(sent.id, config, {
    ...dependencies(repository), queryStatus,
  });
  assert.equal(pending.status, "processing");
  assert.equal(final.status, "accepted");
});

test("consulta final rejeitada preserva codigo e mensagem oficiais", async () => {
  const repository = new MemoryRepository();
  const sent = await sendTestEcf(input, "status-rejected", config, {
    ...dependencies(repository),
    submit: async () => ({ httpStatus: 200, durationMs: 1, trackId: "track-r", error: null, message: null }),
  });
  const result = await refreshTestEcfStatus(sent.id, config, {
    ...dependencies(repository),
    queryStatus: async () => ({
      httpStatus: 200,
      durationMs: 1,
      trackId: "track-r",
      code: 2,
      officialStatus: "Rechazado",
      normalizedStatus: "rejected",
      issuerRnc: input.issuer.rnc,
      encf: input.document.eNCF,
      sequenceUsed: false,
      receivedAt: null,
      messages: [{ code: 101, value: "Secuencia no autorizada" }],
    }),
  });
  assert.equal(result.status, "rejected");
  assert.equal(result.official.code, 2);
  assert.equal(result.official.sequenceUsed, false);
});

test("resultado indeterminado e reconciliado por RNC/e-NCF sem novo POST", async () => {
  const repository = new MemoryRepository();
  const sent = await sendTestEcf(input, "reconcile-key", config, {
    ...dependencies(repository),
    submit: async () => {
      throw new DgiiGatewayError("submit", "network", "network", null, true);
    },
  });
  let submissions = 0;
  const result = await refreshTestEcfStatus(sent.id, config, {
    ...dependencies(repository),
    submit: async () => {
      submissions += 1;
      throw new Error("nao deve enviar");
    },
    queryTrackIds: async () => ({
      httpStatus: 200,
      durationMs: 1,
      candidates: [{ trackId: "recovered-track", officialStatus: "En Proceso", receivedAt: null }],
    }),
    queryStatus: async () => ({
      httpStatus: 200,
      durationMs: 1,
      trackId: "recovered-track",
      code: 3,
      officialStatus: "En Proceso",
      normalizedStatus: "processing",
      issuerRnc: input.issuer.rnc,
      encf: input.document.eNCF,
      sequenceUsed: null,
      receivedAt: null,
      messages: [],
    }),
  });
  assert.equal(result.status, "processing");
  assert.equal(result.trackIdReceived, true);
  assert.equal(submissions, 0);
});

test("trava de envio desativada impede preparo, autenticacao e POST", async () => {
  const repository = new MemoryRepository();
  let preparedCount = 0;
  await assert.rejects(
    sendTestEcf(input, "disabled-key", { ...config, enabled: false }, {
      repository,
      prepare: async () => { preparedCount += 1; return prepared; },
      authenticate: async () => auth(),
    }),
    (error: unknown) => error instanceof SubmissionServiceError && error.code === "submission_disabled",
  );
  assert.equal(preparedCount, 0);
  assert.equal(repository.records.size, 0);
});

test("gateway envia bytes exatos no campo multipart xml e nome oficial", async () => {
  const xml = prepared.xml;
  const result = await submitEcfTest({
    xml,
    issuerRnc: input.issuer.rnc,
    encf: input.document.eNCF,
    token: "not-returned",
  }, async (_url, init) => {
    assert.equal(init?.method, "POST");
    const form = init?.body as FormData;
    const part = form.get("xml");
    assert.ok(part instanceof File);
    assert.equal(part.name, "132071506E310000000001.xml");
    assert.equal(await part.text(), xml);
    return new Response(JSON.stringify({ trackId: "track-bytes", error: null, mensaje: null }), {
      status: 200,
      headers: { "content-type": "application/json" },
    });
  });
  assert.equal(result.trackId, "track-bytes");
});
