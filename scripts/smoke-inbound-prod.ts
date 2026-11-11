import { readFile } from "node:fs/promises";

import { DOMParser, onWarningStopParsing } from "@xmldom/xmldom";

import { prepareEcf31 } from "../lib/dgii/ecf/prepare";
import {
  loadSigningMaterial,
  signSeedXml,
  signXmlDocument,
  validateSeedXml,
  verifyXmlSignature,
} from "../lib/dgii/xml-signature";

const DEFAULT_BASE_URL = "https://fosterfiscal.vercel.app";
const RECEIVER_RNC = "132071506";
const SYNTHETIC_SENDER_RNC = "101001577";

function requireEnvironment(name: string): string {
  const value = process.env[name];
  if (!value) throw new Error(`Variavel ${name} ausente`);
  return value;
}

function assertStatus(response: Response, expected: number, step: string): void {
  if (response.status !== expected) {
    throw new Error(`${step} retornou HTTP ${response.status}; esperado ${expected}`);
  }
}

function multipart(xml: string, fileName: string): FormData {
  const form = new FormData();
  form.append("xml", new Blob([xml], { type: "text/xml;charset=utf-8" }), fileName);
  return form;
}

function text(xml: string, localName: string): string {
  const document = new DOMParser({ onError: onWarningStopParsing }).parseFromString(
    xml,
    "application/xml",
  );
  const values = Array.from(document.getElementsByTagName(localName));
  if (values.length !== 1) throw new Error(`Resposta XML sem ${localName} unico`);
  return values[0].textContent?.trim() ?? "";
}

function dominicanNow(now: Date): { date: string; dateTime: string } {
  const local = new Date(now.getTime() - 4 * 60 * 60 * 1000);
  const part = (value: number) => String(value).padStart(2, "0");
  const date = `${part(local.getUTCDate())}-${part(local.getUTCMonth() + 1)}-${local.getUTCFullYear()}`;
  return {
    date,
    dateTime: `${date} ${part(local.getUTCHours())}:${part(local.getUTCMinutes())}:${part(local.getUTCSeconds())}`,
  };
}

