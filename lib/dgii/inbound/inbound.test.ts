import assert from "node:assert/strict";
import { createPrivateKey, randomBytes, webcrypto } from "node:crypto";
import test from "node:test";

import { X509CertificateGenerator, cryptoProvider } from "@peculiar/x509";

import type { EncryptedXml } from "../ecf/storage-crypto";
import {
  signSeedXml,
  signXmlDocument,
  type SigningMaterial,
  verifyXmlSignature,
} from "../xml-signature";
import type {
  InboundDocumentInsert,
  InboundRepository,
} from "./repository";
import {
  createAuthenticationSeed,
  InboundServiceError,
  receiveCommercialApproval,
  receiveEcf,
  validateCertificateAndIssueToken,
  type InboundConfig,
} from "./service";

cryptoProvider.set(webcrypto as unknown as Crypto);

class MemoryRepository implements InboundRepository {
  readonly seeds = new Map<string, { expiresAt: Date; consumed: boolean }>();
  readonly documents = new Map<string, {
    xml: EncryptedXml;
    response: EncryptedXml | null;
  }>();

  async createSeed(input: {
    id: string;
    seedHash: string;
    expiresAt: Date;
  }): Promise<void> {
    this.seeds.set(input.seedHash, { expiresAt: input.expiresAt, consumed: false });
  }

  async consumeSeed(seedHash: string, consumedAt: Date): Promise<boolean> {
    const seed = this.seeds.get(seedHash);
    if (!seed || seed.consumed || seed.expiresAt < consumedAt) return false;
    seed.consumed = true;
    return true;
  }

  async claimDocument(input: InboundDocumentInsert): Promise<"stored" | "duplicate"> {
    const key = `${input.kind}:${input.senderRnc}:${input.receiverRnc}:${input.encf}`;
    if (this.documents.has(key)) return "duplicate";
    this.documents.set(key, {
      xml: input.encryptedXml,
      response: input.encryptedResponse,
    });
    return "stored";
  }
}

async function material(name: string): Promise<SigningMaterial> {
  const algorithm = {
    name: "RSASSA-PKCS1-v1_5",
    hash: "SHA-256",
    publicExponent: new Uint8Array([1, 0, 1]),
    modulusLength: 2048,
  };
  const keys = (await webcrypto.subtle.generateKey(
    algorithm,
    true,
    ["sign", "verify"],
  )) as CryptoKeyPair;
  const certificate = await X509CertificateGenerator.createSelfSigned({
    serialNumber: randomBytes(8).toString("hex"),
    name: `CN=${name}`,
    notBefore: new Date(Date.now() - 60_000),
    notAfter: new Date(Date.now() + 10 * 60_000),
    signingAlgorithm: algorithm,
    keys,
  });
  const pkcs8 = await webcrypto.subtle.exportKey("pkcs8", keys.privateKey);
  return {
    privateKey: createPrivateKey({
      key: Buffer.from(pkcs8),
      format: "der",
      type: "pkcs8",
    }),
    certificatePem: certificate.toString("pem"),
  };
}

function config(server: SigningMaterial): InboundConfig {
  return {
    receiverRnc: "132071506",
    p12Base64: "not-used-in-tests",
    certificatePassword: "not-used-in-tests",
    storageEncryptionKeyBase64: randomBytes(32).toString("base64"),
    signingMaterialOverride: server,
  };
}

async function authenticated(
  repository: MemoryRepository,
  server: SigningMaterial,
  sender: SigningMaterial,
): Promise<string> {
  const now = new Date();
  const seed = await createAuthenticationSeed(repository, now);
  const signedSeed = signSeedXml(seed, sender);
  const result = await validateCertificateAndIssueToken(
    signedSeed,
    config(server),
    repository,
    now,
  );
  return result.token;
}

function ecf(sender: SigningMaterial): string {
  const xml = `<?xml version="1.0" encoding="utf-8"?><ECF><Encabezado><Version>1.0</Version><IdDoc><TipoeCF>31</TipoeCF><eNCF>E310000000099</eNCF></IdDoc><Emisor><RNCEmisor>101010101</RNCEmisor></Emisor><Comprador><RNCComprador>132071506</RNCComprador></Comprador></Encabezado></ECF>`;
  return signXmlDocument(xml, sender, "ECF");
}

