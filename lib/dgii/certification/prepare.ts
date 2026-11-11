import { createHash } from "node:crypto";

import { SigningMaterial, signXmlDocument, verifyXmlSignature } from "../xml-signature";
import {
  DgiiSchemaDefinition,
  ECF_SCHEMAS,
  loadDgiiSchema,
  RFCE32_SCHEMA,
  validateDgiiXsd,
  XsdValidationError,
} from "../ecf/xsd";
import { buildUnsignedXmlFromRow } from "./generator";
import { CertificationSheet, CertificationWorkbook } from "./xlsx";

const DIRECT_ECF_TYPE_ORDER = ["31", "32", "41", "43", "44", "45", "46", "47", "33", "34"] as const;

export type PreparedCertificationDocument = {
  kind: "ECF" | "RFCE";
  phase: "direct_submission" | "summary_submission" | "manual_portal_upload";
  caseId: string;
  type: string;
  encf: string;
  fileName: string;
  sha256: string;
  xml: string;
  schema: DgiiSchemaDefinition;
};

export type PreparedCertificationSet = {
  directSubmissions: PreparedCertificationDocument[];
  summarySubmissions: PreparedCertificationDocument[];
  manualPortalUploads: PreparedCertificationDocument[];
};

export class CertificationPreparationError extends Error {
  constructor(
    message: string,
    public readonly caseId: string | null = null,
    public readonly xsdErrors: XsdValidationError[] = [],
  ) {
    super(message);
    this.name = "CertificationPreparationError";
  }
}

function requiredSheet(workbook: CertificationWorkbook, name: string): CertificationSheet {
  const sheet = workbook.sheets.get(name);
  if (!sheet) throw new CertificationPreparationError(`Aba obrigatoria ausente: ${name}`);
  return sheet;
}

function rowValue(row: Record<string, string>, name: string): string {
  const key = Object.keys(row).find(
    (candidate) => candidate.trim().toLocaleLowerCase("en-US") === name.toLocaleLowerCase("en-US"),
  );
  return key ? row[key].trim() : "";
}

function identity(row: Record<string, string>): { caseId: string; type: string; encf: string } {
  const caseId = rowValue(row, "CasoPrueba");
  const type = rowValue(row, "TipoeCF");
  const encf = rowValue(row, "ENCF");
  if (!/^\d{9,11}E\d{12}$/.test(caseId)) {
    throw new CertificationPreparationError(`CasoPrueba invalido: ${caseId || "ausente"}`, caseId || null);
  }
  if (!/^\d{2}$/.test(type) || !new RegExp(`^E${type}\\d{10}$`).test(encf)) {
    throw new CertificationPreparationError(`Tipo/eNCF invalido no caso ${caseId}`, caseId);
  }
  if (!caseId.endsWith(encf)) {
    throw new CertificationPreparationError(`CasoPrueba nao termina com o eNCF no caso ${caseId}`, caseId);
  }
  return { caseId, type, encf };
}

function dominicanDateTime(now: Date): string {
  const local = new Date(now.getTime() - 4 * 60 * 60 * 1000);
  const two = (value: number) => String(value).padStart(2, "0");
  return `${two(local.getUTCDate())}-${two(local.getUTCMonth() + 1)}-${local.getUTCFullYear()} ${two(local.getUTCHours())}:${two(local.getUTCMinutes())}:${two(local.getUTCSeconds())}`;
}

function securityCode(signedEcf: string, caseId: string): string {
  const value = /<(?:[A-Za-z0-9_.-]+:)?SignatureValue>([^<]+)<\/(?:[A-Za-z0-9_.-]+:)?SignatureValue>/
    .exec(signedEcf)?.[1]
    ?.replace(/\s/g, "")
    .slice(0, 6);
  if (!value || value.length !== 6) {
    throw new CertificationPreparationError(
      `Nao foi possivel calcular CodigoSeguridadeCF de ${caseId}`,
      caseId,
    );
  }
  return value;
}

async function mapWithConcurrency<T, R>(
  values: T[],
  concurrency: number,
  mapper: (value: T, index: number) => Promise<R>,
): Promise<R[]> {
  const results = new Array<R>(values.length);
  let nextIndex = 0;
  const workers = Array.from(
    { length: Math.min(concurrency, values.length) },
    async () => {
      while (nextIndex < values.length) {
        const index = nextIndex;
        nextIndex += 1;
        results[index] = await mapper(values[index], index);
      }
    },
  );
  await Promise.all(workers);
  return results;
}

