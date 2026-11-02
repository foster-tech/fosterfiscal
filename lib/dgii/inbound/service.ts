import {
  createHash,
  randomBytes,
  randomUUID,
  sign as signBytes,
  verify as verifyBytes,
  X509Certificate,
} from "node:crypto";

import {
  DOMParser,
  onWarningStopParsing,
} from "@xmldom/xmldom";
import type { Document as XmlDocument, Element as XmlElement } from "@xmldom/xmldom";

import {
  encryptSignedXml,
  loadStorageEncryptionKey,
} from "../ecf/storage-crypto";
import {
  loadSigningMaterial,
  signXmlDocument,
  type SigningMaterial,
  verifyXmlSignatureWithEmbeddedCertificate,
} from "../xml-signature";
import type { InboundRepository } from "./repository";

const MAX_XML_BYTES = 4 * 1024 * 1024;
const SEED_TTL_MS = 5 * 60 * 1000;
const TOKEN_TTL_SECONDS = 60 * 60;
const TOKEN_ISSUER = "FosterFiscal.FE";
const TOKEN_AUDIENCE = "USUARIOS.DGII.FE";

const RNC = /^\d{9}(?:\d{2})?$/;
const ENCF = /^[A-Za-z0-9]{13}$/;
const DATE = /^(?:3[01]|[12]\d|0?[1-9])-(?:1[0-2]|0?[1-9])-\d{4}$/;
const DATE_TIME = /^(?:3[01]|[12]\d|0[1-9])-(?:1[0-2]|0[1-9])-\d{4} (?:2[0-3]|[01]?\d):[0-5]?\d:[0-5]?\d$/;
const MONEY = /^\d{1,16}\.\d{2}$/;

export type InboundConfig = {
  receiverRnc: string;
  p12Base64: string;
  certificatePassword: string;
  storageEncryptionKeyBase64: string;
  /** Injetado apenas por testes; rotas sempre carregam o PKCS#12 configurado. */
  signingMaterialOverride?: SigningMaterial;
};

export class InboundServiceError extends Error {
  constructor(
    public readonly code: string,
    public readonly httpStatus: number,
    message: string,
  ) {
    super(message);
    this.name = "InboundServiceError";
  }
}

export type AuthenticationToken = {
  token: string;
  issuedAt: string;
  expiresAt: string;
};

export type ReceiptResult = {
  xml: string;
  received: boolean;
  reasonCode: 1 | 2 | 3 | 4 | null;
};

type TokenClaims = {
  sub: string;
  name: string;
  jti: string;
  nbf: number;
  exp: number;
  iat: number;
  iss: string;
  aud: string;
};

type EcfMetadata = {
  issuerRnc: string;
  buyerRnc: string;
  encf: string;
};

type CommercialApproval = {
  issuerRnc: string;
  buyerRnc: string;
  encf: string;
};

function sha256(value: string): string {
  return createHash("sha256").update(value, "utf8").digest("hex");
}

function base64Url(value: Buffer | string): string {
  return Buffer.from(value).toString("base64url");
}

function parseJsonPart<T>(value: string, label: string): T {
  try {
    return JSON.parse(Buffer.from(value, "base64url").toString("utf8")) as T;
  } catch {
    throw new InboundServiceError("invalid_token", 401, `${label} do token e invalido`);
  }
}

function assertXmlSize(xml: string): void {
  if (!xml || Buffer.byteLength(xml, "utf8") > MAX_XML_BYTES) {
    throw new InboundServiceError(
      "invalid_xml",
      xml ? 413 : 400,
      xml ? "O XML excede o limite de 4 MiB" : "O arquivo XML esta vazio",
    );
  }
}

function parseXml(xml: string): XmlDocument {
  assertXmlSize(xml);
  if (/<!DOCTYPE|<!ENTITY/i.test(xml)) {
    throw new InboundServiceError("invalid_xml", 400, "DTD e ENTITY nao sao permitidos");
  }
  try {
    return new DOMParser({ onError: onWarningStopParsing }).parseFromString(
      xml,
      "application/xml",
    );
  } catch {
    throw new InboundServiceError("invalid_xml", 400, "O arquivo XML e invalido");
  }
}

