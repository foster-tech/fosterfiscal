import { timingSafeEqual } from "node:crypto";

import { DOMParser, onWarningStopParsing } from "@xmldom/xmldom";

import { sanitizeDgiiResponse } from "../authentication";
import { SubmissionStatus, StoredDgiiMessage } from "./submission-types";

const REQUEST_TIMEOUT_MS = 12_000;
const MAX_RESPONSE_BYTES = 128 * 1024;

export const TESTECF_ENDPOINTS = Object.freeze({
  reception:
    "https://ecf.dgii.gov.do/testecf/recepcion/api/facturaselectronicas",
  result:
    "https://ecf.dgii.gov.do/testecf/consultaresultado/api/consultas/estado",
  trackIds:
    "https://ecf.dgii.gov.do/testecf/consultatrackids/api/trackids/consulta",
});

export type ReceptionResult = {
  httpStatus: number;
  durationMs: number;
  trackId: string | null;
  error: string | null;
  message: string | null;
};

export type DgiiStatusResult = {
  httpStatus: number;
  durationMs: number;
  trackId: string;
  code: number | null;
  officialStatus: string | null;
  normalizedStatus: SubmissionStatus;
  issuerRnc: string | null;
  encf: string | null;
  sequenceUsed: boolean | null;
  receivedAt: string | null;
  messages: StoredDgiiMessage[];
};

export type TrackIdCandidate = {
  trackId: string;
  officialStatus: string | null;
  receivedAt: string | null;
};

export class DgiiGatewayError extends Error {
  constructor(
    public readonly stage: "submit" | "query_status" | "reconcile_track_id",
    public readonly type:
      | "timeout"
      | "network"
      | "authentication"
      | "http"
      | "invalid_response"
      | "payload_mismatch",
    message: string,
    public readonly httpStatus: number | null,
    public readonly afterPossibleReceipt: boolean,
  ) {
    super(message);
    this.name = "DgiiGatewayError";
  }
}

function elapsed(startedAt: number): number {
  return Math.max(0, Math.round(performance.now() - startedAt));
}

async function boundedText(response: Response): Promise<string> {
  const body = await response.text();
  if (Buffer.byteLength(body, "utf8") > MAX_RESPONSE_BYTES) {
    throw new Error("A resposta da DGII excedeu o limite permitido");
  }
  return body;
}

async function request(
  stage: DgiiGatewayError["stage"],
  url: string,
  init: RequestInit,
  fetchImpl: typeof fetch,
  afterPossibleReceipt: boolean,
): Promise<{ response: Response; body: string; durationMs: number }> {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), REQUEST_TIMEOUT_MS);
  const startedAt = performance.now();
  try {
    const response = await fetchImpl(url, {
      ...init,
      cache: "no-store",
      redirect: "follow",
      signal: controller.signal,
    });
    let body: string;
    try {
      body = await boundedText(response);
    } catch {
      throw new DgiiGatewayError(
        stage,
        "invalid_response",
        "A resposta da DGII nao pode ser processada com seguranca",
        response.status,
        afterPossibleReceipt,
      );
    }
    if (!response.ok) {
      const type = response.status === 401 || response.status === 403
        ? "authentication"
        : "http";
      throw new DgiiGatewayError(
        stage,
        type,
        sanitizeDgiiResponse(body),
        response.status,
        afterPossibleReceipt && response.status >= 500,
      );
    }
    return { response, body, durationMs: elapsed(startedAt) };
  } catch (error: unknown) {
    if (error instanceof DgiiGatewayError) throw error;
    const timeout = error instanceof Error && error.name === "AbortError";
    throw new DgiiGatewayError(
      stage,
      timeout ? "timeout" : "network",
      timeout
        ? `Tempo limite de ${REQUEST_TIMEOUT_MS} ms excedido`
        : "Falha de rede ao acessar a DGII",
      null,
      afterPossibleReceipt,
    );
  } finally {
    clearTimeout(timer);
  }
}