function approval(sender: SigningMaterial): string {
  const xml = `<?xml version="1.0" encoding="utf-8"?><ACECF><DetalleAprobacionComercial><Version>1.0</Version><RNCEmisor>132071506</RNCEmisor><eNCF>E310000000099</eNCF><FechaEmision>02-11-2026</FechaEmision><MontoTotal>100.00</MontoTotal><RNCComprador>101010101</RNCComprador><Estado>1</Estado><FechaHoraAprobacionComercial>02-11-2026 12:00:00</FechaHoraAprobacionComercial></DetalleAprobacionComercial></ACECF>`;
  return signXmlDocument(xml, sender, "ACECF");
}

test("emite semilla de uso unico e intercambia por token RS256", async () => {
  const repository = new MemoryRepository();
  const server = await material("FosterFiscal receptor");
  const sender = await material("Emisor externo");
  const now = new Date();
  const seed = await createAuthenticationSeed(repository, now);
  const signed = signSeedXml(seed, sender);
  const token = await validateCertificateAndIssueToken(
    signed,
    config(server),
    repository,
    now,
  );

  assert.equal(token.token.split(".").length, 3);
  await assert.rejects(
    validateCertificateAndIssueToken(signed, config(server), repository, now),
    (error: unknown) => error instanceof InboundServiceError && error.code === "invalid_seed",
  );
});

test("recebe e-CF, assina ARECF e rejeita duplicata", async () => {
  const repository = new MemoryRepository();
  const server = await material("FosterFiscal receptor");
  const sender = await material("Emisor externo");
  const token = await authenticated(repository, server, sender);
  const signedEcf = ecf(sender);

  const first = await receiveEcf(
    signedEcf,
    `Bearer ${token}`,
    config(server),
    repository,
  );
  assert.equal(first.received, true);
  assert.match(first.xml, /<Estado>0<\/Estado>/);
  assert.doesNotThrow(() => verifyXmlSignature(first.xml, server, "ARECF"));

  const duplicate = await receiveEcf(
    signedEcf,
    `Bearer ${token}`,
    config(server),
    repository,
  );
  assert.equal(duplicate.received, false);
  assert.equal(duplicate.reasonCode, 3);
  assert.match(duplicate.xml, /<CodigoMotivoNoRecibido>3<\/CodigoMotivoNoRecibido>/);
  assert.doesNotThrow(() => verifyXmlSignature(duplicate.xml, server, "ARECF"));
});

test("devolve ARECF com motivo 2 quando a assinatura do e-CF foi alterada", async () => {
  const repository = new MemoryRepository();
  const server = await material("FosterFiscal receptor");
  const sender = await material("Emisor externo");
  const token = await authenticated(repository, server, sender);
  const tampered = ecf(sender).replace("101010101", "202020202");

  const result = await receiveEcf(
    tampered,
    `Bearer ${token}`,
    config(server),
    repository,
  );
  assert.equal(result.received, false);
  assert.equal(result.reasonCode, 2);
  assert.doesNotThrow(() => verifyXmlSignature(result.xml, server, "ARECF"));
});

test("devolve ARECF com motivo 1 quando a estrutura e-CF e invalida", async () => {
  const repository = new MemoryRepository();
  const server = await material("FosterFiscal receptor");
  const sender = await material("Emisor externo");
  const token = await authenticated(repository, server, sender);
  const malformed = `<?xml version="1.0" encoding="utf-8"?><ECF><RNCEmisor>101010101</RNCEmisor><RNCComprador>132071506</RNCComprador><eNCF>E310000000099</eNCF></ECF>`;

  const result = await receiveEcf(
    malformed,
    `Bearer ${token}`,
    config(server),
    repository,
  );
  assert.equal(result.received, false);
  assert.equal(result.reasonCode, 1);
  assert.doesNotThrow(() => verifyXmlSignature(result.xml, server, "ARECF"));
});

test("recebe ACECF assinado e recusa duplicata", async () => {
  const repository = new MemoryRepository();
  const server = await material("FosterFiscal receptor");
  const sender = await material("Emisor externo");
  const token = await authenticated(repository, server, sender);
  const signedApproval = approval(sender);

  await receiveCommercialApproval(
    signedApproval,
    `Bearer ${token}`,
    config(server),
    repository,
  );
  await assert.rejects(
    receiveCommercialApproval(
      signedApproval,
      `Bearer ${token}`,
      config(server),
      repository,
    ),
    (error: unknown) => error instanceof InboundServiceError && error.code === "duplicate",
  );
});
