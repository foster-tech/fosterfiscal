import { NextResponse } from "next/server";

import { inboundErrorResponse, xmlResponse } from "@/lib/dgii/inbound/http";
import { PostgresInboundRepository } from "@/lib/dgii/inbound/repository";
import { createAuthenticationSeed } from "@/lib/dgii/inbound/service";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";
export const fetchCache = "force-no-store";
export const revalidate = 0;

export async function GET(): Promise<NextResponse> {
  try {
    const xml = await createAuthenticationSeed(new PostgresInboundRepository());
    return xmlResponse(xml);
  } catch (error: unknown) {
    return inboundErrorResponse(error);
  }
}
