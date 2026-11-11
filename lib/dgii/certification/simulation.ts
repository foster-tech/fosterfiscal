import Decimal from "decimal.js";

import { PreparedCertificationSet, prepareCertificationSet } from "./prepare";
import { CertificationSheet, CertificationWorkbook } from "./xlsx";
import { SigningMaterial } from "../xml-signature";

export const SIMULATION_EXPECTED_COUNTS = Object.freeze({
  "31": 4,
  "32": 2,
  "33": 1,
  "34": 2,
  "41": 2,
  "43": 2,
  "44": 2,
  "45": 2,
  "46": 2,
  "47": 2,
} as const);

const OMITTED_VALUE = "#e";
const MAX_CERTIFICATION_SEQUENCE = 10_000_000;

export type SimulationPreparationOptions = {
  sequenceStart: number;
  alcoholSpecificTaxRate: string;
  now?: Date;
};

export type SimulationIdentityMapping = {
  type: string;
  previousEncf: string;
  encf: string;
  caseId: string;
};

export type PreparedSimulationSet = {
  documents: PreparedCertificationSet["directSubmissions"];
  identityMapping: SimulationIdentityMapping[];
  issueDate: string;
  sequenceExpirationDate: string;
};

export type PreparedSimulationCompletionSet = {
  prepared: PreparedCertificationSet;
  identityMapping: SimulationIdentityMapping[];
  issueDate: string;
  sequenceExpirationDate: string;
};

function requiredSheet(workbook: CertificationWorkbook, name: string): CertificationSheet {
  const sheet = workbook.sheets.get(name);
  if (!sheet) throw new Error(`Aba obrigatoria ausente: ${name}`);
  return sheet;
}

function rowKey(row: Record<string, string>, requested: string): string | null {
  return Object.keys(row).find(
    (candidate) => candidate.trim().toLocaleLowerCase("en-US") ===
      requested.toLocaleLowerCase("en-US"),
  ) ?? null;
}

function value(row: Record<string, string>, name: string): string {
  const key = rowKey(row, name);
  return key ? row[key].trim() : "";
}

function set(row: Record<string, string>, name: string, next: string): void {
  const key = rowKey(row, name);
  if (key) row[key] = next;
}

function hasValue(row: Record<string, string>, name: string): boolean {
  const current = value(row, name);
  return current !== "" && current.toLocaleLowerCase("en-US") !== OMITTED_VALUE;
}

function two(value: number): string {
  return String(value).padStart(2, "0");
}

function dominicanDate(now: Date): string {
  const local = new Date(now.getTime() - 4 * 60 * 60 * 1000);
  return `${two(local.getUTCDate())}-${two(local.getUTCMonth() + 1)}-${local.getUTCFullYear()}`;
}

function addUtcDays(now: Date, days: number): Date {
  return new Date(now.getTime() + days * 24 * 60 * 60 * 1000);
}

function expirationDate(now: Date): string {
  const local = new Date(now.getTime() - 4 * 60 * 60 * 1000);
  return `31-12-${local.getUTCFullYear() + 2}`;
}

function encf(type: string, sequence: number): string {
  if (!/^\d{2}$/.test(type)) throw new Error(`Tipo e-CF invalido: ${type}`);
  if (!Number.isSafeInteger(sequence) || sequence < 1 || sequence > MAX_CERTIFICATION_SEQUENCE) {
    throw new Error(`Sequencia fora da faixa de certificacao: ${sequence}`);
  }
  return `E${type}${String(sequence).padStart(10, "0")}`;
}

