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

export type DgiiSchemaDefinition = {
  version: "1.0";
  publishedModifiedDate: string;
  fileName: string;
  sha256: string;
  byteLength: number;
  encoding: "UTF-8 with BOM" | "UTF-8 without BOM";
  lineEndings: "CRLF";
  source: string;
  dependencies: readonly string[];
  runtimeCompatibilityPatches: readonly string[];
  validator: {
    engine: string;
    execution: string;
  };
};

const XSD_BASE_URL =
  "https://dgii.gov.do/cicloContribuyente/facturacion/comprobantesFiscalesElectronicosE-CF/Documentacin%20sobre%20eCF/Documentaci%C3%B3n%20T%C3%A9cnica%20(XSD)";

function schemaDefinition(input: {
  fileName: string;
  officialFileName: string;
  publishedModifiedDate: string;
  sha256: string;
  byteLength: number;
  bom?: boolean;
}): DgiiSchemaDefinition {
  return {
    version: "1.0",
    publishedModifiedDate: input.publishedModifiedDate,
    fileName: input.fileName,
    sha256: input.sha256,
    byteLength: input.byteLength,
    encoding: input.bom === false ? "UTF-8 without BOM" : "UTF-8 with BOM",
    lineEndings: "CRLF",
    source: `${XSD_BASE_URL}/${input.officialFileName}`,
    dependencies: [],
    runtimeCompatibilityPatches: [],
    validator: {
      engine: "libxml2 via xmllint-wasm 5.3.0",
      execution: "isolated Node.js worker staged in the serverless temporary directory",
    },
  };
}

export const ECF_SCHEMAS: Readonly<Record<string, DgiiSchemaDefinition>> = Object.freeze({
  "31": ECF31_SCHEMA,
  "32": schemaDefinition({ fileName: "ecf-32-v1.0.xsd", officialFileName: "e-CF%2032%20v.1.0.xsd", publishedModifiedDate: "2025-10-16", sha256: "151676df03c61335b4ac1eca97f99395488d57ea92793b49353602871e651f3c", byteLength: 122998 }),
  "33": schemaDefinition({ fileName: "ecf-33-v1.0.xsd", officialFileName: "e-CF%2033%20v.1.0.xsd", publishedModifiedDate: "2026-04-01", sha256: "087cd71beba11c19cf548e22b96363cb4aa210dc6f5c3c8a62122a42c88d2866", byteLength: 124484 }),
  "34": schemaDefinition({ fileName: "ecf-34-v1.0.xsd", officialFileName: "e-CF%2034%20v.1.0.xsd", publishedModifiedDate: "2026-04-01", sha256: "6c62ebabdea9a6f6d62ae85d9e1c2eb788f44f3f0b61945fe116700c4eaac2da", byteLength: 122024 }),
  "41": schemaDefinition({ fileName: "ecf-41-v1.0.xsd", officialFileName: "e-CF%2041%20v.1.0.xsd", publishedModifiedDate: "2025-10-16", sha256: "eae1993c637375bc1cbe80932411d87f5680cd54e77e4d1b2752d72a6c8b2ab3", byteLength: 111171 }),
  "43": schemaDefinition({ fileName: "ecf-43-v1.0.xsd", officialFileName: "e-CF%2043%20v.1.0.xsd", publishedModifiedDate: "2025-10-16", sha256: "776f030980c2c50cf0221e9263c55f367c8631727adff00ab45e2c7c1abafc52", byteLength: 96111 }),
  "44": schemaDefinition({ fileName: "ecf-44-v1.0.xsd", officialFileName: "e-CF%2044%20v.1.0.xsd", publishedModifiedDate: "2025-10-16", sha256: "19834f37a9f0e2db40f00c80d07c2bf92f9019f23474480f32cef1ba06af4e67", byteLength: 114302 }),
  "45": schemaDefinition({ fileName: "ecf-45-v1.0.xsd", officialFileName: "e-CF%2045%20v.1.0.xsd", publishedModifiedDate: "2025-10-16", sha256: "030492cc8ef7d1a09a89b16b241f8e5c4920dfd09c0b629b1db8e68406ecd6ca", byteLength: 121785 }),
  "46": schemaDefinition({ fileName: "ecf-46-v1.0.xsd", officialFileName: "e-CF%2046%20v.1.0.xsd", publishedModifiedDate: "2025-10-16", sha256: "e7f8613ade25c7efb88e84d34d7c0ad330d1b22238ad9ef90c80aed01911d67b", byteLength: 115951 }),
  "47": schemaDefinition({ fileName: "ecf-47-v1.0.xsd", officialFileName: "e-CF%2047%20v.1.0.xsd", publishedModifiedDate: "2025-10-16", sha256: "14daf18f52f63dd80e439a18fb60a102d74e71243ee90ee253367f61ce8e1994", byteLength: 101382 }),
});