function xmlDocument(body: string) {
  if (/<!DOCTYPE|<!ENTITY/i.test(body)) throw new Error("DTD nao permitido");
  return new DOMParser({ onError: onWarningStopParsing }).parseFromString(
    body,
    "application/xml",
  );
}

function xmlText(
  document: ReturnType<DOMParser["parseFromString"]>,
  ...names: string[]
): string | null {
  for (const name of names) {
    const value = document.getElementsByTagName(name).item(0)?.textContent?.trim();
    if (value) return value;
  }
  return null;
}

function objectString(value: unknown, ...keys: string[]): string | null {
  if (!value || typeof value !== "object") return null;
  const object = value as Record<string, unknown>;
  for (const key of keys) {
    const found = object[key];
    if (typeof found === "string" && found.trim()) return found.trim();
  }
  return null;
}

function parseReception(body: string): Pick<ReceptionResult, "trackId" | "error" | "message"> {
  try {
    const value = JSON.parse(body) as unknown;
    return {
      trackId: objectString(value, "trackId", "TrackId"),
      error: objectString(value, "error", "Error"),
      message: objectString(value, "mensaje", "message", "Mensaje"),
    };
  } catch {
    const document = xmlDocument(body);
    return {
      trackId: xmlText(document, "trackId", "TrackId"),
      error: xmlText(document, "error", "Error"),
      message: xmlText(document, "mensaje", "Mensaje"),
    };
  }
}

export async function submitEcfTest(
  input: {
    xml: string;
    issuerRnc: string;
    encf: string;
    token: string;
  },
  fetchImpl: typeof fetch = fetch,
): Promise<ReceptionResult> {
  const xmlBytes = Buffer.from(input.xml, "utf8");
  const blob = new Blob([new Uint8Array(xmlBytes)], { type: "text/xml" });
  const payloadBytes = Buffer.from(await blob.arrayBuffer());
  if (
    payloadBytes.length !== xmlBytes.length ||
    !timingSafeEqual(payloadBytes, xmlBytes)
  ) {
    throw new DgiiGatewayError(
      "submit",
      "payload_mismatch",
      "Os bytes do XML no multipart diferem do XML validado",
      null,
      false,
    );
  }

  const form = new FormData();
  form.append("xml", blob, `${input.issuerRnc}${input.encf}.xml`);
  const result = await request(
    "submit",
    TESTECF_ENDPOINTS.reception,
    {
      method: "POST",
      headers: {
        accept: "application/json",
        authorization: `bearer ${input.token}`,
        "user-agent": "FosterFiscal-TesteCF/1.0",
      },
      body: form,
    },
    fetchImpl,
    true,
  );
  let parsed: ReturnType<typeof parseReception>;
  try {
    parsed = parseReception(result.body);
  } catch {
    throw new DgiiGatewayError(
      "submit",
      "invalid_response",
      "A DGII respondeu em formato de recepcao nao reconhecido",
      result.response.status,
      true,
    );
  }
  return { httpStatus: result.response.status, durationMs: result.durationMs, ...parsed };
}

export function normalizeOfficialStatus(
  code: number | null,
  officialStatus: string | null,
): SubmissionStatus {
  if (code === 0) return "not_found";
  if (code === 1) return "accepted";
  if (code === 2) return "rejected";
  if (code === 3) return "processing";
  if (code === 4) return "accepted_conditional";
  const normalized = (officialStatus ?? "")
    .normalize("NFD")
    .replace(/[\u0300-\u036f]/g, "")
    .toLowerCase();
  if (normalized.includes("aceptado condicional")) return "accepted_conditional";
  if (normalized.includes("aceptado")) return "accepted";
  if (normalized.includes("rechazado")) return "rejected";
  if (normalized.includes("proceso")) return "processing";
  if (normalized.includes("no encontrado")) return "not_found";
  return "communication_failure";
}

