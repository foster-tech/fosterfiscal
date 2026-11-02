import { NextRequest, NextResponse } from "next/server";

import { InboundServiceError, type InboundConfig } from "./service";

const MAX_REQUEST_BYTES = 4 * 1024 * 1024;

const NO_STORE_HEADERS = {
  "Cache-Control": "no-store, max-age=0",
  Pragma: "no-cache",
  "X-Content-Type-Options": "nosniff",
};

export function inboundConfig(): InboundConfig {
  return {
    receiverRnc: process.env.DGII_RECEIVER_RNC ?? "",
    p12Base64: process.env.DGII_CERT_P12_BASE64 ?? "",
    certificatePassword: process.env.DGII_CERT_PASSWORD ?? "",
    storageEncryptionKeyBase64:
      process.env.DGII_STORAGE_ENCRYPTION_KEY_BASE64 ?? "",
  };
}

export async function multipartXml(request: NextRequest): Promise<string> {
  const contentType = request.headers.get("content-type")?.toLowerCase() ?? "";
  if (!contentType.includes("multipart/form-data")) {
    throw new InboundServiceError(
      "unsupported_media_type",
      415,
      "Use multipart/form-data com o arquivo no campo xml",
    );
  }
  const contentLength = Number(request.headers.get("content-length") ?? "0");
  if (Number.isFinite(contentLength) && contentLength > MAX_REQUEST_BYTES) {
    throw new InboundServiceError("request_too_large", 413, "O corpo excede 4 MiB");
  }

  let form: FormData;
  try {
    form = await request.formData();
  } catch {
    throw new InboundServiceError("invalid_multipart", 400, "Multipart invalido");
  }
  const part = form.get("xml");
  if (!part || typeof part === "string") {
    throw new InboundServiceError("missing_xml", 400, "Arquivo xml ausente");
  }
  if (part.size === 0 || part.size > MAX_REQUEST_BYTES) {
    throw new InboundServiceError(
      "invalid_xml_size",
      part.size > MAX_REQUEST_BYTES ? 413 : 400,
      part.size > MAX_REQUEST_BYTES ? "O XML excede 4 MiB" : "O arquivo XML esta vazio",
    );
  }
  return part.text();
}

export function xmlResponse(xml: string, status = 200): NextResponse {
  return new NextResponse(xml, {
    status,
    headers: {
      ...NO_STORE_HEADERS,
      "Content-Type": "application/xml; charset=utf-8",
    },
  });
}

export function emptyResponse(status = 200): NextResponse {
  return new NextResponse(null, { status, headers: NO_STORE_HEADERS });
}

export function inboundErrorResponse(error: unknown): NextResponse {
  if (error instanceof InboundServiceError) {
    return NextResponse.json(
      { success: false, code: error.code, message: error.message },
      { status: error.httpStatus, headers: NO_STORE_HEADERS },
    );
  }
  return NextResponse.json(
    { success: false, code: "internal", message: "Falha interna no servico de faturacao eletronica" },
    { status: 500, headers: NO_STORE_HEADERS },
  );
}