function updatePresentDateFields(
  row: Record<string, string>,
  issueDate: string,
  dueDate: string,
  sequenceExpirationDate: string,
): void {
  const sameDay = [
    "FechaDesde",
    "FechaHasta",
    "FechaEntrega",
    "FechaOrdenCompra",
    "FechaEmbarque",
  ];
  for (const name of sameDay) {
    if (hasValue(row, name)) set(row, name, issueDate);
  }
  if (hasValue(row, "FechaLimitePago")) set(row, "FechaLimitePago", dueDate);
  if (hasValue(row, "FechaVencimientoSecuencia")) {
    set(row, "FechaVencimientoSecuencia", sequenceExpirationDate);
  }
  for (const key of Object.keys(row)) {
    if (/^FechaElaboracion\[\d+\]$/i.test(key) && hasValue(row, key)) {
      row[key] = issueDate;
    }
    if (/^FechaVencimientoItem\[\d+\]$/i.test(key) && hasValue(row, key)) {
      row[key] = sequenceExpirationDate;
    }
  }
}

function decimalValue(row: Record<string, string>, name: string): Decimal {
  const current = value(row, name);
  if (!current || current.toLocaleLowerCase("en-US") === OMITTED_VALUE) {
    return new Decimal(0);
  }
  return new Decimal(current);
}

function money(amount: Decimal): string {
  return amount.toDecimalPlaces(2, Decimal.ROUND_HALF_UP).toFixed(2);
}

function applyCurrentAlcoholSpecificTax(
  row: Record<string, string>,
  rateValue: string,
): void {
  const taxIndex = [1, 2, 3, 4].find(
    (index) => value(row, `TipoImpuesto[${index}]`) === "006",
  );
  if (!taxIndex) return;
  const rate = new Decimal(rateValue);
  if (!rate.isPositive() || rate.decimalPlaces() > 2) {
    throw new Error(`Taxa ISC especifica invalida: ${rateValue}`);
  }

  let litersAbsoluteAlcohol = new Decimal(0);
  for (let item = 1; item <= 62; item += 1) {
    const usesTax = [1, 2].some(
      (tax) => value(row, `TipoImpuesto[${item}][${tax}]`) === "006",
    );
    if (!usesTax) continue;
    const quantity = decimalValue(row, `CantidadItem[${item}]`);
    const referenceQuantity = decimalValue(row, `CantidadReferencia[${item}]`);
    const subquantity = decimalValue(row, `Subcantidad[${item}][1]`);
    const alcoholPercentage = decimalValue(row, `GradosAlcohol[${item}]`);
    if (
      !quantity.isPositive() ||
      !referenceQuantity.isPositive() ||
      !subquantity.isPositive() ||
      !alcoholPercentage.isPositive()
    ) {
      throw new Error(`Dados insuficientes para recalcular ISC especifico na linha ${item}`);
    }
    litersAbsoluteAlcohol = litersAbsoluteAlcohol.plus(
      quantity.times(referenceQuantity).times(subquantity).times(alcoholPercentage).dividedBy(100),
    );
  }
  if (!litersAbsoluteAlcohol.isPositive()) {
    throw new Error("Nao foi possivel calcular litros de alcool absoluto do e-CF");
  }

  const amountField = `MontoImpuestoSelectivoConsumoEspecifico[${taxIndex}]`;
  const previousSpecificAmount = decimalValue(row, amountField);
  const currentSpecificAmount = litersAbsoluteAlcohol
    .times(rate)
    .toDecimalPlaces(2, Decimal.ROUND_HALF_UP);
  const difference = currentSpecificAmount.minus(previousSpecificAmount);
  set(row, `TasaImpuestoAdicional[${taxIndex}]`, rate.toFixed(2));
  set(row, amountField, currentSpecificAmount.toFixed(2));

  const previousAdditionalTax = decimalValue(row, "MontoImpuestoAdicional");
  const currentAdditionalTax = previousAdditionalTax.plus(difference);
  set(row, "MontoImpuestoAdicional", money(currentAdditionalTax));

  const itbisRate = decimalValue(row, "ITBIS1");
  const previousItbis = decimalValue(row, "TotalITBIS");
  const itbisDifference = difference.times(itbisRate).dividedBy(100)
    .toDecimalPlaces(2, Decimal.ROUND_HALF_UP);
  const currentItbis = previousItbis.plus(itbisDifference);
  set(row, "TotalITBIS", money(currentItbis));
  if (hasValue(row, "TotalITBIS1")) set(row, "TotalITBIS1", money(currentItbis));

  const currentTotal = decimalValue(row, "MontoGravadoTotal")
    .plus(decimalValue(row, "MontoExento"))
    .plus(currentAdditionalTax)
    .plus(currentItbis);
  set(row, "MontoTotal", money(currentTotal));
  if (hasValue(row, "MontoPeriodo")) set(row, "MontoPeriodo", money(currentTotal));
  if (hasValue(row, "ValorPagar")) set(row, "ValorPagar", money(currentTotal));
}

