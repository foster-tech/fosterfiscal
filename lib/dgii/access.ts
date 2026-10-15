import { createHash, timingSafeEqual } from "node:crypto";
import { NextRequest, NextResponse } from "next/server";

export type AccessCheck =
  | { authorized: true }
  | { authorized: false; response: NextResponse };

function tokenMatches(receivedToken: string | null, expectedToken: string): boolean {
  if (!receivedToken) return false;

  const receivedDigest = createHash("sha256").update(receivedToken).digest();
  const expectedDigest = createHash("sha256").update(expectedToken).digest();
  return timingSafeEqual(receivedDigest, expectedDigest);
}

export function noStoreJson(body: unknown, status: number): NextResponse {
  return NextResponse.json(body, {
    status,
    headers: {
      "Cache-Control": "no-store, no-cache, must-revalidate, proxy-revalidate",
      Expires: "0",
      Pragma: "no-cache",
    },
  });
}

export function authorizeDgiiTest(request: NextRequest): AccessCheck {
  const expectedToken = process.env.DGII_TEST_TOKEN;

  if (!expectedToken) {
    return {
      authorized: false,
      response: noStoreJson(
        { error: "Diagnostico indisponivel: configuracao ausente" },
        503,
      ),
    };
  }

  if (!tokenMatches(request.headers.get("x-dgii-test-token"), expectedToken)) {
    return {
      authorized: false,
      response: noStoreJson({ error: "Nao autorizado" }, 401),
    };
  }

  return { authorized: true };
}

export function executionContext(): {
  environment: string;
  region: string;
} {
  const isVercel = process.env.VERCEL === "1";

  return {
    environment:
      process.env.VERCEL_ENV ??
      (isVercel ? "vercel" : process.env.NODE_ENV ?? "unknown"),
    region: process.env.VERCEL_REGION ?? (isVercel ? "unknown" : "local"),
  };
}
