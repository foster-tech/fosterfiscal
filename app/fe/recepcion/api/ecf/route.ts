import { NextRequest, NextResponse } from "next/server";

import {
  inboundConfig,
  inboundErrorResponse,
  multipartXml,
  xmlResponse,
} from "@/lib/dgii/inbound/http";
import { PostgresInboundRepository } from "@/lib/dgii/inbound/repository";
import { receiveEcf } from "@/lib/dgii/inbound/service";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";
export const fetchCache = "force-no-store";
export const revalidate = 0;
export const maxDuration = 30;

export async function POST(request: NextRequest): Promise<NextResponse> {
  try {
    const result = await receiveEcf(
      await multipartXml(request),
      request.headers.get("authorization"),
      inboundConfig(),
      new PostgresInboundRepository(),
    );
    return xmlResponse(result.xml);
  } catch (error: unknown) {
    return inboundErrorResponse(error);
  }
}