function assertDistribution(rows: Array<Record<string, string>>): void {
  const actual = new Map<string, number>();
  for (const row of rows) {
    const type = value(row, "TipoeCF");
    actual.set(type, (actual.get(type) ?? 0) + 1);
  }
  for (const [type, expected] of Object.entries(SIMULATION_EXPECTED_COUNTS)) {
    if ((actual.get(type) ?? 0) !== expected) {
      throw new Error(
        `Quantidade invalida para e-CF ${type}: ${actual.get(type) ?? 0}; esperado ${expected}`,
      );
    }
  }
  const expectedTotal = Object.values(SIMULATION_EXPECTED_COUNTS)
    .reduce((sum, count) => sum + count, 0);
  if (rows.length !== expectedTotal || actual.size !== Object.keys(SIMULATION_EXPECTED_COUNTS).length) {
    throw new Error(`A simulacao deve conter exatamente ${expectedTotal} e-CF previstos`);
  }
  for (const row of rows.filter((candidate) => value(candidate, "TipoeCF") === "32")) {
    const total = new Decimal(value(row, "MontoTotal"));
    if (total.lessThan(250_000)) {
      throw new Error(`e-CF 32 de simulacao abaixo de DOP 250 mil: ${value(row, "ENCF")}`);
    }
  }
}

export function buildSimulationWorkbook(
  source: CertificationWorkbook,
  options: SimulationPreparationOptions,
): {
  workbook: CertificationWorkbook;
  identityMapping: SimulationIdentityMapping[];
  issueDate: string;
  sequenceExpirationDate: string;
} {
  const ecfSheet = requiredSheet(source, "ECF");
  const rfceSheet = requiredSheet(source, "RFCE");
  const summaryCases = new Set(rfceSheet.rows.map((row) => value(row, "CasoPrueba")));
  const rows = ecfSheet.rows
    .filter((row) => !summaryCases.has(value(row, "CasoPrueba")))
    .map((row) => ({ ...row }));
  assertDistribution(rows);

  const now = options.now ?? new Date();
  const issueDate = dominicanDate(now);
  const dueDate = dominicanDate(addUtcDays(now, 30));
  const sequenceExpirationDate = expirationDate(now);
  const nextByType = new Map<string, number>();
  const newByPrevious = new Map<string, string>();
  const identityMapping: SimulationIdentityMapping[] = [];

  for (const row of rows) {
    const type = value(row, "TipoeCF");
    const previousEncf = value(row, "ENCF");
    const issuerRnc = value(row, "RNCEmisor");
    if (!/^\d{9}$|^\d{11}$/.test(issuerRnc)) {
      throw new Error(`RNC emissor invalido no e-CF ${previousEncf}`);
    }
    const sequence = nextByType.get(type) ?? options.sequenceStart;
    const nextEncf = encf(type, sequence);
    nextByType.set(type, sequence + 1);
    newByPrevious.set(previousEncf, nextEncf);
    set(row, "ENCF", nextEncf);
    set(row, "CasoPrueba", `${issuerRnc}${nextEncf}`);
    set(row, "FechaEmision", issueDate);
    set(row, "FechaHoraFirma", "");
    updatePresentDateFields(row, issueDate, dueDate, sequenceExpirationDate);
    applyCurrentAlcoholSpecificTax(row, options.alcoholSpecificTaxRate);
    identityMapping.push({
      type,
      previousEncf,
      encf: nextEncf,
      caseId: `${issuerRnc}${nextEncf}`,
    });
  }

  for (const row of rows) {
    if (!hasValue(row, "NCFModificado")) continue;
    const previousReference = value(row, "NCFModificado");
    const nextReference = newByPrevious.get(previousReference);
    if (!nextReference) {
      throw new Error(
        `NCFModificado ${previousReference} nao pertence ao conjunto de simulacao`,
      );
    }
    set(row, "NCFModificado", nextReference);
    if (hasValue(row, "FechaNCFModificado")) {
      set(row, "FechaNCFModificado", issueDate);
    }
  }

  const sheets = new Map(source.sheets);
  sheets.set("ECF", { ...ecfSheet, rows });
  sheets.set("RFCE", { ...rfceSheet, rows: [] });
  return { workbook: { sheets }, identityMapping, issueDate, sequenceExpirationDate };
}

