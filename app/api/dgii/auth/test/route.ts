import { NextRequest, NextResponse } from "next/server";

import {
  authorizeDgiiTest,
  executionContext,
  noStoreJson,
} from "@/lib/dgii/access";
import {
  DgiiAuthenticationError,
  runDgiiAuthenticationTest,
} from "@/lib/dgii/authentication";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";
export const fetchCache = "force-no-store";
export const revalidate = 0;
export const maxDuration = 30;

function statusFor(error: DgiiAuthenticationError): number {
  if (error.type === "configuration") return 503;
  if (error.type === "signature") return 500;
  return 502;
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
        targetEnvironment: "testecf",
        stage: "configuration",
        httpStatus: null,
        durationMs: 0,
        steps: [],
        diagnostic: {
          type: "configuration",
          message: "Variaveis de ambiente obrigatorias nao configuradas",
          missing,
        },
      },
      503,
    );
  }

  try {
    const result = await runDgiiAuthenticationTest({
      p12Base64: p12Base64!,
      certificatePassword: certificatePassword!,
    });

    return noStoreJson(
      {
        timestamp: new Date().toISOString(),
        ...executionContext(),
        targetEnvironment: "testecf",
        ...result,
      },
      200,
    );
  } catch (error: unknown) {
    if (error instanceof DgiiAuthenticationError) {
      return noStoreJson(
        {
          success: false,
          timestamp: new Date().toISOString(),
          ...executionContext(),
          targetEnvironment: "testecf",
          stage: error.stage,
          httpStatus: error.httpStatus,
          durationMs: error.durationMs,
          steps: error.steps,
          verification: {
            certificateAndPrivateKey: error.steps.some(
              (step) => step.stage === "load_certificate" && step.success,
            )
              ? "matched_and_current"
              : "not_verified",
            signatureProfile: error.steps.some(
              (step) => step.stage === "sign_seed" && step.success,
            )
              ? "valid"
              : "not_verified",
            localCryptographicSignature: error.steps.some(
              (step) => step.stage === "sign_seed" && step.success,
            )
              ? "valid"
              : "not_verified",
            transmittedPayload: error.steps.some(
              (step) => step.stage === "prepare_payload" && step.success,
            )
              ? "byte_identical"
              : "not_verified",
          },
          diagnostic: {
            type: error.type,
            category: error.category,
            message: error.diagnostic,
            possibleCertificatePolicyRejection:
              error.category === "certificate_rejected" ||
              (error.category === "cryptographic_rejection" &&
                error.steps.some(
                  (step) => step.stage === "prepare_payload" && step.success,
                )),
          },
        },
        statusFor(error),
      );
    }

    return noStoreJson(
      {
        success: false,
        timestamp: new Date().toISOString(),
        ...executionContext(),
        targetEnvironment: "testecf",
        stage: "internal",
        httpStatus: null,
        durationMs: null,
        steps: [],
        diagnostic: {
          type: "internal",
          message: "Falha interna durante o teste de autenticacao",
        },
      },
      500,
    );
  }
}
