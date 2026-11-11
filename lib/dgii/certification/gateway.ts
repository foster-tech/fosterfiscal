import { randomBytes, timingSafeEqual } from "node:crypto";

import { sanitizeDgiiResponse } from "../authentication";
import {
  DgiiGatewayError,
  normalizeOfficialStatus,
} from "../ecf/gateway";
import { StoredDgiiMessage, SubmissionStatus } from "../ecf/submission-types";

const REQUEST_TIMEOUT_MS = 12_000;
const MAX_RESPONSE_BYTES = 128 * 1024;

export const CERTECF_RFCE_ENDPOINT =
  "https://fc.dgii.gov.do/certecf/recepcionfc/api/recepcion/ecf";
export const CERTECF_COMMERCIAL_APPROVAL_ENDPOINT =
  "https://ecf.dgii.gov.do/certecf/aprobacioncomercial/api/aprobacioncomercial";

export type RfceReceptionResult = {
  httpStatus: number;
  durationMs: number;
  code: number | null;
  officialStatus: string | null;
  normalizedStatus: SubmissionStatus;
  encf: string | null;
  sequenceUsed: boolean | null;
  messages: StoredDgiiMessage[];
};

export type CommercialApprovalReceptionResult = {
  httpStatus: number;
  durationMs: number;
  code: string | null;
  officialStatus: string | null;
  accepted: boolean;
  messages: string[];
};

function multipartXml(
  xmlBytes: Buffer,
  fileName: string,
): { body: Buffer; boundary: string } {
  const boundary = `--------------------------${randomBytes(12).toString("hex")}`;
  const prefix = Buffer.from(
    `--${boundary}\r\n` +
      `Content-Disposition: form-data; name="xml"; filename="${fileName}"\r\n` +
      "Content-Type: text/xml\r\n\r\n",
    "utf8",
  );
  const suffix = Buffer.from(`\r\n--${boundary}--\r\n`, "utf8");
  const body = Buffer.concat([prefix, xmlBytes, suffix]);
  const embeddedXml = body.subarray(prefix.length, prefix.length + xmlBytes.length);
  if (!timingSafeEqual(embeddedXml, xmlBytes)) {
    throw new Error("Os bytes do XML foram alterados ao montar o multipart");
  }
  return { body, boundary };
}

function nullableNumber(value: unknown): number | null {
  if (typeof value === "number" && Number.isFinite(value)) return value;
  if (typeof value === "string" && /^\d+$/.test(value)) return Number(value);
  return null;
}

function nullableString(value: unknown): string | null {
  return typeof value === "string" && value.trim() ? value.trim() : null;
}

function parseMessages(value: unknown): StoredDgiiMessage[] {
  if (!Array.isArray(value)) return [];
  return value.slice(0, 50).flatMap((entry) => {
    if (!entry || typeof entry !== "object") return [];
    const object = entry as Record<string, unknown>;
    const text = nullableString(object.valor ?? object.Valor);
    if (!text) return [];
    const code = object.codigo ?? object.Codigo ?? null;
    return [{
      code: typeof code === "string" || typeof code === "number" ? code : null,
      value: text.slice(0, 1_000),
    }];
  });
}

export async function submitRfceCertification(
  input: {
    xml: string;
    issuerRnc: string;
    encf: string;
    token: string;
  },
  fetchImpl: typeof fetch = fetch,
): Promise<RfceReceptionResult> {
  const xmlBytes = Buffer.from(input.xml, "utf8");
  let payload: ReturnType<typeof multipartXml>;
  try {
    payload = multipartXml(xmlBytes, `${input.issuerRnc}${input.encf}.xml`);
  } catch {
    throw new DgiiGatewayError(
      "submit",
      "payload_mismatch",
      "Os bytes do RFCE no multipart diferem do XML validado",
      null,
      false,
    );
  }
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), REQUEST_TIMEOUT_MS);
  const startedAt = performance.now();

  try {
    const response = await fetchImpl(CERTECF_RFCE_ENDPOINT, {
      method: "POST",
      headers: {
        accept: "application/json",
        authorization: `bearer ${input.token}`,
        "content-length": String(payload.body.length),
        "content-type": `multipart/form-data; boundary=${payload.boundary}`,
        "user-agent": "FosterFiscal-certecf-rfce/1.0",
      },
      body: new Blob([new Uint8Array(payload.body)]),
      cache: "no-store",
      redirect: "follow",
      signal: controller.signal,
    });
    const body = await response.text();
    if (Buffer.byteLength(body, "utf8") > MAX_RESPONSE_BYTES) {
      throw new DgiiGatewayError(
        "submit",
        "invalid_response",
        "A resposta RFCE da DGII excedeu o limite permitido",
        response.status,
        true,
      );
    }
    if (!response.ok) {
      throw new DgiiGatewayError(
        "submit",
        response.status === 401 || response.status === 403
          ? "authentication"
          : "http",
        sanitizeDgiiResponse(body),
        response.status,
        response.status >= 500,
      );
    }

    let value: Record<string, unknown>;
    try {
      value = JSON.parse(body) as Record<string, unknown>;
    } catch {
      throw new DgiiGatewayError(
        "submit",
        "invalid_response",
        "A DGII respondeu em formato RFCE nao reconhecido",
        response.status,
        true,
      );
    }
    const code = nullableNumber(value.codigo ?? value.Codigo);
    const officialStatus = nullableString(value.estado ?? value.Estado);
    return {
      httpStatus: response.status,
      durationMs: Math.max(0, Math.round(performance.now() - startedAt)),
      code,
      officialStatus,
      normalizedStatus: normalizeOfficialStatus(code, officialStatus),
      encf: nullableString(value.encf ?? value.eNCF ?? value.ENCF),
      sequenceUsed:
        typeof (value.secuenciaUtilizada ?? value.SecuenciaUtilizada) === "boolean"
          ? (value.secuenciaUtilizada ?? value.SecuenciaUtilizada) as boolean
          : null,
      messages: parseMessages(value.mensajes ?? value.Mensajes),
    };
  } catch (error: unknown) {
    if (error instanceof DgiiGatewayError) throw error;
    const timedOut = error instanceof Error && error.name === "AbortError";
    throw new DgiiGatewayError(
      "submit",
      timedOut ? "timeout" : "network",
      timedOut
        ? `Tempo limite de ${REQUEST_TIMEOUT_MS} ms excedido`
        : "Falha de rede ao enviar RFCE para a DGII",
      null,
      true,
    );
  } finally {
    clearTimeout(timer);
  }
}

