import { createHash, timingSafeEqual } from "node:crypto";

import { DOMParser, onWarningStopParsing } from "@xmldom/xmldom";
import { NextRequest, NextResponse } from "next/server";

import {
  authorizeDgiiTest,
  executionContext,
  noStoreJson,
} from "@/lib/dgii/access";
import {
  authenticateDgii,
  DgiiAuthenticationError,
} from "@/lib/dgii/authentication";
import {
  DgiiGatewayError,
  queryEcfResult,
  queryTrackIds,
  submitEcf,
} from "@/lib/dgii/ecf/gateway";
import { validateEcf31Xsd } from "@/lib/dgii/ecf/xsd";
import {
  loadSigningMaterial,
  verifyXmlSignature,
} from "@/lib/dgii/xml-signature";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";
export const fetchCache = "force-no-store";
export const revalidate = 0;
export const maxDuration = 60;

const MAX_REQUEST_BYTES = 256 * 1024;
const ISSUER_RNC = "132071506";

const APPROVED_DOCUMENTS = Object.freeze({
  E310000000001: Object.freeze({
    sha256: "228dc9fde9ea3f2532e2e26c8362c5069cf8e815aab152b92bad7c5e3f10ef11",
    buyerRnc: "101807687",
  }),
  E310000000002: Object.freeze({
    sha256: "44fac244acc19d54e0d2b898f282f1522606ea75e1eef57ca1ec4e06b0a3a7eb",
    buyerRnc: "122011226",
  }),
});

type ApprovedEncf = keyof typeof APPROVED_DOCUMENTS;
type Operation = "preflight" | "submit";

type RequestBody = {
  operation?: unknown;
  confirmRnc?: unknown;
  confirmEncf?: unknown;
  confirmation?: unknown;
  xmlBase64?: unknown;
  sha256?: unknown;
};

function textByLocalName(
  document: ReturnType<DOMParser["parseFromString"]>,
  name: string,
): string {
  const nodes = document.getElementsByTagName(name);
  if (nodes.length > 0) return nodes.item(0)?.textContent?.trim() ?? "";
  for (const element of Array.from(document.getElementsByTagName("*"))) {
    if (element.localName === name) return element.textContent?.trim() ?? "";
  }
  return "";
}

function parseIdentity(xml: string): {
  issuerRnc: string;
  buyerRnc: string;
  encf: string;
  type: string;
} {
  if (/<!DOCTYPE|<!ENTITY/i.test(xml)) throw new Error("DTD nao permitido");
  const document = new DOMParser({ onError: onWarningStopParsing }).parseFromString(
    xml,
    "application/xml",
  );
  if (document.documentElement?.localName !== "ECF") {
    throw new Error("O XML deve possuir raiz ECF");
  }
  const identity = {
    issuerRnc: textByLocalName(document, "RNCEmisor"),
    buyerRnc: textByLocalName(document, "RNCComprador"),
    encf: textByLocalName(document, "eNCF"),
    type: textByLocalName(document, "TipoeCF"),
  };
  if (!identity.issuerRnc || !identity.buyerRnc || !identity.encf || !identity.type) {
    throw new Error("Identidade fiscal incompleta no XML");
  }
  return identity;
}

function safeDigestEqual(xml: string, expectedHex: string): boolean {
  if (!/^[a-f0-9]{64}$/.test(expectedHex)) return false;
  const actual = createHash("sha256").update(xml, "utf8").digest();
  const expected = Buffer.from(expectedHex, "hex");
  return actual.length === expected.length && timingSafeEqual(actual, expected);
}

function decodeXmlBase64(value: unknown): string {
  if (typeof value !== "string" || !value || !/^[A-Za-z0-9+/]+={0,2}$/.test(value)) {
    throw new Error("xmlBase64 ausente ou invalido");
  }
  const bytes = Buffer.from(value, "base64");
  if (bytes.length === 0 || bytes.length > 128 * 1024) {
    throw new Error("XML fora do limite permitido");
  }
  if (bytes.toString("base64") !== value) {
    throw new Error("xmlBase64 nao canonico");
  }
  return bytes.toString("utf8");
}

