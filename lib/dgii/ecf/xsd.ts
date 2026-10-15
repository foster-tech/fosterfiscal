import { createHash } from "node:crypto";
import { copyFile, mkdtemp, readFile, stat } from "node:fs/promises";
import { createRequire } from "node:module";
import { tmpdir } from "node:os";
import path from "node:path";

export const ECF31_SCHEMA = {
  version: "1.0",
  publishedModifiedDate: "2025-10-16",
  fileName: "ecf-31-v1.0.xsd",
  sha256: "6f2909a93d84919518d2ae3c77fead4b35c3e8c95996b8af67b0040c2e2be298",
  byteLength: 123019,
  encoding: "UTF-8 without BOM",
  lineEndings: "CRLF",
  source:
    "https://dgii.gov.do/cicloContribuyente/facturacion/comprobantesFiscalesElectronicosE-CF/Documentacin%20sobre%20eCF/Documentaci%C3%B3n%20T%C3%A9cnica%20(XSD)/e-CF%2031%20v.1.0.xsd",
  dependencies: [] as string[],
  runtimeCompatibilityPatches: [
    "Remove o espaco inicial invalido do atributo name do simpleType IndicadorServicioTodoIncluidoType",
  ],
  validator: {
    engine: "libxml2 via xmllint-wasm 5.3.0",
    execution: "isolated Node.js worker staged in the serverless temporary directory",
  },
} as const;

export type XsdValidationError = {
  line: number | null;
  message: string;
};

export type XsdRuntimeDiagnostic = {
  code:
    | "schema_load_failed"
    | "schema_checksum_failed"
    | "schema_encoding_failed"
    | "package_resolution_failed"
    | "runtime_asset_missing"
    | "runtime_asset_stage_failed"
    | "validator_module_load_failed"
    | "worker_start_failed"
    | "wasm_load_failed"
    | "validator_execution_failed";
  component: "xsd" | "xmllint_package" | "worker" | "wasm" | "validator";
  message: string;
  causeCode?: string;
};

export class XsdRuntimeError extends Error {
  constructor(public readonly diagnostic: XsdRuntimeDiagnostic) {
    super(diagnostic.message);
    this.name = "XsdRuntimeError";
  }
}

type XmllintModule = typeof import("xmllint-wasm");

let schemaPromise: Promise<string> | undefined;
let validatorPromise: Promise<XmllintModule["validateXML"]> | undefined;

function applyDocumentedCompatibilityPatch(schema: string): string {
  const invalid = 'name=" IndicadorServicioTodoIncluidoType"';
  const occurrences = schema.split(invalid).length - 1;
  if (occurrences !== 1) {
    throw new XsdRuntimeError({
      code: "schema_checksum_failed",
      component: "xsd",
      message: "O XSD oficial nao contem o defeito tipografico documentado esperado",
    });
  }
  return schema.replace(invalid, 'name="IndicadorServicioTodoIncluidoType"');
}

function safeCauseCode(error: unknown): string | undefined {
  if (!error || typeof error !== "object" || !("code" in error)) return undefined;
  const code = String(error.code);
  return /^[A-Z0-9_-]{1,40}$/.test(code) ? code : undefined;
}