export async function submitCommercialApprovalCertification(
  input: {
    xml: string;
    fileName: string;
    token: string;
  },
  fetchImpl: typeof fetch = fetch,
): Promise<CommercialApprovalReceptionResult> {
  const xmlBytes = Buffer.from(input.xml, "utf8");
  let payload: ReturnType<typeof multipartXml>;
  try {
    payload = multipartXml(xmlBytes, input.fileName);
  } catch {
    throw new DgiiGatewayError(
      "submit",
      "payload_mismatch",
      "Os bytes do ACECF no multipart diferem do XML validado",
      null,
      false,
    );
  }
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), REQUEST_TIMEOUT_MS);
  const startedAt = performance.now();
  try {
    const response = await fetchImpl(CERTECF_COMMERCIAL_APPROVAL_ENDPOINT, {
      method: "POST",
      headers: {
        accept: "application/json",
        authorization: `bearer ${input.token}`,
        "content-length": String(payload.body.length),
        "content-type": `multipart/form-data; boundary=${payload.boundary}`,
        "user-agent": "FosterFiscal-certecf-acecf/1.0",
      },
      body: new Blob([new Uint8Array(payload.body)]),
      cache: "no-store",
      redirect: "follow",
      signal: controller.signal,
    });
    const body = await response.text();
    if (Buffer.byteLength(body, "utf8") > MAX_RESPONSE_BYTES) {
      throw new DgiiGatewayError(
        "submit",
        "invalid_response",
        "A resposta ACECF da DGII excedeu o limite permitido",
        response.status,
        true,
      );
    }
    let value: Record<string, unknown>;
    try {
      value = JSON.parse(body) as Record<string, unknown>;
    } catch {
      throw new DgiiGatewayError(
        "submit",
        response.ok ? "invalid_response" : "http",
        response.ok
          ? "A DGII respondeu em formato ACECF nao reconhecido"
          : sanitizeDgiiResponse(body),
        response.status,
        response.status >= 500,
      );
    }
    const code = nullableString(value.codigo ?? value.Codigo);
    const officialStatus = nullableString(value.estado ?? value.Estado);
    const rawMessages = value.mensaje ?? value.Mensaje;
    const messages = Array.isArray(rawMessages)
      ? rawMessages
          .filter((message): message is string => typeof message === "string")
          .map((message) => message.trim())
          .filter(Boolean)
          .slice(0, 50)
      : [];
    const accepted =
      code === "01" ||
      code === "1" ||
      /aprobacion comercial aprobada/i.test(officialStatus ?? "");
    return {
      httpStatus: response.status,
      durationMs: Math.max(0, Math.round(performance.now() - startedAt)),
      code,
      officialStatus,
      accepted,
      messages,
    };
  } catch (error: unknown) {
    if (error instanceof DgiiGatewayError) throw error;
    const timedOut = error instanceof Error && error.name === "AbortError";
    throw new DgiiGatewayError(
      "submit",
      timedOut ? "timeout" : "network",
      timedOut
        ? `Tempo limite de ${REQUEST_TIMEOUT_MS} ms excedido`
        : "Falha de rede ao enviar ACECF para a DGII",
      null,
      true,
    );
  } finally {
    clearTimeout(timer);
  }
}