function elementChildren(parent: XmlElement): XmlElement[] {
  return Array.from(parent.childNodes).filter(
    (node): node is XmlElement => node.nodeType === 1,
  );
}

function uniqueChild(parent: XmlElement, localName: string): XmlElement {
  const matches = elementChildren(parent).filter(
    (child) => child.localName === localName,
  );
  if (matches.length !== 1) {
    throw new InboundServiceError(
      "invalid_xml",
      400,
      `O XML deve conter exatamente um elemento ${localName}`,
    );
  }
  return matches[0];
}

function textChild(parent: XmlElement, localName: string): string {
  const value = uniqueChild(parent, localName).textContent?.trim() ?? "";
  if (!value) {
    throw new InboundServiceError(
      "invalid_xml",
      400,
      `O elemento ${localName} nao pode ser vazio`,
    );
  }
  return value;
}

function assertRoot(document: XmlDocument, expected: string): XmlElement {
  const root = document.documentElement;
  if (!root || root.localName !== expected) {
    throw new InboundServiceError(
      "invalid_xml",
      400,
      `O XML deve possuir raiz ${expected}`,
    );
  }
  return root;
}

function certificateSubject(certificate: X509Certificate): string {
  const match = certificate.subject.match(
    /(?:^|\n)(?:serialNumber|2\.5\.4\.5)\s*=\s*([^\n]+)/i,
  );
  return match?.[1]?.trim().replace(/[^A-Za-z0-9.-]/g, "").slice(0, 64)
    || certificate.fingerprint256.replace(/:/g, "");
}

function certificateSubjectKey(certificate: X509Certificate): string {
  return createHash("sha256").update(certificate.raw).digest("base64url");
}

function jwt(material: SigningMaterial, claims: TokenClaims): string {
  const serverCertificate = new X509Certificate(material.certificatePem);
  const header = {
    alg: "RS256",
    typ: "JWT",
    kid: certificateSubjectKey(serverCertificate),
  };
  const unsigned = `${base64Url(JSON.stringify(header))}.${base64Url(JSON.stringify(claims))}`;
  const signature = signBytes("RSA-SHA256", Buffer.from(unsigned), material.privateKey);
  return `${unsigned}.${signature.toString("base64url")}`;
}

function verifyToken(token: string, material: SigningMaterial, now: Date): TokenClaims {
  const parts = token.split(".");
  if (parts.length !== 3) {
    throw new InboundServiceError("invalid_token", 401, "Bearer token invalido");
  }
  const header = parseJsonPart<Record<string, unknown>>(parts[0], "Cabecalho");
  const claims = parseJsonPart<TokenClaims>(parts[1], "Payload");
  if (header.alg !== "RS256" || header.typ !== "JWT") {
    throw new InboundServiceError("invalid_token", 401, "Perfil do Bearer token invalido");
  }
  const certificate = new X509Certificate(material.certificatePem);
  const signature = Buffer.from(parts[2], "base64url");
  if (!verifyBytes(
    "RSA-SHA256",
    Buffer.from(`${parts[0]}.${parts[1]}`),
    certificate.publicKey,
    signature,
  )) {
    throw new InboundServiceError("invalid_token", 401, "Assinatura do Bearer token invalida");
  }

  const seconds = Math.floor(now.getTime() / 1000);
  if (
    typeof claims.sub !== "string" ||
    typeof claims.name !== "string" ||
    typeof claims.jti !== "string" ||
    typeof claims.nbf !== "number" ||
    typeof claims.exp !== "number" ||
    claims.iss !== TOKEN_ISSUER ||
    claims.aud !== TOKEN_AUDIENCE ||
    seconds < claims.nbf ||
    seconds >= claims.exp
  ) {
    throw new InboundServiceError("invalid_token", 401, "Bearer token expirado ou invalido");
  }
  return claims;
}

function formatDominicanDateTime(now: Date): string {
  const local = new Date(now.getTime() - 4 * 60 * 60 * 1000);
  const part = (value: number) => String(value).padStart(2, "0");
  return `${part(local.getUTCDate())}-${part(local.getUTCMonth() + 1)}-${local.getUTCFullYear()} ${part(local.getUTCHours())}:${part(local.getUTCMinutes())}:${part(local.getUTCSeconds())}`;
}