function parseMessages(value: unknown): StoredDgiiMessage[] {
  if (!Array.isArray(value)) return [];
  return value.slice(0, 50).flatMap((entry) => {
    if (!entry || typeof entry !== "object") return [];
    const object = entry as Record<string, unknown>;
    const text = objectString(object, "valor", "Valor");
    if (!text) return [];
    const rawCode = object.codigo ?? object.Codigo ?? null;
    return [{
      code: typeof rawCode === "number" || typeof rawCode === "string" ? rawCode : null,
      value: text.slice(0, 1_000),
    }];
  });
}

function nullableBoolean(value: unknown): boolean | null {
  return typeof value === "boolean" ? value : null;
}

function nullableNumber(value: unknown): number | null {
  if (typeof value === "number" && Number.isFinite(value)) return value;
  if (typeof value === "string" && /^\d+$/.test(value)) return Number(value);
  return null;
}

export async function queryEcfResultTest(
  trackId: string,
  token: string,
  fetchImpl: typeof fetch = fetch,
): Promise<DgiiStatusResult> {
  const url = new URL(TESTECF_ENDPOINTS.result);
  url.searchParams.set("trackid", trackId);
  const result = await request(
    "query_status",
    url.toString(),
    {
      method: "GET",
      headers: {
        accept: "application/json",
        authorization: `bearer ${token}`,
        "user-agent": "FosterFiscal-TesteCF/1.0",
      },
    },
    fetchImpl,
    false,
  );

  try {
    const value = JSON.parse(result.body) as Record<string, unknown>;
    const code = nullableNumber(value.codigo ?? value.Codigo);
    const officialStatus = objectString(value, "estado", "Estado");
    return {
      httpStatus: result.response.status,
      durationMs: result.durationMs,
      trackId: objectString(value, "trackId", "TrackId") ?? trackId,
      code,
      officialStatus,
      normalizedStatus: normalizeOfficialStatus(code, officialStatus),
      issuerRnc: objectString(value, "rnc", "RNC"),
      encf: objectString(value, "eNCF", "encf", "ENCF"),
      sequenceUsed: nullableBoolean(value.secuenciaUtilizada ?? value.SecuenciaUtilizada),
      receivedAt: objectString(value, "fechaRecepcion", "FechaRecepcion"),
      messages: parseMessages(value.mensajes ?? value.Mensajes),
    };
  } catch {
    throw new DgiiGatewayError(
      "query_status",
      "invalid_response",
      "A DGII respondeu em formato de consulta nao reconhecido",
      result.response.status,
      false,
    );
  }
}

function candidate(value: unknown): TrackIdCandidate | null {
  const trackId = objectString(value, "trackId", "TrackId");
  if (!trackId) return null;
  return {
    trackId,
    officialStatus: objectString(value, "estado", "Estado"),
    receivedAt: objectString(value, "fechaRecepcion", "FechaRecepcion"),
  };
}

export async function queryTrackIdsTest(
  issuerRnc: string,
  encf: string,
  token: string,
  fetchImpl: typeof fetch = fetch,
): Promise<{ httpStatus: number; durationMs: number; candidates: TrackIdCandidate[] }> {
  const url = new URL(TESTECF_ENDPOINTS.trackIds);
  url.searchParams.set("rncemisor", issuerRnc);
  url.searchParams.set("encf", encf);
  const result = await request(
    "reconcile_track_id",
    url.toString(),
    {
      method: "GET",
      headers: {
        accept: "application/json",
        authorization: `bearer ${token}`,
        "user-agent": "FosterFiscal-TesteCF/1.0",
      },
    },
    fetchImpl,
    false,
  );
  try {
    const parsed = JSON.parse(result.body) as unknown;
    const values = Array.isArray(parsed) ? parsed : [parsed];
    return {
      httpStatus: result.response.status,
      durationMs: result.durationMs,
      candidates: values.map(candidate).filter((value): value is TrackIdCandidate => value !== null),
    };
  } catch {
    throw new DgiiGatewayError(
      "reconcile_track_id",
      "invalid_response",
      "A DGII respondeu em formato de reconciliacao nao reconhecido",
      result.response.status,
      false,
    );
  }
}