function sanitizeRuntimeMessage(error: unknown): string {
  const raw = error instanceof Error ? error.message : String(error);
  return raw
    .replace(/<\?xml[\s\S]*$/gi, "[xml omitted]")
    .replace(/<[A-Za-z][^>]*>/g, "[xml omitted]")
    .replace(/[A-Za-z]:\\[^\s'\"]+/g, "[path]")
    .replace(/\/(?:var|tmp|home|workspace|opt|usr)\/[^\s'\"]+/g, "[path]")
    .replace(/[A-Za-z0-9+/=]{80,}/g, "[data omitted]")
    .replace(/\s+/g, " ")
    .trim()
    .slice(0, 400);
}

export function diagnoseXsdRuntimeError(error: unknown): XsdRuntimeDiagnostic {
  if (error instanceof XsdRuntimeError) return error.diagnostic;

  const sanitized = sanitizeRuntimeMessage(error);
  const causeCode = safeCauseCode(error);
  if (/\.wasm|webassembly|compileerror/i.test(sanitized)) {
    return {
      code: "wasm_load_failed",
      component: "wasm",
      message: sanitized || "O modulo WebAssembly do validador nao pode ser carregado",
      causeCode,
    };
  }
  if (/worker|xmllint-node\.js|err_worker/i.test(sanitized)) {
    return {
      code: "worker_start_failed",
      component: "worker",
      message: sanitized || "O worker do validador XSD nao pode ser iniciado",
      causeCode,
    };
  }
  return {
    code: "validator_execution_failed",
    component: "validator",
    message: sanitized || "O validador XSD encerrou sem informar uma causa",
    causeCode,
  };
}

function loadSchema(): Promise<string> {
  schemaPromise ??= (async () => {
    let schemaBytes: Buffer;
    try {
      schemaBytes = await readFile(
        path.join(process.cwd(), "schemas", "dgii", ECF31_SCHEMA.fileName),
      );
    } catch (error: unknown) {
      throw new XsdRuntimeError({
        code: "schema_load_failed",
        component: "xsd",
        message: `O arquivo XSD oficial nao esta acessivel no runtime (${sanitizeRuntimeMessage(error)})`,
        causeCode: safeCauseCode(error),
      });
    }

    // Hash the exact source bytes before decoding, newline handling or the
    // documented in-memory compatibility patch.
    const digest = createHash("sha256").update(schemaBytes).digest("hex");
    if (digest !== ECF31_SCHEMA.sha256) {
      throw new XsdRuntimeError({
        code: "schema_checksum_failed",
        component: "xsd",
        message: `O checksum dos bytes originais do XSD E31 nao corresponde ao oficial (esperado ${ECF31_SCHEMA.sha256}, recebido ${digest}, ${schemaBytes.byteLength} bytes)`,
      });
    }

    let schema: string;
    try {
      schema = new TextDecoder("utf-8", { fatal: true }).decode(schemaBytes);
    } catch (error: unknown) {
      throw new XsdRuntimeError({
        code: "schema_encoding_failed",
        component: "xsd",
        message: `O XSD oficial nao pode ser decodificado como UTF-8 (${sanitizeRuntimeMessage(error)})`,
        causeCode: safeCauseCode(error),
      });
    }
    return applyDocumentedCompatibilityPatch(schema);
  })();
  return schemaPromise;
}

async function requireIsolatedXmllint(): Promise<XmllintModule["validateXML"]> {
  const runtimeRequire = createRequire(path.join(process.cwd(), "package.json"));
  let packageEntry: string;
  try {
    packageEntry = runtimeRequire.resolve("xmllint-wasm");
  } catch (error: unknown) {
    throw new XsdRuntimeError({
      code: "package_resolution_failed",
      component: "xmllint_package",
      message: `O pacote xmllint-wasm nao pode ser resolvido no runtime (${sanitizeRuntimeMessage(error)})`,
      causeCode: safeCauseCode(error),
    });
  }

  const packageDirectory = path.dirname(packageEntry);
  const assetNames = ["index-node.js", "xmllint-node.js", "xmllint.wasm"] as const;
  for (const assetName of assetNames) {
    try {
      const info = await stat(
        path.join(/* turbopackIgnore: true */ packageDirectory, assetName),
      );
      if (!info.isFile() || info.size === 0) throw new Error("asset vazio ou nao regular");
    } catch (error: unknown) {
      throw new XsdRuntimeError({
        code: "runtime_asset_missing",
        component: assetName.endsWith(".wasm") ? "wasm" : "worker",
        message: `O recurso ${assetName} do xmllint-wasm nao esta acessivel no runtime (${sanitizeRuntimeMessage(error)})`,
        causeCode: safeCauseCode(error),
      });
    }
  }

  let stagedDirectory: string;
  try {
    stagedDirectory = await mkdtemp(path.join(tmpdir(), "fosterfiscal-xmllint-"));
    await Promise.all(
      assetNames.map((assetName) =>
        copyFile(
          path.join(/* turbopackIgnore: true */ packageDirectory, assetName),
          path.join(/* turbopackIgnore: true */ stagedDirectory, assetName),
        ),
      ),
    );
  } catch (error: unknown) {
    throw new XsdRuntimeError({
      code: "runtime_asset_stage_failed",
      component: "xmllint_package",
      message: `Os recursos do xmllint-wasm nao puderam ser preparados no diretorio temporario (${sanitizeRuntimeMessage(error)})`,
      causeCode: safeCauseCode(error),
    });
  }

  try {
    const isolatedRequire = createRequire(path.join(stagedDirectory, "loader.cjs"));
    const module = isolatedRequire(path.join(stagedDirectory, "index-node.js")) as XmllintModule;
    if (typeof module.validateXML !== "function") {
      throw new Error("export validateXML ausente");
    }
    return module.validateXML;
  } catch (error: unknown) {
    throw new XsdRuntimeError({
      code: "validator_module_load_failed",
      component: "xmllint_package",
      message: `O modulo isolado do xmllint-wasm nao pode ser carregado (${sanitizeRuntimeMessage(error)})`,
      causeCode: safeCauseCode(error),
    });
  }
}

function loadValidator(): Promise<XmllintModule["validateXML"]> {
  validatorPromise ??= requireIsolatedXmllint();
  return validatorPromise;
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
  const [schema, validateXML] = await Promise.all([loadSchema(), loadValidator()]);
  let result: Awaited<ReturnType<XmllintModule["validateXML"]>>;
  try {
    result = await validateXML({
      xml: [{ fileName: "ecf-31.xml", contents: xml }],
      schema: [{ fileName: ECF31_SCHEMA.fileName, contents: schema }],
      initialMemoryPages: 256,
      maxMemoryPages: 512,
    });
  } catch (error: unknown) {
    throw new XsdRuntimeError(diagnoseXsdRuntimeError(error));
  }

  return {
    valid: result.valid,
    errors: result.errors.slice(0, 20).map((error) => ({
      line: error.loc?.lineNumber ?? null,
      message: sanitizeValidationMessage(error.message),
    })),
  };
}
