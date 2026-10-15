import { DOMParser, onWarningStopParsing } from "@xmldom/xmldom";

import {
  CertificateConfigurationError,
  loadSigningMaterial,
  signSeedXml,
} from "./xml-signature";

const REQUEST_TIMEOUT_MS = 12_000;
const MAX_RESPONSE_BYTES = 128 * 1024;

const SEED_URL =
  "https://ecf.dgii.gov.do/testecf/autenticacion/api/autenticacion/semilla";
const VALIDATE_SEED_URL =
  "https://ecf.dgii.gov.do/testecf/autenticacion/api/autenticacion/validarsemilla";

export type AuthStage =
  | "obtain_seed"
  | "load_certificate"
  | "sign_seed"
  | "validate_seed"
  | "completed";

export type AuthStep = {
  stage: Exclude<AuthStage, "completed">;
  success: boolean;
  httpStatus: number | null;
  durationMs: number;
};

export type AuthTestSuccess = {
  success: true;
  stage: "completed";
  httpStatus: number;
  durationMs: number;
  steps: AuthStep[];
  authentication: {
    tokenReceived: true;
    issuedAt: string | null;
    expiresAt: string | null;
  };
};

export class DgiiAuthenticationError extends Error {
  constructor(
    public readonly stage: Exclude<AuthStage, "completed">,
    public readonly type:
      | "configuration"
      | "timeout"
      | "network"
      | "dgii_response"
      | "invalid_response"
      | "signature",
    public readonly diagnostic: string,
    public readonly httpStatus: number | null,
    public readonly steps: AuthStep[],
    public readonly durationMs: number,
  ) {
    super(diagnostic);
    this.name = "DgiiAuthenticationError";
  }
}

type AuthenticationResponse = {
  token: string;
  issuedAt: string | null;
  expiresAt: string | null;
};

function elapsedMilliseconds(startedAt: number): number {
  return Math.max(0, Math.round(performance.now() - startedAt));
}