export function buildSimulationCompletionWorkbook(
  source: CertificationWorkbook,
  options: SimulationPreparationOptions,
): {
  workbook: CertificationWorkbook;
  identityMapping: SimulationIdentityMapping[];
  issueDate: string;
  sequenceExpirationDate: string;
} {
  const ecfSheet = requiredSheet(source, "ECF");
  const rfceSheet = requiredSheet(source, "RFCE");
  if (rfceSheet.rows.length !== 4) {
    throw new Error(`A conclusao da simulacao exige 4 RFCE; encontrados ${rfceSheet.rows.length}`);
  }

  const now = options.now ?? new Date();
  const issueDate = dominicanDate(now);
  const dueDate = dominicanDate(addUtcDays(now, 30));
  const sequenceExpirationDate = expirationDate(now);
  const nextByType = new Map<string, number>();
  const newByPrevious = new Map<string, string>();
  const caseByPreviousCase = new Map<string, { caseId: string; encf: string }>();
  const identityMapping: SimulationIdentityMapping[] = [];

  const transformedEcfRows = ecfSheet.rows.map((sourceRow) => {
    const row = { ...sourceRow };
    const type = value(row, "TipoeCF");
    const previousCaseId = value(row, "CasoPrueba");
    const previousEncf = value(row, "ENCF");
    const issuerRnc = value(row, "RNCEmisor");
    if (!/^(?:\d{9}|\d{11})$/.test(issuerRnc)) {
      throw new Error(`RNC emissor invalido no e-CF ${previousEncf}`);
    }
    const sequence = nextByType.get(type) ?? options.sequenceStart;
    const nextEncf = encf(type, sequence);
    const caseId = `${issuerRnc}${nextEncf}`;
    nextByType.set(type, sequence + 1);
    newByPrevious.set(previousEncf, nextEncf);
    caseByPreviousCase.set(previousCaseId, { caseId, encf: nextEncf });
    set(row, "ENCF", nextEncf);
    set(row, "CasoPrueba", caseId);
    set(row, "FechaEmision", issueDate);
    set(row, "FechaHoraFirma", "");
    updatePresentDateFields(row, issueDate, dueDate, sequenceExpirationDate);
    applyCurrentAlcoholSpecificTax(row, options.alcoholSpecificTaxRate);
    identityMapping.push({ type, previousEncf, encf: nextEncf, caseId });
    return row;
  });

  for (const row of transformedEcfRows) {
    if (!hasValue(row, "NCFModificado")) continue;
    const previousReference = value(row, "NCFModificado");
    const nextReference = newByPrevious.get(previousReference);
    if (!nextReference) {
      throw new Error(`NCFModificado ${previousReference} nao pertence ao conjunto base`);
    }
    set(row, "NCFModificado", nextReference);
    if (hasValue(row, "FechaNCFModificado")) set(row, "FechaNCFModificado", issueDate);
  }

  const transformedRfceRows = rfceSheet.rows.map((sourceRow) => {
    const row = { ...sourceRow };
    const previousCaseId = value(row, "CasoPrueba");
    const mapped = caseByPreviousCase.get(previousCaseId);
    if (!mapped) throw new Error(`RFCE sem e-CF integral correspondente: ${previousCaseId}`);
    set(row, "CasoPrueba", mapped.caseId);
    set(row, "ENCF", mapped.encf);
    set(row, "FechaEmision", issueDate);
    set(row, "FechaHoraFirma", "");
    return row;
  });

  const requiredDirectTypes = new Set(["31", "32", "41", "43", "44", "45"]);
  const selectedEcfRows = transformedEcfRows.filter((row, index) => {
    const type = value(row, "TipoeCF");
    if (!requiredDirectTypes.has(type)) return false;
    if (type !== "45") return true;
    return value(ecfSheet.rows[index]!, "ENCF") === "E450000000009";
  });
  const counts = new Map<string, number>();
  for (const row of selectedEcfRows) {
    const type = value(row, "TipoeCF");
    counts.set(type, (counts.get(type) ?? 0) + 1);
  }
  const expected = { "31": 4, "32": 6, "41": 2, "43": 2, "44": 2, "45": 1 };
  for (const [type, count] of Object.entries(expected)) {
    if ((counts.get(type) ?? 0) !== count) {
      throw new Error(`Quantidade complementar invalida para e-CF ${type}`);
    }
  }

  const sheets = new Map(source.sheets);
  sheets.set("ECF", { ...ecfSheet, rows: selectedEcfRows });
  sheets.set("RFCE", { ...rfceSheet, rows: transformedRfceRows });
  return { workbook: { sheets }, identityMapping, issueDate, sequenceExpirationDate };
}