function universalSeconds(seconds: number): string {
  return new Date(seconds * 1000).toISOString().replace(/\.000Z$/, "Z");
}

function buildReceipt(
  metadata: EcfMetadata,
  received: boolean,
  reasonCode: 1 | 2 | 3 | 4 | null,
  now: Date,
): string {
  const reason = received ? "" : `<CodigoMotivoNoRecibido>${reasonCode}</CodigoMotivoNoRecibido>`;
  return `<?xml version="1.0" encoding="utf-8"?><ARECF><DetalleAcusedeRecibo><Version>1.0</Version><RNCEmisor>${metadata.issuerRnc}</RNCEmisor><RNCComprador>${metadata.buyerRnc}</RNCComprador><eNCF>${metadata.encf}</eNCF><Estado>${received ? 0 : 1}</Estado>${reason}<FechaHoraAcuseRecibo>${formatDominicanDateTime(now)}</FechaHoraAcuseRecibo></DetalleAcusedeRecibo></ARECF>`;
}

function ecfMetadata(xml: string): EcfMetadata {
  const root = assertRoot(parseXml(xml), "ECF");
  const header = uniqueChild(root, "Encabezado");
  const idDoc = uniqueChild(header, "IdDoc");
  const issuer = uniqueChild(header, "Emisor");
  const buyer = uniqueChild(header, "Comprador");
  const metadata = {
    issuerRnc: textChild(issuer, "RNCEmisor"),
    buyerRnc: textChild(buyer, "RNCComprador"),
    encf: textChild(idDoc, "eNCF"),
  };
  if (!RNC.test(metadata.issuerRnc) || !RNC.test(metadata.buyerRnc) || !ENCF.test(metadata.encf)) {
    throw new InboundServiceError("invalid_xml", 400, "RNC ou e-NCF possui formato invalido");
  }
  return metadata;
}

function looseEcfMetadata(xml: string): EcfMetadata | null {
  const document = parseXml(xml);
  const value = (localName: string): string | null => {
    const matches = Array.from(document.getElementsByTagName(localName));
    if (matches.length !== 1) return null;
    return matches[0].textContent?.trim() || null;
  };
  const metadata = {
    issuerRnc: value("RNCEmisor"),
    buyerRnc: value("RNCComprador"),
    encf: value("eNCF"),
  };
  if (
    !metadata.issuerRnc ||
    !metadata.buyerRnc ||
    !metadata.encf ||
    !RNC.test(metadata.issuerRnc) ||
    !RNC.test(metadata.buyerRnc) ||
    !ENCF.test(metadata.encf)
  ) {
    return null;
  }
  return metadata as EcfMetadata;
}

function commercialApproval(xml: string): CommercialApproval {
  const root = assertRoot(parseXml(xml), "ACECF");
  const rootNames = elementChildren(root).map((child) => child.localName);
  if (
    rootNames.length !== 2 ||
    rootNames[0] !== "DetalleAprobacionComercial" ||
    rootNames[1] !== "Signature"
  ) {
    throw new InboundServiceError("invalid_xml", 400, "A estrutura do ACECF e invalida");
  }
  const detail = uniqueChild(root, "DetalleAprobacionComercial");
  const version = textChild(detail, "Version");
  const issuerRnc = textChild(detail, "RNCEmisor");
  const encf = textChild(detail, "eNCF");
  const issueDate = textChild(detail, "FechaEmision");
  const total = textChild(detail, "MontoTotal");
  const buyerRnc = textChild(detail, "RNCComprador");
  const state = textChild(detail, "Estado");
  const dateTime = textChild(detail, "FechaHoraAprobacionComercial");
  const reasons = elementChildren(detail).filter(
    (child) => child.localName === "DetalleMotivoRechazo",
  );
  const expectedNames = state === "2"
    ? [
      "Version", "RNCEmisor", "eNCF", "FechaEmision", "MontoTotal",
      "RNCComprador", "Estado", "DetalleMotivoRechazo",
      "FechaHoraAprobacionComercial",
    ]
    : [
      "Version", "RNCEmisor", "eNCF", "FechaEmision", "MontoTotal",
      "RNCComprador", "Estado", "FechaHoraAprobacionComercial",
    ];
  const actualNames = elementChildren(detail).map((child) => child.localName);

  if (
    version !== "1.0" ||
    !RNC.test(issuerRnc) ||
    !RNC.test(buyerRnc) ||
    !ENCF.test(encf) ||
    !DATE.test(issueDate) ||
    !MONEY.test(total) ||
    !/^[12]$/.test(state) ||
    !DATE_TIME.test(dateTime) ||
    actualNames.join("|") !== expectedNames.join("|") ||
    reasons.length > 1 ||
    (state === "2" && (reasons.length !== 1 || (reasons[0].textContent?.trim().length ?? 0) > 250)) ||
    (state === "1" && reasons.length !== 0)
  ) {
    throw new InboundServiceError("invalid_xml", 400, "O ACECF nao corresponde ao formato oficial");
  }
  return { issuerRnc, buyerRnc, encf };
}