async function prepareDocument(input: {
  sheet: CertificationSheet;
  row: Record<string, string>;
  root: "ECF" | "RFCE";
  phase: PreparedCertificationDocument["phase"];
  schema: DgiiSchemaDefinition;
  material: SigningMaterial;
}): Promise<PreparedCertificationDocument> {
  const { caseId, type, encf } = identity(input.row);
  let unsigned: string;
  try {
    const schemaText = await loadDgiiSchema(input.schema);
    unsigned = buildUnsignedXmlFromRow({
      schema: schemaText,
      root: input.root,
      headers: input.sheet.headers,
      row: {
        ...input.row,
        FechaHoraFirma: rowValue(input.row, "FechaHoraFirma") || dominicanDateTime(new Date()),
      },
    });
  } catch (error: unknown) {
    throw new CertificationPreparationError(
      `Falha ao gerar ${caseId}: ${error instanceof Error ? error.message : "erro desconhecido"}`,
      caseId,
    );
  }
  const signed = signXmlDocument(unsigned, input.material, input.root);
  verifyXmlSignature(signed, input.material, input.root);
  const validation = await validateDgiiXsd(signed, input.schema, `${caseId}.xml`);
  if (!validation.valid) {
    throw new CertificationPreparationError(
      `O XML ${caseId} nao atende ao XSD oficial`,
      caseId,
      validation.errors,
    );
  }
  return {
    kind: input.root,
    phase: input.phase,
    caseId,
    type,
    encf,
    fileName: `${caseId}.xml`,
    sha256: createHash("sha256").update(signed).digest("hex"),
    xml: signed,
    schema: input.schema,
  };
}

export async function prepareCertificationSet(
  workbook: CertificationWorkbook,
  material: SigningMaterial,
): Promise<PreparedCertificationSet> {
  const ecfSheet = requiredSheet(workbook, "ECF");
  const rfceSheet = requiredSheet(workbook, "RFCE");
  const rfceOrder = rfceSheet.rows.map((row) => identity(row).caseId);
  const summaryCaseIds = new Set(rfceOrder);
  const ecfByCase = new Map(ecfSheet.rows.map((row) => [identity(row).caseId, row]));
  if (ecfByCase.size !== ecfSheet.rows.length) {
    throw new CertificationPreparationError("Existem CasoPrueba duplicados na aba ECF");
  }
  for (const caseId of summaryCaseIds) {
    if (!ecfByCase.has(caseId)) {
      throw new CertificationPreparationError(`RFCE sem e-CF integral correspondente: ${caseId}`, caseId);
    }
  }

  const directRows = ecfSheet.rows
    .filter((row) => !summaryCaseIds.has(identity(row).caseId))
    .sort((left, right) => {
      const leftType = identity(left).type;
      const rightType = identity(right).type;
      const typeDifference = DIRECT_ECF_TYPE_ORDER.indexOf(leftType as never) -
        DIRECT_ECF_TYPE_ORDER.indexOf(rightType as never);
      return typeDifference || ecfSheet.rows.indexOf(left) - ecfSheet.rows.indexOf(right);
    });
  if (directRows.some((row) => DIRECT_ECF_TYPE_ORDER.indexOf(identity(row).type as never) < 0)) {
    throw new CertificationPreparationError("A planilha contem tipo e-CF nao previsto na certificacao");
  }

  const directSubmissions = await mapWithConcurrency(directRows, 2, async (row) => {
    const type = identity(row).type;
    const schema = ECF_SCHEMAS[type];
    if (!schema) throw new CertificationPreparationError(`XSD ausente para e-CF ${type}`);
    return prepareDocument({
      sheet: ecfSheet,
      row,
      root: "ECF",
      phase: "direct_submission",
      schema,
      material,
    });
  });

  const manualPortalUploads = await mapWithConcurrency(rfceOrder, 2, async (caseId) => {
    const row = ecfByCase.get(caseId);
    if (!row) throw new CertificationPreparationError(`e-CF integral ausente: ${caseId}`, caseId);
    return prepareDocument({
      sheet: ecfSheet,
      row,
      root: "ECF",
      phase: "manual_portal_upload",
      schema: ECF_SCHEMAS["32"],
      material,
    });
  });

  const manualByCase = new Map(
    manualPortalUploads.map((document) => [document.caseId, document]),
  );
  const summarySubmissions = await mapWithConcurrency(rfceSheet.rows, 2, async (row) => {
    const caseId = identity(row).caseId;
    const fullEcf = manualByCase.get(caseId);
    if (!fullEcf) throw new CertificationPreparationError(`e-CF integral ausente: ${caseId}`, caseId);
    return prepareDocument({
      sheet: rfceSheet,
      row: {
        ...row,
        CodigoSeguridadeCF: securityCode(fullEcf.xml, caseId),
      },
      root: "RFCE",
      phase: "summary_submission",
      schema: RFCE32_SCHEMA,
      material,
    });
  });

  return { directSubmissions, summarySubmissions, manualPortalUploads };
}