export async function prepareSimulationSet(
  source: CertificationWorkbook,
  material: SigningMaterial,
  options: SimulationPreparationOptions,
): Promise<PreparedSimulationSet> {
  const transformed = buildSimulationWorkbook(source, options);
  const prepared = await prepareCertificationSet(transformed.workbook, material);
  if (prepared.summarySubmissions.length || prepared.manualPortalUploads.length) {
    throw new Error("A simulacao nao deve gerar RFCE nem uploads manuais nesta etapa");
  }
  assertDistribution(prepared.directSubmissions.map((document) => ({
    TipoeCF: document.type,
    ENCF: document.encf,
    MontoTotal: document.type === "32" ? "250000" : "0",
  })));
  return {
    documents: prepared.directSubmissions,
    identityMapping: transformed.identityMapping,
    issueDate: transformed.issueDate,
    sequenceExpirationDate: transformed.sequenceExpirationDate,
  };
}

export async function prepareSimulationCompletionSet(
  source: CertificationWorkbook,
  material: SigningMaterial,
  options: SimulationPreparationOptions,
): Promise<PreparedSimulationCompletionSet> {
  const transformed = buildSimulationCompletionWorkbook(source, options);
  const prepared = await prepareCertificationSet(transformed.workbook, material);
  if (
    prepared.directSubmissions.length !== 13 ||
    prepared.summarySubmissions.length !== 4 ||
    prepared.manualPortalUploads.length !== 4
  ) {
    throw new Error(
      `Pacote complementar invalido: ${prepared.directSubmissions.length} diretos, ` +
      `${prepared.summarySubmissions.length} RFCE, ` +
      `${prepared.manualPortalUploads.length} uploads`,
    );
  }
  return {
    prepared,
    identityMapping: transformed.identityMapping,
    issueDate: transformed.issueDate,
    sequenceExpirationDate: transformed.sequenceExpirationDate,
  };
}
