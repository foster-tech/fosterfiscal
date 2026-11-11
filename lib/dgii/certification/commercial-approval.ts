import { createHash } from "node:crypto";

import Decimal from "decimal.js";

import { ACECF_SCHEMA, validateDgiiXsd } from "../ecf/xsd";
import {
  SigningMaterial,
  signXmlDocument,
  verifyXmlSignature,
} from "../xml-signature";
import { CertificationWorkbook } from "./xlsx";

const SHEET_NAME = "ACEECF_Generadas";
const REQUIRED_HEADERS = [
  "Version",
  "RNCEmisor",
  "eNCF",
  "FechaEmision",
  "MontoTotal",
  "RNCComprador",
  "Estado",
  "DetalleMotivoRechazo",
  "FechaHoraAprobacionComercial",
] as const;

export type PreparedCommercialApproval = {
  order: number;
  caseId: string;
  issuerRnc: string;
  buyerRnc: string;
  encf: string;
  fileName: string;
  xml: string;
  sha256: string;
  schema: typeof ACECF_SCHEMA;
};

export class CommercialApprovalPreparationError extends Error {
  constructor(
    message: string,
    public readonly caseId: string | null = null,
    public readonly xsdErrors: string[] = [],
  ) {
    super(message);
    this.name = "CommercialApprovalPreparationError";
  }
}

function escapeXml(value: string): string {
  return value
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;")
    .replaceAll('"', "&quot;")
    .replaceAll("'", "&apos;");
}

function required(row: Record<string, string>, name: string, caseId: string): string {
  const value = row[name]?.trim() ?? "";
  if (!value) throw new CommercialApprovalPreparationError(`Campo ${name} ausente`, caseId);
  return value;
}

function money(value: string, caseId: string): string {
  let amount: Decimal;
  try {
    amount = new Decimal(value);
  } catch {
    throw new CommercialApprovalPreparationError("MontoTotal invalido", caseId);
  }
  if (amount.isNegative() || amount.decimalPlaces() > 2) {
    throw new CommercialApprovalPreparationError("MontoTotal fora do formato permitido", caseId);
  }
  return amount.toFixed(2);
}

function xmlForRow(row: Record<string, string>): {
  xml: string;
  caseId: string;
  issuerRnc: string;
  buyerRnc: string;
  encf: string;
} {
  const issuerRnc = required(row, "RNCEmisor", "linha sem RNCEmisor");
  const encf = required(row, "eNCF", issuerRnc);
  const caseId = `${issuerRnc}${encf}`;
  const buyerRnc = required(row, "RNCComprador", caseId);
  const version = required(row, "Version", caseId);
  const issueDate = required(row, "FechaEmision", caseId);
  const status = required(row, "Estado", caseId);
  const approvedAt = required(row, "FechaHoraAprobacionComercial", caseId);
  const rejectionReason = row.DetalleMotivoRechazo?.trim() ?? "";

  if (version !== "1.0") throw new CommercialApprovalPreparationError("Version deve ser 1.0", caseId);
  if (!/^(?:\d{9}|\d{11})$/.test(issuerRnc) || !/^(?:\d{9}|\d{11})$/.test(buyerRnc)) {
    throw new CommercialApprovalPreparationError("RNC invalido", caseId);
  }
  if (!/^[A-Za-z0-9]{9,13}$/.test(encf)) {
    throw new CommercialApprovalPreparationError("eNCF invalido", caseId);
  }
  if (!/^\d{2}-\d{2}-\d{4}$/.test(issueDate)) {
    throw new CommercialApprovalPreparationError("FechaEmision invalida", caseId);
  }
  if (!/^\d{2}-\d{2}-\d{4} \d{2}:\d{2}:\d{2}$/.test(approvedAt)) {
    throw new CommercialApprovalPreparationError(
      "FechaHoraAprobacionComercial invalida",
      caseId,
    );
  }
  if (status !== "1" && status !== "2") {
    throw new CommercialApprovalPreparationError("Estado deve ser 1 ou 2", caseId);
  }
  if (status === "1" && rejectionReason) {
    throw new CommercialApprovalPreparationError(
      "DetalheMotivoRechazo deve ser omitido para Estado 1",
      caseId,
    );
  }
  if (status === "2" && !rejectionReason) {
    throw new CommercialApprovalPreparationError(
      "DetalheMotivoRechazo e obrigatorio para Estado 2",
      caseId,
    );
  }
  if (rejectionReason.length > 250) {
    throw new CommercialApprovalPreparationError(
      "DetalheMotivoRechazo excede 250 caracteres",
      caseId,
    );
  }

  const fields = [
    ["Version", version],
    ["RNCEmisor", issuerRnc],
    ["eNCF", encf],
    ["FechaEmision", issueDate],
    ["MontoTotal", money(required(row, "MontoTotal", caseId), caseId)],
    ["RNCComprador", buyerRnc],
    ["Estado", status],
    ...(rejectionReason ? [["DetalleMotivoRechazo", rejectionReason]] : []),
    ["FechaHoraAprobacionComercial", approvedAt],
  ];
  const detail = fields
    .map(([name, value]) => `<${name}>${escapeXml(value)}</${name}>`)
    .join("");
  return {
    xml:
      `<?xml version="1.0" encoding="utf-8"?>` +
      `<ACECF><DetalleAprobacionComercial>${detail}</DetalleAprobacionComercial></ACECF>`,
    caseId,
    issuerRnc,
    buyerRnc,
    encf,
  };
}

export async function prepareCommercialApprovals(
  workbook: CertificationWorkbook,
  material: SigningMaterial,
): Promise<PreparedCommercialApproval[]> {
  const sheet = workbook.sheets.get(SHEET_NAME);
  if (!sheet) throw new CommercialApprovalPreparationError(`Aba ${SHEET_NAME} ausente`);
  for (const header of REQUIRED_HEADERS) {
    if (!sheet.headers.includes(header)) {
      throw new CommercialApprovalPreparationError(`Cabecalho ${header} ausente`);
    }
  }
  if (sheet.rows.length !== 11) {
    throw new CommercialApprovalPreparationError(
      `Esperadas 11 aprovacoes comerciais; recebidas ${sheet.rows.length}`,
    );
  }

  const prepared: PreparedCommercialApproval[] = [];
  const seen = new Set<string>();
  for (const [index, row] of sheet.rows.entries()) {
    const document = xmlForRow(row);
    if (seen.has(document.caseId)) {
      throw new CommercialApprovalPreparationError("Aprovacao duplicada", document.caseId);
    }
    seen.add(document.caseId);
    const signedXml = signXmlDocument(document.xml, material, "ACECF");
    verifyXmlSignature(signedXml, material, "ACECF");
    const validation = await validateDgiiXsd(
      signedXml,
      ACECF_SCHEMA,
      `${document.buyerRnc}${document.encf}.xml`,
    );
    if (!validation.valid) {
      throw new CommercialApprovalPreparationError(
        "ACECF nao passou no XSD oficial",
        document.caseId,
        validation.errors.map((error) => error.message),
      );
    }
    prepared.push({
      order: index + 1,
      caseId: document.caseId,
      issuerRnc: document.issuerRnc,
      buyerRnc: document.buyerRnc,
      encf: document.encf,
      fileName: `${document.buyerRnc}${document.encf}.xml`,
      xml: signedXml,
      sha256: createHash("sha256").update(signedXml, "utf8").digest("hex"),
      schema: ACECF_SCHEMA,
    });
  }
  return prepared;
}
