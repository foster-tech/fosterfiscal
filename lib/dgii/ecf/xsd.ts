import { createHash } from "node:crypto";
import { readFile } from "node:fs/promises";
import path from "node:path";

import { validateXML } from "xmllint-wasm";

export const ECF31_SCHEMA = {
  version: "1.0",
  publishedModifiedDate: "2025-10-16",
  fileName: "ecf-31-v1.0.xsd",
  sha256: "6f2909a93d84919518d2ae3c77fead4b35c3e8c95996b8af67b0040c2e2be298",
  source:
    "https://dgii.gov.do/cicloContribuyente/facturacion/comprobantesFiscalesElectronicosE-CF/Documentacin%20sobre%20eCF/Documentaci%C3%B3n%20T%C3%A9cnica%20(XSD)/e-CF%2031%20v.1.0.xsd",
  dependencies: [] as string[],
  runtimeCompatibilityPatches: [
    "Remove o espaco inicial invalido do atributo name do simpleType IndicadorServicioTodoIncluidoType",
  ],
} as const;

export type XsdValidationError = {
  line: number | null;
  message: string;
};

let schemaPromise: Promise<string> | undefined;

function applyDocumentedCompatibilityPatch(schema: string): string {
  const invalid = 'name=" IndicadorServicioTodoIncluidoType"';
  const occurrences = schema.split(invalid).length - 1;
  if (occurrences !== 1) {
    throw new Error("O XSD E31 oficial nao contem o defeito tipografico esperado");
  }
  return schema.replace(invalid, 'name="IndicadorServicioTodoIncluidoType"');
}

function loadSchema(): Promise<string> {
  schemaPromise ??= readFile(
    path.join(process.cwd(), "schemas", "dgii", ECF31_SCHEMA.fileName),
    "utf8",
  ).then((schema) => {
    const digest = createHash("sha256").update(schema, "utf8").digest("hex");
    if (digest !== ECF31_SCHEMA.sha256) {
      throw new Error("O checksum do XSD E31 oficial nao corresponde ao registrado");
    }
    return applyDocumentedCompatibilityPatch(schema);
  });
  return schemaPromise;
}

function sanitizeValidationMessage(message: string): string {
  return message
    .replace(/The value '[^']*'/gi, "The value '[REDACTED]'")
    .replace(/C:\\[^:]+/gi, "[path]")
    .replace(/\s+/g, " ")
    .trim()
    .slice(0, 600);
}

export async function validateEcf31Xsd(xml: string): Promise<{
  valid: boolean;
  errors: XsdValidationError[];
}> {
  const schema = await loadSchema();
  const result = await validateXML({
    xml: [{ fileName: "ecf-31.xml", contents: xml }],
    schema: [{ fileName: ECF31_SCHEMA.fileName, contents: schema }],
    initialMemoryPages: 256,
    maxMemoryPages: 512,
  });

  return {
    valid: result.valid,
    errors: result.errors.slice(0, 20).map((error) => ({
      line: error.loc?.lineNumber ?? null,
      message: sanitizeValidationMessage(error.message),
    })),
  };
}
