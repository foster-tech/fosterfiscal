import { NextRequest, NextResponse } from "next/server";

import { authorizeDgiiTest, executionContext, noStoreJson } from "@/lib/dgii/access";
import { EcfPreparationError } from "@/lib/dgii/ecf/prepare";
import { PostgresSubmissionRepository } from "@/lib/dgii/ecf/repository";
import {
  sendTestEcf,
  SubmissionServiceError,
} from "@/lib/dgii/ecf/submission-service";
import { StorageEncryptionConfigurationError } from "@/lib/dgii/ecf/storage-crypto";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";
export const fetchCache = "force-no-store";
export const revalidate = 0;
export const maxDuration = 60;

const MAX_REQUEST_BYTES = 256 * 1024;

function preparationStatus(error: EcfPreparationError): number {
  if (error.category === "input_validation" || error.category === "totals_inconsistent") return 400;
  if (error.category === "xsd_validation") return 422;
  if (error.category === "certificate_configuration") return 503;
  return 500;
}

function resultStatus(result: Awaited<ReturnType<typeof sendTestEcf>>): number {
  if (result.idempotentReplay) return 200;
  if (result.status === "received" || result.status === "indeterminate") return 202;
  if (result.status === "rejected") return 422;
  if (result.status === "authentication_failed" || result.status === "communication_failure") return 502;
  return 200;
}

export async function POST(request: NextRequest): Promise<NextResponse> {
  const access = authorizeDgiiTest(request);
  if (!access.authorized) return access.response;

  if (!request.headers.get("content-type")?.toLowerCase().includes("application/json")) {
    return noStoreJson({ success: false, stage: "validate_input", diagnostic: {
      category: "input_validation", message: "Use Content-Type application/json",
    } }, 415);
  }

  let raw: unknown;
  try {
    const body = await request.text();
    if (Buffer.byteLength(body, "utf8") > MAX_REQUEST_BYTES) {
      return noStoreJson({ success: false, stage: "validate_input", diagnostic: {
        category: "input_validation", message: "O corpo excede o limite de 256 KiB",
      } }, 413);
    }
    raw = JSON.parse(body);
  } catch {
    return noStoreJson({ success: false, stage: "validate_input", diagnostic: {
      category: "input_validation", message: "O corpo deve conter JSON valido",
    } }, 400);
  }

  const config = {
    enabled: process.env.DGII_ENABLE_TEST_SUBMISSION === "true",
    p12Base64: process.env.DGII_CERT_P12_BASE64 ?? "",
    certificatePassword: process.env.DGII_CERT_PASSWORD ?? "",
    storageEncryptionKeyBase64: process.env.DGII_STORAGE_ENCRYPTION_KEY_BASE64 ?? "",
  };

  try {
    const result = await sendTestEcf(
      raw,
      request.headers.get("idempotency-key"),
      config,
      { repository: new PostgresSubmissionRepository() },
    );
    return noStoreJson({
      success: ![
        "rejected",
        "authentication_failed",
        "communication_failure",
      ].includes(result.status),
      timestamp: new Date().toISOString(),
      ...executionContext(),
      targetEnvironment: "testecf",
      stage: "submission_recorded",
      ...result,
      warning: "HTTP de recepcao ou TrackId nao equivale a aceitacao fiscal; consulte status-test.",
    }, resultStatus(result));
  } catch (error: unknown) {
    if (error instanceof SubmissionServiceError) {
      return noStoreJson({
        success: false,
        timestamp: new Date().toISOString(),
        ...executionContext(),
        targetEnvironment: "testecf",
        stage: "submission_control",
        diagnostic: { category: error.code, message: error.message },
        existingId: error.recordId ?? null,
      }, error.httpStatus);
    }
    if (error instanceof EcfPreparationError) {
      return noStoreJson({
        success: false,
        timestamp: new Date().toISOString(),
        ...executionContext(),
        targetEnvironment: "testecf",
        stage: error.stage,
        steps: error.steps,
        diagnostic: {
          category: error.category,
          message: error.message,
          issues: error.issues,
          xsdErrors: error.xsdErrors,
          runtime: error.runtimeDiagnostic,
        },
      }, preparationStatus(error));
    }
    if (error instanceof StorageEncryptionConfigurationError) {
      return noStoreJson({ success: false, stage: "configuration", diagnostic: {
        category: "storage_encryption", message: error.message,
      } }, 503);
    }
    return noStoreJson({
      success: false,
      timestamp: new Date().toISOString(),
      ...executionContext(),
      targetEnvironment: "testecf",
      stage: "internal",
      diagnostic: { category: "internal", message: "Falha interna ao registrar ou enviar a e-CF" },
    }, 500);
  }
}