async function main(): Promise<void> {
  const baseUrl = (process.env.PROD_BASE_URL ?? DEFAULT_BASE_URL).replace(/\/$/, "");
  if (baseUrl !== DEFAULT_BASE_URL) {
    throw new Error("PROD_BASE_URL nao corresponde ao deploy autorizado");
  }

  const p12Base64 = requireEnvironment("DGII_CERT_P12_BASE64");
  const certificatePassword = process.env.DGII_CERT_PASSWORD;
  if (certificatePassword === undefined) throw new Error("Variavel DGII_CERT_PASSWORD ausente");
  const material = await loadSigningMaterial(p12Base64, certificatePassword);
  const now = new Date();
  const clock = dominicanNow(now);
  const encf = `E31${String(now.getTime()).slice(-10)}`;
  const checks: Record<string, unknown> = { baseUrl, encf };

  const seedResponse = await fetch(`${baseUrl}/fe/autenticacion/api/semilla`, {
    cache: "no-store",
    headers: { accept: "application/xml" },
  });
  assertStatus(seedResponse, 200, "semilla");
  const seedXml = await seedResponse.text();
  validateSeedXml(seedXml);
  checks.seed = {
    httpStatus: seedResponse.status,
    contentType: seedResponse.headers.get("content-type"),
    noStore: seedResponse.headers.get("cache-control")?.includes("no-store") ?? false,
    validXml: true,
  };

  const signedSeed = signSeedXml(seedXml, material);
  const tokenResponse = await fetch(
    `${baseUrl}/fe/autenticacion/api/validacioncertificado`,
    {
      method: "POST",
      cache: "no-store",
      headers: { accept: "application/json" },
      body: multipart(signedSeed, "semilla-firmada.xml"),
    },
  );
  assertStatus(tokenResponse, 200, "validacioncertificado");
  const authentication = await tokenResponse.json() as Record<string, unknown>;
  const token = typeof authentication.token === "string" ? authentication.token : "";
  if (token.split(".").length !== 3) throw new Error("Token de autenticacao ausente ou invalido");
  if (typeof authentication.expedido !== "string" || typeof authentication.expira !== "string") {
    throw new Error("Datas de autenticacao ausentes");
  }
  checks.authentication = {
    httpStatus: tokenResponse.status,
    tokenReceived: true,
    issuedAtReceived: true,
    expiresAtReceived: true,
  };

  const raw = JSON.parse(
    await readFile("examples/ecf31.prepare-test.json", "utf8"),
  ) as {
    document: Record<string, unknown>;
    issuer: Record<string, unknown>;
    buyer: Record<string, unknown>;
    signatureDateTime?: string;
    [key: string]: unknown;
  };
  raw.document.eNCF = encf;
  raw.document.sequenceExpirationDate = "31-12-2028";
  raw.issuer.rnc = SYNTHETIC_SENDER_RNC;
  raw.issuer.legalName = "EMISOR SINTETICO PRUEBA DE RECEPCION";
  raw.issuer.issueDate = clock.date;
  raw.buyer.rnc = RECEIVER_RNC;
  raw.buyer.legalName = "FOSTERTECH SOLUTIONS SRL";
  raw.signatureDateTime = clock.dateTime;
  const prepared = await prepareEcf31(raw, {
    p12Base64,
    certificatePassword,
    now,
  });
  checks.ecfPreparation = {
    xsdValid: prepared.steps.some((step) => step.stage === "validate_xsd" && step.success),
    signatureValid: prepared.steps.some((step) => step.stage === "verify_signature" && step.success),
  };

  const ecfFileName = `${SYNTHETIC_SENDER_RNC}${encf}.xml`;
  const receiptResponse = await fetch(`${baseUrl}/fe/recepcion/api/ecf`, {
    method: "POST",
    cache: "no-store",
    headers: { authorization: `Bearer ${token}`, accept: "application/xml" },
    body: multipart(prepared.xml, ecfFileName),
  });
  assertStatus(receiptResponse, 200, "recepcion");
  const receiptXml = await receiptResponse.text();
  verifyXmlSignature(receiptXml, material, "ARECF");
  if (text(receiptXml, "Estado") !== "0") throw new Error("ARECF nao confirmou a recepcao");
  checks.reception = {
    httpStatus: receiptResponse.status,
    received: true,
    arecfSignatureValid: true,
  };

  const duplicateResponse = await fetch(`${baseUrl}/fe/recepcion/api/ecf`, {
    method: "POST",
    cache: "no-store",
    headers: { authorization: `Bearer ${token}`, accept: "application/xml" },
    body: multipart(prepared.xml, ecfFileName),
  });
  assertStatus(duplicateResponse, 200, "recepcion duplicada");
  const duplicateXml = await duplicateResponse.text();
  verifyXmlSignature(duplicateXml, material, "ARECF");
  if (
    text(duplicateXml, "Estado") !== "1" ||
    text(duplicateXml, "CodigoMotivoNoRecibido") !== "3"
  ) {
    throw new Error("ARECF duplicado nao retornou o motivo 3");
  }
  checks.duplicateReception = {
    httpStatus: duplicateResponse.status,
    rejectedAsDuplicate: true,
    arecfSignatureValid: true,
  };

  const unsignedApproval = `<?xml version="1.0" encoding="utf-8"?><ACECF><DetalleAprobacionComercial><Version>1.0</Version><RNCEmisor>${RECEIVER_RNC}</RNCEmisor><eNCF>${encf}</eNCF><FechaEmision>${clock.date}</FechaEmision><MontoTotal>251340.00</MontoTotal><RNCComprador>${SYNTHETIC_SENDER_RNC}</RNCComprador><Estado>1</Estado><FechaHoraAprobacionComercial>${clock.dateTime}</FechaHoraAprobacionComercial></DetalleAprobacionComercial></ACECF>`;
  const signedApproval = signXmlDocument(unsignedApproval, material, "ACECF");
  const approvalFileName = `${SYNTHETIC_SENDER_RNC}${encf}.xml`;
  const approvalResponse = await fetch(
    `${baseUrl}/fe/aprobacioncomercial/api/ecf`,
    {
      method: "POST",
      cache: "no-store",
      headers: { authorization: `Bearer ${token}`, accept: "*/*" },
      body: multipart(signedApproval, approvalFileName),
    },
  );
  assertStatus(approvalResponse, 200, "aprobacioncomercial");
  checks.commercialApproval = { httpStatus: approvalResponse.status, stored: true };

  const duplicateApprovalResponse = await fetch(
    `${baseUrl}/fe/aprobacioncomercial/api/ecf`,
    {
      method: "POST",
      cache: "no-store",
      headers: { authorization: `Bearer ${token}`, accept: "*/*" },
      body: multipart(signedApproval, approvalFileName),
    },
  );
  assertStatus(duplicateApprovalResponse, 400, "aprobacioncomercial duplicada");
  checks.duplicateCommercialApproval = {
    httpStatus: duplicateApprovalResponse.status,
    rejectedAsDuplicate: true,
  };

  console.log(JSON.stringify({ success: true, checks }, null, 2));
}

main().catch((error: unknown) => {
  console.error(JSON.stringify({
    success: false,
    error: error instanceof Error ? error.message : "Falha desconhecida",
  }));
  process.exitCode = 1;
});
