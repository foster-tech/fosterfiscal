import { NextRequest, NextResponse } from "next/server";

import {
  inboundConfig,
  inboundErrorResponse,
  multipartXml,
  xmlResponse,
} from "@/lib/dgii/inbound/http";
import { PostgresInboundRepository } from "@/lib/dgii/inbound/repository";
import {
  authenticationTokenXml,
  validateCertificateAndIssueToken,
} from "@/lib/dgii/inbound/service";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";
export const fetchCache = "force-no-store";
export const revalidate = 0;
export const maxDuration = 30;

export async function POST(request: NextRequest): Promise<NextResponse> {
  try {
    const result = await validateCertificateAndIssueToken(
      await multipartXml(request),
      inboundConfig(),
      new PostgresInboundRepository(),
    );
    const acceptsXml = request.headers.get("accept")?.toLowerCase().includes("xml");
    if (acceptsXml) return xmlResponse(authenticationTokenXml(result));
    return NextResponse.json(
      { token: result.token, expira: result.expiresAt, expedido: result.issuedAt },
      { status: 200, headers: { "Cache-Control": "no-store", Pragma: "no-cache" } },
    );
  } catch (error: unknown) {
    return inboundErrorResponse(error);
  }
}
