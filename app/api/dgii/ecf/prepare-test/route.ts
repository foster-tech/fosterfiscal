import { NextRequest, NextResponse } from "next/server";

import {
  authorizeDgiiTest,
  executionContext,
  noStoreJson,
} from "@/lib/dgii/access";
import { EcfPreparationError, prepareEcf31 } from "@/lib/dgii/ecf/prepare";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";
export const fetchCache = "force-no-store";
export const revalidate = 0;
export const maxDuration = 30;

const MAX_REQUEST_BYTES = 256 * 1024;

function errorStatus(error: EcfPreparationError): number {
  if (error.category === "input_validation" || error.category === "totals_inconsistent") {
    return 400;
  }
  if (error.category === "xsd_validation") return 422;
  if (error.category === "certificate_configuration") return 503;
  return 500;
}

export async function POST(request: NextRequest): Promise<NextResponse> {
  const access = authorizeDgiiTest(request);
  if (!access.authorized) return access.response;

  const p12Base64 = process.env.DGII_CERT_P12_BASE64;
  const certificatePassword = process.env.DGII_CERT_PASSWORD;
  const missing = [
    !p12Base64 && "DGII_CERT_P12_BASE64",
    certificatePassword === undefined && "DGII_CERT_PASSWORD",
  ].filter((name): name is string => Boolean(name));
  if (missing.length > 0) {
    return noStoreJson(
      {
        success: false,
        timestamp: new Date().toISOString(),
        ...executionContext(),
        stage: "configuration",
        diagnostic: {
          category: "certificate_configuration",
          message: "Variaveis de ambiente obrigatorias nao configuradas",
          missing,
        },
      },
      503,
    );
  }

  if (!request.headers.get("content-type")?.toLowerCase().includes("application/json")) {
    return noStoreJson(
      {
        success: false,
        timestamp: new Date().toISOString(),
        ...executionContext(),
        stage: "validate_input",
        diagnostic: {
          category: "input_validation",
          message: "Use Content-Type application/json",
        },
      },
      415,
    );
  }

  let raw: unknown;
  try {
    const body = await request.text();
    if (Buffer.byteLength(body, "utf8") > MAX_REQUEST_BYTES) {
      return noStoreJson(
        {
          success: false,
          timestamp: new Date().toISOString(),
          ...executionContext(),
          stage: "validate_input",
          diagnostic: {
            category: "input_validation",
            message: "O corpo excede o limite de 256 KiB",
          },
        },
        413,
      );
    }
    raw = JSON.parse(body);
  } catch {
    return noStoreJson(
      {
        success: false,
        timestamp: new Date().toISOString(),
        ...executionContext(),
        stage: "validate_input",
        diagnostic: {
          category: "input_validation",
          message: "O corpo deve conter JSON valido",
        },
      },
      400,
    );
  }

  try {
    const result = await prepareEcf31(raw, {
      p12Base64: p12Base64!,
      certificatePassword: certificatePassword!,
    });

    if (request.nextUrl.searchParams.get("download") === "1") {
      return new NextResponse(result.xml, {
        status: 200,
        headers: {
          "Cache-Control": "no-store, no-cache, must-revalidate, proxy-revalidate",
          "Content-Disposition": 'attachment; filename="ecf31-test-signed.xml"',
          "Content-Type": "application/xml; charset=utf-8",
          Expires: "0",
          Pragma: "no-cache",
          "X-Content-Type-Options": "nosniff",
        },
      });
    }

    return noStoreJson(
      {
        success: true,
        timestamp: new Date().toISOString(),
        ...executionContext(),
        targetEnvironment: "local-preparation-only",
        documentType: 31,
        stage: "completed",
        steps: result.steps,
        totals: {
          taxableAmount: result.totals.taxableAmount,
          exemptAmount: result.totals.exemptAmount,
          itbis: result.totals.itbis,
          total: result.totals.total,
        },
        schema: result.schema,
        verification: {
          xsd: "valid",
          signatureProfile: "valid",
          cryptographicSignature: "valid",
        },
        download: "/api/dgii/ecf/prepare-test?download=1",
        transmittedToDgii: false,
      },
      200,
    );
  } catch (error: unknown) {
    if (error instanceof EcfPreparationError) {
      return noStoreJson(
        {
          success: false,
          timestamp: new Date().toISOString(),
          ...executionContext(),
          targetEnvironment: "local-preparation-only",
          documentType: 31,
          stage: error.stage,
          steps: error.steps,
          diagnostic: {
            category: error.category,
            message: error.message,
            issues: error.issues,
            xsdErrors: error.xsdErrors,
            runtime: error.runtimeDiagnostic,
          },
          transmittedToDgii: false,
        },
        errorStatus(error),
      );
    }

    return noStoreJson(
      {
        success: false,
        timestamp: new Date().toISOString(),
        ...executionContext(),
        targetEnvironment: "local-preparation-only",
        documentType: 31,
        stage: "internal",
        diagnostic: {
          category: "internal",
          message: "Falha interna ao preparar a e-CF",
        },
        transmittedToDgii: false,
      },
      500,
    );
  }
}
