import { NextRequest, NextResponse } from "next/server";

import { authorizeDgiiTest, executionContext, noStoreJson } from "@/lib/dgii/access";
import { PostgresSubmissionRepository } from "@/lib/dgii/ecf/repository";
import {
  refreshTestEcfStatus,
  SubmissionServiceError,
} from "@/lib/dgii/ecf/submission-service";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";
export const fetchCache = "force-no-store";
export const revalidate = 0;
export const maxDuration = 30;

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;

export async function GET(request: NextRequest): Promise<NextResponse> {
  const access = authorizeDgiiTest(request);
  if (!access.authorized) return access.response;

  const id = request.nextUrl.searchParams.get("id") ?? "";
  if (!UUID.test(id)) {
    return noStoreJson({ success: false, stage: "validate_input", diagnostic: {
      category: "input_validation", message: "Parametro id ausente ou invalido",
    } }, 400);
  }
  const p12Base64 = process.env.DGII_CERT_P12_BASE64 ?? "";
  const certificatePassword = process.env.DGII_CERT_PASSWORD ?? "";
  if (!p12Base64 || process.env.DGII_CERT_PASSWORD === undefined) {
    return noStoreJson({ success: false, stage: "configuration", diagnostic: {
      category: "certificate_configuration",
      message: "Variaveis do certificado digital nao configuradas",
    } }, 503);
  }

  try {
    const result = await refreshTestEcfStatus(id, {
      enabled: process.env.DGII_ENABLE_TEST_SUBMISSION === "true",
      p12Base64,
      certificatePassword,
      storageEncryptionKeyBase64: process.env.DGII_STORAGE_ENCRYPTION_KEY_BASE64 ?? "",
    }, { repository: new PostgresSubmissionRepository() });
    return noStoreJson({
      success: true,
      timestamp: new Date().toISOString(),
      ...executionContext(),
      targetEnvironment: "testecf",
      ...result,
      fiscallyAccepted: result.status === "accepted" || result.status === "accepted_conditional",
    }, 200);
  } catch (error: unknown) {
    if (error instanceof SubmissionServiceError) {
      return noStoreJson({ success: false, stage: "status_control", diagnostic: {
        category: error.code, message: error.message,
      } }, error.httpStatus);
    }
    return noStoreJson({
      success: false,
      timestamp: new Date().toISOString(),
      ...executionContext(),
      targetEnvironment: "testecf",
      stage: "internal",
      diagnostic: { category: "internal", message: "Falha interna ao consultar a submissao" },
    }, 500);
  }
}
