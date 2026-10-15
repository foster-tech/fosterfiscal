import { NextRequest, NextResponse } from "next/server";

import {
  authorizeDgiiTest,
  executionContext,
  noStoreJson,
} from "@/lib/dgii/access";

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

export async function GET(request: NextRequest): Promise<NextResponse> {
  const access = authorizeDgiiTest(request);
  if (!access.authorized) return access.response;

  const results = await Promise.all(DGII_ENDPOINTS.map(testEndpoint));
  const context = executionContext();

  return noStoreJson(
    {
      timestamp: new Date().toISOString(),
      ...context,
      results,
    },
    200,
  );
}
