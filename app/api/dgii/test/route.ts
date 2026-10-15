import { createHash, timingSafeEqual } from "node:crypto";
import { NextRequest, NextResponse } from "next/server";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";
export const fetchCache = "force-no-store";
export const revalidate = 0;

const TIMEOUT_MS = 12_000;

const DGII_ENDPOINTS = [
  {
    name: "DGII - Recepcion e-CF",
    url: "https://ecf.dgii.gov.do/ecf/recepcion/help/index.html",
  },
  {
    name: "DGII - Semilla de autenticacion (teste)",
    url: "https://ecf.dgii.gov.do/testecf/autenticacion/api/autenticacion/semilla",
  },
  {
    name: "DGII - Facturador Gratuito",
    url: "https://fg.dgii.gov.do/",
  },
] as const;

type NetworkError = {
  type: "timeout" | "network";
  message: string;
};

type TestResult = {
  name: string;
  url: string;
  reachable: boolean;
  httpStatus: number | null;
  durationMs: number;
  error: NetworkError | null;
};

function tokenMatches(receivedToken: string | null, expectedToken: string): boolean {
  if (!receivedToken) return false;

  const receivedDigest = createHash("sha256").update(receivedToken).digest();
  const expectedDigest = createHash("sha256").update(expectedToken).digest();
  return timingSafeEqual(receivedDigest, expectedDigest);
}

function elapsedMilliseconds(startedAt: number): number {
  return Math.max(0, Math.round(performance.now() - startedAt));
}

async function testEndpoint(
  endpoint: (typeof DGII_ENDPOINTS)[number],
): Promise<TestResult> {
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), TIMEOUT_MS);
  const startedAt = performance.now();

  try {
    const response = await fetch(endpoint.url, {
      method: "GET",
      cache: "no-store",
      redirect: "follow",
      signal: controller.signal,
      headers: {
        accept: "*/*",
        "user-agent": "FosterFiscal-DGII-Connectivity-Test/1.0",
      },
    });

    return {
      name: endpoint.name,
      url: endpoint.url,
      reachable: true,
      httpStatus: response.status,
      durationMs: elapsedMilliseconds(startedAt),
      error: null,
    };
  } catch (error: unknown) {
    const timedOut =
      controller.signal.aborted ||
      (error instanceof Error && error.name === "AbortError");

    return {
      name: endpoint.name,
      url: endpoint.url,
      reachable: false,
      httpStatus: null,
      durationMs: elapsedMilliseconds(startedAt),
      error: timedOut
        ? { type: "timeout", message: `Tempo limite de ${TIMEOUT_MS} ms excedido` }
        : { type: "network", message: "Falha de rede ao acessar o servico" },
    };
  } finally {
    clearTimeout(timeout);
  }
}

function noStoreJson(body: unknown, status: number): NextResponse {
  return NextResponse.json(body, {
    status,
    headers: {
      "Cache-Control": "no-store, no-cache, must-revalidate, proxy-revalidate",
      Expires: "0",
      Pragma: "no-cache",
    },
  });
}

export async function GET(request: NextRequest): Promise<NextResponse> {
  const expectedToken = process.env.DGII_TEST_TOKEN;

  if (!expectedToken) {
    return noStoreJson(
      { error: "Diagnostico indisponivel: configuracao ausente" },
      503,
    );
  }

  if (!tokenMatches(request.headers.get("x-dgii-test-token"), expectedToken)) {
    return noStoreJson({ error: "Nao autorizado" }, 401);
  }

  const results = await Promise.all(DGII_ENDPOINTS.map(testEndpoint));
  const isVercel = process.env.VERCEL === "1";

  return noStoreJson(
    {
      timestamp: new Date().toISOString(),
      environment:
        process.env.VERCEL_ENV ??
        (isVercel ? "vercel" : process.env.NODE_ENV ?? "unknown"),
      region: process.env.VERCEL_REGION ?? (isVercel ? "unknown" : "local"),
      results,
    },
    200,
  );
}