export const RFCE32_SCHEMA = schemaDefinition({
  fileName: "rfce-32-v1.0.xsd",
  officialFileName: "RFCE%2032%20v.1.0.xsd",
  publishedModifiedDate: "2023-06-20",
  sha256: "6aad535875661b05eef072963295202fc94b3b320b257791feb8d3c39a5f8ee6",
  byteLength: 15325,
  bom: false,
});
RFCE32_SCHEMA.runtimeCompatibilityPatches = [
  "Substitui grupos regex nao capturantes, nao suportados por XML Schema regex, por grupos equivalentes",
  "Corrige a classe de dia [$0-9] para [0-9] e torna explicito o ponto decimal",
];

export const ACECF_SCHEMA = schemaDefinition({
  fileName: "acecf-v1.0.xsd",
  officialFileName: "ACECF%20v.1.0.xsd",
  publishedModifiedDate: "2022-12-21",
  sha256: "072f65de202df8ec136a8d4493e0592172690a4e181047245401cc2e7b23c095",
  byteLength: 3567,
  bom: false,
});
ACECF_SCHEMA.runtimeCompatibilityPatches = [
  "Substitui grupos regex nao capturantes e escapes nao suportados por XML Schema regex",
];

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

const schemaPromises = new Map<string, Promise<string>>();
let validatorPromise: Promise<XmllintModule["validateXML"]> | undefined;

function applyDocumentedCompatibilityPatch(
  schema: string,
  definition: DgiiSchemaDefinition,
): string {
  if (definition.fileName === ECF31_SCHEMA.fileName) {
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
  if (definition.fileName === RFCE32_SCHEMA.fileName) {
    const decimalGroup = "(?:.[0-9]{2})?";
    if (
      schema.split(decimalGroup).length - 1 !== 3 ||
      schema.split("(?:19|20)").length - 1 !== 1 ||
      schema.split("[$0-9]").length - 1 !== 1
    ) {
      throw new XsdRuntimeError({
        code: "schema_checksum_failed",
        component: "xsd",
        message: "O XSD RFCE oficial nao contem os defeitos regex documentados esperados",
      });
    }
    return schema
      .replaceAll(decimalGroup, "([.][0-9]{2})?")
      .replace("(?:19|20)", "(19|20)")
      .replace("[$0-9]", "[0-9]")
      .replaceAll("\\-", "-")
      .replace("\\d{2}", "[0-9]{2}");
  }
  if (definition.fileName === ACECF_SCHEMA.fileName) {
    if (
      schema.split("(?:20|20)").length - 1 !== 1 ||
      schema.split("\\d").length - 1 !== 3 ||
      schema.split("\\.").length - 1 !== 1
    ) {
      throw new XsdRuntimeError({
        code: "schema_checksum_failed",
        component: "xsd",
        message: "O XSD ACECF oficial nao contem os defeitos regex documentados esperados",
      });
    }
    return schema
      .replace("(?:20|20)", "(20|20)")
      .replaceAll("\\-", "-")
      .replaceAll("\\d", "[0-9]")
      .replace("\\.", "[.]");
  }
  return schema;
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

export function loadDgiiSchema(definition: DgiiSchemaDefinition): Promise<string> {
  const cached = schemaPromises.get(definition.fileName);
  if (cached) return cached;
  const promise = (async () => {
    let schemaBytes: Buffer;
    try {
      schemaBytes = await readFile(
        path.join(process.cwd(), "schemas", "dgii", definition.fileName),
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
    if (digest !== definition.sha256 || schemaBytes.byteLength !== definition.byteLength) {
      throw new XsdRuntimeError({
        code: "schema_checksum_failed",
        component: "xsd",
        message: `A integridade dos bytes originais de ${definition.fileName} nao corresponde ao oficial (esperado ${definition.sha256}/${definition.byteLength}, recebido ${digest}/${schemaBytes.byteLength})`,
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
    return applyDocumentedCompatibilityPatch(schema, definition);
  })();
  schemaPromises.set(definition.fileName, promise);
  return promise;
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

export async function validateDgiiXsd(
  xml: string,
  definition: DgiiSchemaDefinition,
  xmlFileName: string,
): Promise<{
  valid: boolean;
  errors: XsdValidationError[];
}> {
  const [schema, validateXML] = await Promise.all([
    loadDgiiSchema(definition),
    loadValidator(),
  ]);
  let result: Awaited<ReturnType<XmllintModule["validateXML"]>>;
  try {
    result = await validateXML({
      xml: [{ fileName: xmlFileName, contents: xml }],
      schema: [{ fileName: definition.fileName, contents: schema }],
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

export function validateEcf31Xsd(xml: string) {
  return validateDgiiXsd(xml, ECF31_SCHEMA, "ecf-31.xml");
}