function storageKey(config: InboundConfig): Buffer {
  try {
    return loadStorageEncryptionKey(config.storageEncryptionKeyBase64);
  } catch {
    throw new InboundServiceError(
      "configuration",
      503,
      "DGII_STORAGE_ENCRYPTION_KEY_BASE64 nao configurada corretamente",
    );
  }
}

function bearer(header: string | null): string {
  const match = header?.match(/^Bearer\s+([^\s]+)$/i);
  if (!match) {
    throw new InboundServiceError("missing_token", 401, "Authorization Bearer ausente");
  }
  return match[1];
}

async function signingMaterial(config: InboundConfig): Promise<SigningMaterial> {
  if (!RNC.test(config.receiverRnc)) {
    throw new InboundServiceError("configuration", 503, "DGII_RECEIVER_RNC nao configurado corretamente");
  }
  if (config.signingMaterialOverride) return config.signingMaterialOverride;
  try {
    return await loadSigningMaterial(config.p12Base64, config.certificatePassword);
  } catch {
    throw new InboundServiceError("configuration", 503, "Certificado receptor nao configurado corretamente");
  }
}

export async function createAuthenticationSeed(
  repository: InboundRepository,
  now = new Date(),
): Promise<string> {
  const value = randomBytes(64).toString("base64");
  await repository.createSeed({
    id: randomUUID(),
    seedHash: sha256(value),
    expiresAt: new Date(now.getTime() + SEED_TTL_MS),
  });
  return `<?xml version="1.0" encoding="utf-8"?><SemillaModel><valor>${value}</valor><fecha>${now.toISOString()}</fecha></SemillaModel>`;
}

export async function validateCertificateAndIssueToken(
  signedSeedXml: string,
  config: InboundConfig,
  repository: InboundRepository,
  now = new Date(),
): Promise<AuthenticationToken> {
  assertXmlSize(signedSeedXml);
  let certificate: X509Certificate;
  try {
    certificate = verifyXmlSignatureWithEmbeddedCertificate(
      signedSeedXml,
      "SemillaModel",
    ).certificate;
  } catch {
    throw new InboundServiceError("invalid_signature", 400, "Firma digital de la semilla invalida");
  }

  const root = assertRoot(parseXml(signedSeedXml), "SemillaModel");
  const value = textChild(root, "valor");
  const seedDate = new Date(textChild(root, "fecha"));
  if (!Number.isFinite(seedDate.getTime())) {
    throw new InboundServiceError("invalid_seed", 400, "Fecha de semilla invalida");
  }
  if (!await repository.consumeSeed(sha256(value), now)) {
    throw new InboundServiceError("invalid_seed", 400, "Semilla expirada, desconocida o reutilizada");
  }

  const material = await signingMaterial(config);
  const issued = Math.floor(now.getTime() / 1000);
  const expires = issued + TOKEN_TTL_SECONDS;
  const claims: TokenClaims = {
    sub: certificateSubjectKey(certificate),
    name: certificateSubject(certificate),
    jti: randomUUID(),
    nbf: issued - 5,
    iat: issued,
    exp: expires,
    iss: TOKEN_ISSUER,
    aud: TOKEN_AUDIENCE,
  };
  return {
    token: jwt(material, claims),
    issuedAt: universalSeconds(issued),
    expiresAt: universalSeconds(expires),
  };
}