function inputError(message: string, status = 400): NextResponse {
  return noStoreJson({
    success: false,
    targetEnvironment: "ecf",
    stage: "validate_input",
    diagnostic: { category: "input_validation", message },
  }, status);
}

function approvedEncf(value: unknown): value is ApprovedEncf {
  return typeof value === "string" && value in APPROVED_DOCUMENTS;
}

export async function POST(request: NextRequest): Promise<NextResponse> {
  const access = authorizeDgiiTest(request);
  if (!access.authorized) return access.response;

  if (!request.headers.get("content-type")?.toLowerCase().includes("application/json")) {
    return inputError("Use Content-Type application/json", 415);
  }

  let raw: RequestBody;
  try {
    const body = await request.text();
    if (Buffer.byteLength(body, "utf8") > MAX_REQUEST_BYTES) {
      return inputError("O corpo excede o limite de 256 KiB", 413);
    }
    raw = JSON.parse(body) as RequestBody;
  } catch {
    return inputError("O corpo deve conter JSON valido");
  }

  const operation = raw.operation;
  if (operation !== "preflight" && operation !== "submit") {
    return inputError("operation deve ser preflight ou submit");
  }
  if (raw.confirmRnc !== ISSUER_RNC) {
    return inputError("Confirmacao do RNC emissor invalida");
  }
  if (!approvedEncf(raw.confirmEncf)) {
    return inputError("e-NCF nao autorizado por esta operacao");
  }
  if (typeof raw.sha256 !== "string" || raw.sha256 !== APPROVED_DOCUMENTS[raw.confirmEncf].sha256) {
    return inputError("SHA-256 nao autorizado para este e-NCF");
  }
  if (
    operation === "submit" &&
    raw.confirmation !== `SEND ${raw.confirmEncf} TO DGII PRODUCTION`
  ) {
    return inputError("Confirmacao explicita de producao ausente");
  }

  let xml: string;
  try {
    xml = decodeXmlBase64(raw.xmlBase64);
  } catch (error: unknown) {
    return inputError(error instanceof Error ? error.message : "XML invalido");
  }
  if (!safeDigestEqual(xml, raw.sha256)) {
    return inputError("O XML nao corresponde ao SHA-256 confirmado");
  }

  let identity: ReturnType<typeof parseIdentity>;
  try {
    identity = parseIdentity(xml);
  } catch (error: unknown) {
    return inputError(error instanceof Error ? error.message : "XML invalido");
  }
  const approved = APPROVED_DOCUMENTS[raw.confirmEncf];
  if (
    identity.issuerRnc !== ISSUER_RNC ||
    identity.encf !== raw.confirmEncf ||
    identity.buyerRnc !== approved.buyerRnc ||
    identity.type !== "31"
  ) {
    return inputError("Identidade fiscal do XML nao corresponde ao documento autorizado");
  }

  const p12Base64 = process.env.DGII_CERT_P12_BASE64 ?? "";
  const certificatePassword = process.env.DGII_CERT_PASSWORD;
  if (!p12Base64 || certificatePassword === undefined) {
    return noStoreJson({
      success: false,
      targetEnvironment: "ecf",
      stage: "configuration",
      diagnostic: {
        category: "certificate_configuration",
        message: "Certificado digital nao configurado",
      },
    }, 503);
  }

  try {
    const xsd = await validateEcf31Xsd(xml);
    if (!xsd.valid) {
      return noStoreJson({
        success: false,
        targetEnvironment: "ecf",
        stage: "validate_xsd",
        diagnostic: {
          category: "xsd_validation",
          message: "O XML nao passou no XSD oficial e-CF 31",
          issues: xsd.errors,
        },
      }, 422);
    }

    const material = await loadSigningMaterial(p12Base64, certificatePassword);
    verifyXmlSignature(xml, material, "ECF");

    const session = await authenticateDgii({
      p12Base64,
      certificatePassword,
      environment: "ecf",
      requestTimeoutMs: 60_000,
    });
    const existing = await queryTrackIds(
      identity.issuerRnc,
      identity.encf,
      session.token,
      "ecf",
    );
    const existingStatuses = await Promise.all(
      existing.candidates.slice(0, 5).map((candidate) =>
        queryEcfResult(candidate.trackId, session.token, "ecf")
      ),
    );

    if (existing.candidates.length > 0) {
      return noStoreJson({
        success: true,
        timestamp: new Date().toISOString(),
        ...executionContext(),
        targetEnvironment: "ecf",
        stage: "already_received",
        operation,
        submittedNow: false,
        idempotentReplay: true,
        issuerRnc: identity.issuerRnc,
        buyerRnc: identity.buyerRnc,
        encf: identity.encf,
        sha256: raw.sha256,
        trackIds: existing.candidates,
        statuses: existingStatuses,
        fiscallyAccepted: existingStatuses.some((status) =>
          status.normalizedStatus === "accepted" ||
          status.normalizedStatus === "accepted_conditional"
        ),
      }, 200);
    }

    if (operation === "preflight") {
      return noStoreJson({
        success: true,
        timestamp: new Date().toISOString(),
        ...executionContext(),
        targetEnvironment: "ecf",
        stage: "ready_to_submit",
        operation,
        submittedNow: false,
        readyToSubmit: true,
        issuerRnc: identity.issuerRnc,
        buyerRnc: identity.buyerRnc,
        encf: identity.encf,
        sha256: raw.sha256,
        authentication: {
          tokenReceived: true,
          expiresAt: session.authentication.expiresAt,
        },
      }, 200);
    }

    const reception = await submitEcf({
      xml,
      issuerRnc: identity.issuerRnc,
      encf: identity.encf,
      token: session.token,
    }, "ecf");

    if (!reception.trackId) {
      return noStoreJson({
        success: false,
        timestamp: new Date().toISOString(),
        ...executionContext(),
        targetEnvironment: "ecf",
        stage: "reception_without_track_id",
        submittedNow: true,
        issuerRnc: identity.issuerRnc,
        buyerRnc: identity.buyerRnc,
        encf: identity.encf,
        sha256: raw.sha256,
        reception,
        warning: "A DGII respondeu sem TrackId; nao repetir o envio antes de reconciliar.",
      }, 202);
    }

    const status = await queryEcfResult(reception.trackId, session.token, "ecf");
    return noStoreJson({
      success: true,
      timestamp: new Date().toISOString(),
      ...executionContext(),
      targetEnvironment: "ecf",
      stage: "submitted",
      submittedNow: true,
      issuerRnc: identity.issuerRnc,
      buyerRnc: identity.buyerRnc,
      encf: identity.encf,
      sha256: raw.sha256,
      reception,
      status,
      fiscallyAccepted:
        status.normalizedStatus === "accepted" ||
        status.normalizedStatus === "accepted_conditional",
    }, 200);
  } catch (error: unknown) {
    if (error instanceof DgiiAuthenticationError) {
      return noStoreJson({
        success: false,
        timestamp: new Date().toISOString(),
        ...executionContext(),
        targetEnvironment: "ecf",
        stage: error.stage,
        submittedNow: false,
        diagnostic: {
          category: error.category,
          type: error.type,
          message: error.diagnostic,
        },
      }, 502);
    }
    if (error instanceof DgiiGatewayError) {
      return noStoreJson({
        success: false,
        timestamp: new Date().toISOString(),
        ...executionContext(),
        targetEnvironment: "ecf",
        stage: error.stage,
        submittedNow: error.afterPossibleReceipt,
        diagnostic: {
          category: error.type,
          message: error.message,
          httpStatus: error.httpStatus,
          afterPossibleReceipt: error.afterPossibleReceipt,
        },
        warning: error.afterPossibleReceipt
          ? "A recepcao pode ter ocorrido; reconciliar TrackId antes de qualquer nova tentativa."
          : null,
      }, 502);
    }
    return noStoreJson({
      success: false,
      timestamp: new Date().toISOString(),
      ...executionContext(),
      targetEnvironment: "ecf",
      stage: "internal",
      submittedNow: false,
      diagnostic: {
        category: "internal",
        message: error instanceof Error ? error.message : "Falha interna",
      },
    }, 500);
  }
}