function redactSensitiveText(value: string): string {
  return value
    .replace(
      /-----BEGIN [^-]+-----[\s\S]*?-----END [^-]+-----/gi,
      "[REDACTED]",
    )
    .replace(
      /(<(?:[\w.-]+:)?token\b[^>]*>)[\s\S]*?(<\/(?:[\w.-]+:)?token>)/gi,
      "$1[REDACTED]$2",
    )
    .replace(/("token"\s*:\s*")[^"]*(")/gi, "$1[REDACTED]$2")
    .replace(/\beyJ[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+\b/g, "[REDACTED]")
    .replace(/\b[A-Za-z0-9+/]{120,}={0,2}\b/g, "[REDACTED]")
    .slice(0, 2_000);
}

function redactObject(value: unknown, key = "", depth = 0): unknown {
  if (depth > 5) return "[TRUNCATED]";

  if (/token|password|senha|clave|secret|private.?key|cert(?:ificado|ificate)?/i.test(key)) {
    return "[REDACTED]";
  }

  if (Array.isArray(value)) {
    return value.slice(0, 20).map((item) => redactObject(item, "", depth + 1));
  }

  if (value && typeof value === "object") {
    return Object.fromEntries(
      Object.entries(value).map(([childKey, childValue]) => [
        childKey,
        redactObject(childValue, childKey, depth + 1),
      ]),
    );
  }

  if (typeof value === "string") return redactSensitiveText(value);
  return value;
}

export function sanitizeDgiiResponse(body: string): string {
  if (!body.trim()) return "A DGII nao forneceu detalhes adicionais";

  try {
    return redactSensitiveText(JSON.stringify(redactObject(JSON.parse(body))));
  } catch {
    return redactSensitiveText(body.replace(/\s+/g, " ").trim());
  }
}

async function responseText(response: Response): Promise<string> {
  const body = await response.text();
  if (Buffer.byteLength(body, "utf8") > MAX_RESPONSE_BYTES) {
    throw new Error("A resposta da DGII excede o limite permitido");
  }
  return body;
}

async function fetchWithTimeout(
  url: string,
  init: RequestInit,
): Promise<{ response: Response; durationMs: number }> {
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), REQUEST_TIMEOUT_MS);
  const startedAt = performance.now();

  try {
    const response = await fetch(url, {
      ...init,
      cache: "no-store",
      redirect: "follow",
      signal: controller.signal,
    });
    return { response, durationMs: elapsedMilliseconds(startedAt) };
  } finally {
    clearTimeout(timeout);
  }
}

function parseAuthenticationResponse(body: string): AuthenticationResponse {
  try {
    const parsed = JSON.parse(body) as Record<string, unknown>;
    const token = typeof parsed.token === "string" ? parsed.token : "";
    if (!token) throw new Error("token ausente");

    return {
      token,
      issuedAt: typeof parsed.expedido === "string" ? parsed.expedido : null,
      expiresAt: typeof parsed.expira === "string" ? parsed.expira : null,
    };
  } catch (jsonError: unknown) {
    try {
      if (/<!DOCTYPE|<!ENTITY/i.test(body)) throw new Error("DTD nao permitido");
      const document = new DOMParser({
        onError: onWarningStopParsing,
      }).parseFromString(body, "application/xml");
      const text = (name: string) =>
        document.getElementsByTagName(name).item(0)?.textContent?.trim() ?? "";
      const token = text("token");
      if (!token) throw new Error("token ausente");

      return {
        token,
        issuedAt: text("expedido") || null,
        expiresAt: text("expira") || null,
      };
    } catch {
      throw jsonError;
    }
  }
}

function networkFailure(
  stage: "obtain_seed" | "validate_seed",
  error: unknown,
  steps: AuthStep[],
  totalStartedAt: number,
): DgiiAuthenticationError {
  const timedOut = error instanceof Error && error.name === "AbortError";
  return new DgiiAuthenticationError(
    stage,
    timedOut ? "timeout" : "network",
    timedOut
      ? `Tempo limite de ${REQUEST_TIMEOUT_MS} ms excedido`
      : "Falha de rede ao acessar o servico da DGII",
    null,
    steps,
    elapsedMilliseconds(totalStartedAt),
  );
}

export async function runDgiiAuthenticationTest(config: {
  p12Base64: string;
  certificatePassword: string;
}): Promise<AuthTestSuccess> {
  const totalStartedAt = performance.now();
  const steps: AuthStep[] = [];

  let seedResponse: Response;
  let seedDuration: number;
  try {
    const result = await fetchWithTimeout(SEED_URL, {
      method: "GET",
      headers: {
        accept: "application/xml, text/xml, */*",
        "user-agent": "FosterFiscal-DGII-Auth-Test/1.0",
      },
    });
    seedResponse = result.response;
    seedDuration = result.durationMs;
  } catch (error: unknown) {
    throw networkFailure("obtain_seed", error, steps, totalStartedAt);
  }

  steps.push({
    stage: "obtain_seed",
    success: seedResponse.ok,
    httpStatus: seedResponse.status,
    durationMs: seedDuration,
  });

  let seedXml: string;
  try {
    seedXml = await responseText(seedResponse);
  } catch {
    throw new DgiiAuthenticationError(
      "obtain_seed",
      "invalid_response",
      "Nao foi possivel ler uma resposta valida da DGII",
      seedResponse.status,
      steps,
      elapsedMilliseconds(totalStartedAt),
    );
  }

  if (!seedResponse.ok) {
    throw new DgiiAuthenticationError(
      "obtain_seed",
      "dgii_response",
      sanitizeDgiiResponse(seedXml),
      seedResponse.status,
      steps,
      elapsedMilliseconds(totalStartedAt),
    );
  }

  const certificateStartedAt = performance.now();
  let material: Awaited<ReturnType<typeof loadSigningMaterial>>;
  try {
    material = await loadSigningMaterial(
      config.p12Base64,
      config.certificatePassword,
    );
    steps.push({
      stage: "load_certificate",
      success: true,
      httpStatus: null,
      durationMs: elapsedMilliseconds(certificateStartedAt),
    });
  } catch (error: unknown) {
    steps.push({
      stage: "load_certificate",
      success: false,
      httpStatus: null,
      durationMs: elapsedMilliseconds(certificateStartedAt),
    });
    throw new DgiiAuthenticationError(
      "load_certificate",
      "configuration",
      error instanceof CertificateConfigurationError
        ? error.message
        : "Nao foi possivel carregar o certificado digital",
      null,
      steps,
      elapsedMilliseconds(totalStartedAt),
    );
  }

  const signStartedAt = performance.now();
  let signedXml: string;
  try {
    signedXml = signSeedXml(seedXml, material);
    steps.push({
      stage: "sign_seed",
      success: true,
      httpStatus: null,
      durationMs: elapsedMilliseconds(signStartedAt),
    });
  } catch {
    steps.push({
      stage: "sign_seed",
      success: false,
      httpStatus: null,
      durationMs: elapsedMilliseconds(signStartedAt),
    });
    throw new DgiiAuthenticationError(
      "sign_seed",
      "signature",
      "Nao foi possivel gerar e verificar a assinatura XML",
      null,
      steps,
      elapsedMilliseconds(totalStartedAt),
    );
  }

  const form = new FormData();
  form.append(
    "xml",
    new Blob([signedXml], { type: "text/xml;charset=utf-8" }),
    "semilla-firmada.xml",
  );

  let validationResponse: Response;
  let validationDuration: number;
  try {
    const result = await fetchWithTimeout(VALIDATE_SEED_URL, {
      method: "POST",
      headers: {
        accept: "application/json",
        "user-agent": "FosterFiscal-DGII-Auth-Test/1.0",
      },
      body: form,
    });
    validationResponse = result.response;
    validationDuration = result.durationMs;
  } catch (error: unknown) {
    throw networkFailure("validate_seed", error, steps, totalStartedAt);
  }

  steps.push({
    stage: "validate_seed",
    success: validationResponse.ok,
    httpStatus: validationResponse.status,
    durationMs: validationDuration,
  });

  let validationBody: string;
  try {
    validationBody = await responseText(validationResponse);
  } catch {
    throw new DgiiAuthenticationError(
      "validate_seed",
      "invalid_response",
      "Nao foi possivel ler uma resposta valida da DGII",
      validationResponse.status,
      steps,
      elapsedMilliseconds(totalStartedAt),
    );
  }

  if (!validationResponse.ok) {
    throw new DgiiAuthenticationError(
      "validate_seed",
      "dgii_response",
      sanitizeDgiiResponse(validationBody),
      validationResponse.status,
      steps,
      elapsedMilliseconds(totalStartedAt),
    );
  }

  let authentication: AuthenticationResponse;
  try {
    authentication = parseAuthenticationResponse(validationBody);
  } catch {
    throw new DgiiAuthenticationError(
      "validate_seed",
      "invalid_response",
      `A DGII respondeu sem um token reconhecivel: ${sanitizeDgiiResponse(validationBody)}`,
      validationResponse.status,
      steps,
      elapsedMilliseconds(totalStartedAt),
    );
  }

  return {
    success: true,
    stage: "completed",
    httpStatus: validationResponse.status,
    durationMs: elapsedMilliseconds(totalStartedAt),
    steps,
    authentication: {
      tokenReceived: true,
      issuedAt: authentication.issuedAt,
      expiresAt: authentication.expiresAt,
    },
  };
}