export async function receiveEcf(
  xml: string,
  authorization: string | null,
  config: InboundConfig,
  repository: InboundRepository,
  now = new Date(),
): Promise<ReceiptResult> {
  const material = await signingMaterial(config);
  const claims = verifyToken(bearer(authorization), material, now);
  let metadata: EcfMetadata;
  try {
    metadata = ecfMetadata(xml);
  } catch (error: unknown) {
    const recoverable = looseEcfMetadata(xml);
    if (!recoverable) throw error;
    return {
      xml: signXmlDocument(buildReceipt(recoverable, false, 1, now), material, "ARECF"),
      received: false,
      reasonCode: 1,
    };
  }

  let signer: X509Certificate;
  try {
    signer = verifyXmlSignatureWithEmbeddedCertificate(xml, "ECF").certificate;
  } catch {
    return {
      xml: signXmlDocument(buildReceipt(metadata, false, 2, now), material, "ARECF"),
      received: false,
      reasonCode: 2,
    };
  }
  if (claims.sub !== certificateSubjectKey(signer)) {
    throw new InboundServiceError("identity_mismatch", 401, "O token nao corresponde ao certificado do XML");
  }
  if (metadata.buyerRnc !== config.receiverRnc) {
    return {
      xml: signXmlDocument(buildReceipt(metadata, false, 4, now), material, "ARECF"),
      received: false,
      reasonCode: 4,
    };
  }

  const encryptionKey = storageKey(config);
  const acceptedXml = signXmlDocument(
    buildReceipt(metadata, true, null, now),
    material,
    "ARECF",
  );
  const result = await repository.claimDocument({
    id: randomUUID(),
    kind: "ecf",
    senderRnc: metadata.issuerRnc,
    receiverRnc: metadata.buyerRnc,
    encf: metadata.encf,
    xmlHash: sha256(xml),
    encryptedXml: encryptSignedXml(xml, encryptionKey),
    encryptedResponse: encryptSignedXml(acceptedXml, encryptionKey),
  });
  if (result === "duplicate") {
    return {
      xml: signXmlDocument(buildReceipt(metadata, false, 3, now), material, "ARECF"),
      received: false,
      reasonCode: 3,
    };
  }
  return { xml: acceptedXml, received: true, reasonCode: null };
}

export async function receiveCommercialApproval(
  xml: string,
  authorization: string | null,
  config: InboundConfig,
  repository: InboundRepository,
  now = new Date(),
): Promise<void> {
  const material = await signingMaterial(config);
  const claims = verifyToken(bearer(authorization), material, now);
  const approval = commercialApproval(xml);
  let signer: X509Certificate;
  try {
    signer = verifyXmlSignatureWithEmbeddedCertificate(xml, "ACECF").certificate;
  } catch {
    throw new InboundServiceError("invalid_signature", 400, "Firma digital del ACECF invalida");
  }
  if (claims.sub !== certificateSubjectKey(signer)) {
    throw new InboundServiceError("identity_mismatch", 401, "O token nao corresponde ao certificado do XML");
  }
  if (approval.issuerRnc !== config.receiverRnc) {
    throw new InboundServiceError("wrong_receiver", 400, "RNCEmisor do ACECF nao corresponde ao receptor configurado");
  }

  const encryptionKey = storageKey(config);
  const result = await repository.claimDocument({
    id: randomUUID(),
    kind: "commercial_approval",
    senderRnc: approval.buyerRnc,
    receiverRnc: approval.issuerRnc,
    encf: approval.encf,
    xmlHash: sha256(xml),
    encryptedXml: encryptSignedXml(xml, encryptionKey),
    encryptedResponse: null,
  });
  if (result === "duplicate") {
    throw new InboundServiceError("duplicate", 400, "ACECF duplicado");
  }
}

export function authenticationTokenXml(value: AuthenticationToken): string {
  return `<?xml version="1.0" encoding="utf-8"?><respuestaautenticacion><token>${value.token}</token><expira>${value.expiresAt}</expira><expedido>${value.issuedAt}</expedido></respuestaautenticacion>`;
}
