import Decimal from "decimal.js";

import {
  CertificateConfigurationError,
  loadSigningMaterial,
  signXmlDocument,
  verifyXmlSignature,
} from "../xml-signature";
import { ECF31_SCHEMA, validateEcf31Xsd, XsdValidationError } from "./xsd";

const Money = Decimal.clone({ precision: 40, rounding: Decimal.ROUND_HALF_UP });

export type ValidationIssue = {
  path: string;
  code: string;
  message: string;
};

type BillingIndicator = 1 | 2 | 3 | 4;

export type Ecf31Input = {
  document: {
    eNCF: string;
    sequenceExpirationDate: string;
    incomeType: "01" | "02" | "03" | "04" | "05" | "06";
    paymentType: 1 | 2;
    paymentDueDate?: string;
    amountsIncludeTax: boolean;
  };
  issuer: {
    rnc: string;
    legalName: string;
    address: string;
    issueDate: string;
  };
  buyer: {
    rnc: string;
    legalName: string;
  };
  items: Array<{
    name: string;
    description?: string;
    kind: 1 | 2;
    billingIndicator: BillingIndicator;
    quantity: string;
    unitPrice: string;
  }>;
  totals: {
    taxableAmount: string;
    exemptAmount: string;
    itbis: string;
    total: string;
  };
  signatureDateTime?: string;
};

export type CalculatedTotals = {
  taxableAmount: string;
  taxableI1: string;
  taxableI2: string;
  taxableI3: string;
  exemptAmount: string;
  itbis: string;
  itbisI1: string;
  itbisI2: string;
  itbisI3: string;
  total: string;
  lines: Array<{ amount: string }>;
};

export type PrepareStage =
  | "validate_input"
  | "calculate_totals"
  | "generate_xml"
  | "load_certificate"
  | "sign_xml"
  | "validate_xsd"
  | "verify_signature"
  | "completed";

export type PrepareStep = {
  stage: Exclude<PrepareStage, "completed">;
  success: boolean;
  durationMs: number;
};

export class EcfPreparationError extends Error {
  constructor(
    public readonly stage: Exclude<PrepareStage, "completed">,
    public readonly category:
      | "input_validation"
      | "totals_inconsistent"
      | "certificate_configuration"
      | "signature_failure"
      | "xsd_validation"
      | "internal",
    message: string,
    public readonly steps: PrepareStep[],
    public readonly issues: ValidationIssue[] = [],
    public readonly xsdErrors: XsdValidationError[] = [],
  ) {
    super(message);
    this.name = "EcfPreparationError";
  }
}

function elapsed(startedAt: number): number {
  return Math.max(0, Math.round(performance.now() - startedAt));
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return Boolean(value) && typeof value === "object" && !Array.isArray(value);
}

function requiredString(
  source: Record<string, unknown>,
  key: string,
  path: string,
  issues: ValidationIssue[],
  maxLength: number,
): string {
  const value = source[key];
  if (typeof value !== "string" || !value.trim()) {
    issues.push({ path, code: "required", message: "Campo obrigatorio" });
    return "";
  }
  if (value.length > maxLength) {
    issues.push({
      path,
      code: "max_length",
      message: `Deve possuir no maximo ${maxLength} caracteres`,
    });
  }
  return value.trim();
}

function optionalString(
  source: Record<string, unknown>,
  key: string,
  path: string,
  issues: ValidationIssue[],
  maxLength: number,
): string | undefined {
  if (source[key] === undefined) return undefined;
  return requiredString(source, key, path, issues, maxLength);
}

function recordAt(
  source: Record<string, unknown>,
  key: string,
  path: string,
  issues: ValidationIssue[],
): Record<string, unknown> {
  const value = source[key];
  if (!isRecord(value)) {
    issues.push({ path, code: "required_object", message: "Objeto obrigatorio" });
    return {};
  }
  return value;
}

function validateDate(value: string, path: string, issues: ValidationIssue[]): void {
  const match = /^(\d{2})-(\d{2})-(\d{4})$/.exec(value);
  if (!match) {
    issues.push({ path, code: "date_format", message: "Use o formato dd-MM-AAAA" });
    return;
  }
  const [, day, month, year] = match;
  const date = new Date(Date.UTC(Number(year), Number(month) - 1, Number(day)));
  if (
    date.getUTCFullYear() !== Number(year) ||
    date.getUTCMonth() !== Number(month) - 1 ||
    date.getUTCDate() !== Number(day)
  ) {
    issues.push({ path, code: "invalid_date", message: "Data invalida" });
  }
}

function dateValue(value: string): number {
  const [day, month, year] = value.split("-").map(Number);
  return Date.UTC(year, month - 1, day);
}

function validateDecimal(
  value: string,
  path: string,
  issues: ValidationIssue[],
  fractionDigits: number,
  strictlyPositive: boolean,
): void {
  const pattern = new RegExp(`^\\d{1,16}(?:\\.\\d{1,${fractionDigits}})?$`);
  if (!pattern.test(value)) {
    issues.push({
      path,
      code: "decimal_format",
      message: `Use um decimal positivo com ate ${fractionDigits} casas, sem separador de milhar`,
    });
    return;
  }
  const decimal = new Money(value);
  if (strictlyPositive ? !decimal.gt(0) : decimal.lt(0)) {
    issues.push({
      path,
      code: "decimal_range",
      message: strictlyPositive ? "O valor deve ser maior que zero" : "O valor nao pode ser negativo",
    });
  }
}

function dominicanDateTime(now: Date): string {
  const local = new Date(now.getTime() - 4 * 60 * 60 * 1000);
  const two = (value: number) => String(value).padStart(2, "0");
  return `${two(local.getUTCDate())}-${two(local.getUTCMonth() + 1)}-${local.getUTCFullYear()} ${two(local.getUTCHours())}:${two(local.getUTCMinutes())}:${two(local.getUTCSeconds())}`;
}

function validateSignatureDateTime(
  value: string,
  issues: ValidationIssue[],
): void {
  if (!/^\d{2}-\d{2}-\d{4} \d{2}:\d{2}:\d{2}$/.test(value)) {
    issues.push({
      path: "signatureDateTime",
      code: "datetime_format",
      message: "Use o formato dd-MM-AAAA HH:mm:ss em GMT-4",
    });
    return;
  }
  validateDate(value.slice(0, 10), "signatureDateTime", issues);
  const [, hours, minutes, seconds] = / (\d{2}):(\d{2}):(\d{2})$/.exec(value) ?? [];
  if (Number(hours) > 23 || Number(minutes) > 59 || Number(seconds) > 59) {
    issues.push({ path: "signatureDateTime", code: "invalid_time", message: "Hora invalida" });
  }
}

export function parseEcf31Input(raw: unknown, now = new Date()): {
  value?: Ecf31Input;
  issues: ValidationIssue[];
} {
  const issues: ValidationIssue[] = [];
  if (!isRecord(raw)) {
    return {
      issues: [{ path: "$", code: "required_object", message: "O corpo deve ser um objeto JSON" }],
    };
  }

  const document = recordAt(raw, "document", "document", issues);
  const issuer = recordAt(raw, "issuer", "issuer", issues);
  const buyer = recordAt(raw, "buyer", "buyer", issues);
  const totals = recordAt(raw, "totals", "totals", issues);

  const eNCF = requiredString(document, "eNCF", "document.eNCF", issues, 13);
  if (eNCF && !/^E31\d{10}$/.test(eNCF)) {
    issues.push({
      path: "document.eNCF",
      code: "ecf31_format",
      message: "Para tipo 31, informe E31 seguido de 10 digitos autorizados para teste",
    });
  }
  const sequenceExpirationDate = requiredString(
    document,
    "sequenceExpirationDate",
    "document.sequenceExpirationDate",
    issues,
    10,
  );
  if (sequenceExpirationDate) {
    validateDate(sequenceExpirationDate, "document.sequenceExpirationDate", issues);
  }

  const incomeType = document.incomeType;
  if (!["01", "02", "03", "04", "05", "06"].includes(String(incomeType))) {
    issues.push({
      path: "document.incomeType",
      code: "enum",
      message: "Use um codigo oficial entre 01 e 06",
    });
  }
  const paymentType = document.paymentType;
  if (paymentType !== 1 && paymentType !== 2) {
    issues.push({
      path: "document.paymentType",
      code: "unsupported",
      message: "Esta fase suporta 1 (contado) ou 2 (credito)",
    });
  }
  const paymentDueDate = optionalString(
    document,
    "paymentDueDate",
    "document.paymentDueDate",
    issues,
    10,
  );
  if (paymentDueDate) validateDate(paymentDueDate, "document.paymentDueDate", issues);
  if (paymentType === 2 && !paymentDueDate) {
    issues.push({
      path: "document.paymentDueDate",
      code: "required_for_credit",
      message: "Obrigatorio quando paymentType for 2",
    });
  }
  if (typeof document.amountsIncludeTax !== "boolean") {
    issues.push({
      path: "document.amountsIncludeTax",
      code: "required_boolean",
      message: "Informe true ou false explicitamente",
    });
  }

  const issuerRnc = requiredString(issuer, "rnc", "issuer.rnc", issues, 11);
  const buyerRnc = requiredString(buyer, "rnc", "buyer.rnc", issues, 11);
  const issuerLegalName = requiredString(
    issuer,
    "legalName",
    "issuer.legalName",
    issues,
    150,
  );
  const issuerAddress = requiredString(
    issuer,
    "address",
    "issuer.address",
    issues,
    100,
  );
  const buyerLegalName = requiredString(
    buyer,
    "legalName",
    "buyer.legalName",
    issues,
    150,
  );
  for (const [path, rnc] of [["issuer.rnc", issuerRnc], ["buyer.rnc", buyerRnc]] as const) {
    if (rnc && !/^(\d{9}|\d{11})$/.test(rnc)) {
      issues.push({ path, code: "rnc_format", message: "O RNC deve conter 9 ou 11 digitos" });
    }
  }

  const issueDate = requiredString(issuer, "issueDate", "issuer.issueDate", issues, 10);
  if (issueDate) validateDate(issueDate, "issuer.issueDate", issues);
  if (
    issueDate &&
    sequenceExpirationDate &&
    /^\d{2}-\d{2}-\d{4}$/.test(issueDate) &&
    /^\d{2}-\d{2}-\d{4}$/.test(sequenceExpirationDate) &&
    dateValue(sequenceExpirationDate) < dateValue(issueDate)
  ) {
    issues.push({
      path: "document.sequenceExpirationDate",
      code: "date_order",
      message: "Nao pode ser anterior a data de emissao",
    });
  }

  const rawItems = raw.items;
  if (!Array.isArray(rawItems) || rawItems.length === 0 || rawItems.length > 1000) {
    issues.push({
      path: "items",
      code: "item_count",
      message: "Informe de 1 a 1000 itens",
    });
  }
  const items = (Array.isArray(rawItems) ? rawItems : []).map((rawItem, index) => {
    const path = `items[${index}]`;
    if (!isRecord(rawItem)) {
      issues.push({ path, code: "required_object", message: "Item deve ser um objeto" });
      return { name: "", kind: 1 as const, billingIndicator: 4 as const, quantity: "", unitPrice: "" };
    }
    const name = requiredString(rawItem, "name", `${path}.name`, issues, 80);
    const description = optionalString(rawItem, "description", `${path}.description`, issues, 1000);
    const kind = rawItem.kind;
    if (kind !== 1 && kind !== 2) {
      issues.push({ path: `${path}.kind`, code: "enum", message: "Use 1 (bem) ou 2 (servico)" });
    }
    const billingIndicator = rawItem.billingIndicator;
    if (![1, 2, 3, 4].includes(Number(billingIndicator))) {
      issues.push({
        path: `${path}.billingIndicator`,
        code: "enum",
        message: "Use 1 (18%), 2 (16%), 3 (0%) ou 4 (exento)",
      });
    }
    const quantity = requiredString(rawItem, "quantity", `${path}.quantity`, issues, 19);
    const unitPrice = requiredString(rawItem, "unitPrice", `${path}.unitPrice`, issues, 21);
    if (quantity) validateDecimal(quantity, `${path}.quantity`, issues, 2, true);
    if (unitPrice) validateDecimal(unitPrice, `${path}.unitPrice`, issues, 4, false);
    return {
      name,
      description,
      kind: kind as 1 | 2,
      billingIndicator: billingIndicator as BillingIndicator,
      quantity,
      unitPrice,
    };
  });

  const parsedTotals = {
    taxableAmount: requiredString(totals, "taxableAmount", "totals.taxableAmount", issues, 19),
    exemptAmount: requiredString(totals, "exemptAmount", "totals.exemptAmount", issues, 19),
    itbis: requiredString(totals, "itbis", "totals.itbis", issues, 19),
    total: requiredString(totals, "total", "totals.total", issues, 19),
  };
  for (const [key, value] of Object.entries(parsedTotals)) {
    if (value) validateDecimal(value, `totals.${key}`, issues, 2, false);
  }

  const signatureDateTime =
    raw.signatureDateTime === undefined
      ? dominicanDateTime(now)
      : typeof raw.signatureDateTime === "string"
        ? raw.signatureDateTime
        : "";
  validateSignatureDateTime(signatureDateTime, issues);

  if (issues.length > 0) return { issues };
  return {
    issues,
    value: {
      document: {
        eNCF,
        sequenceExpirationDate,
        incomeType: incomeType as Ecf31Input["document"]["incomeType"],
        paymentType: paymentType as 1 | 2,
        paymentDueDate,
        amountsIncludeTax: document.amountsIncludeTax as boolean,
      },
      issuer: {
        rnc: issuerRnc,
        legalName: issuerLegalName,
        address: issuerAddress,
        issueDate,
      },
      buyer: {
        rnc: buyerRnc,
        legalName: buyerLegalName,
      },
      items,
      totals: parsedTotals,
      signatureDateTime,
    },
  };
}

function money(value: Decimal): string {
  return value.toDecimalPlaces(2).toFixed(2);
}

export function calculateEcf31Totals(input: Ecf31Input): CalculatedTotals {
  const bucketGross: Record<BillingIndicator, Decimal> = {
    1: new Money(0),
    2: new Money(0),
    3: new Money(0),
    4: new Money(0),
  };
  const lines = input.items.map((item) => {
    const amount = new Money(item.quantity)
      .mul(item.unitPrice)
      .toDecimalPlaces(2);
    bucketGross[item.billingIndicator] = bucketGross[item.billingIndicator].add(amount);
    return { amount: money(amount) };
  });

  const rate: Record<1 | 2 | 3, Decimal> = {
    1: new Money("0.18"),
    2: new Money("0.16"),
    3: new Money(0),
  };
  const bases = {} as Record<1 | 2 | 3, Decimal>;
  const taxes = {} as Record<1 | 2 | 3, Decimal>;
  for (const indicator of [1, 2, 3] as const) {
    const gross = bucketGross[indicator];
    const base = input.document.amountsIncludeTax
      ? gross.div(new Money(1).add(rate[indicator])).toDecimalPlaces(2)
      : gross;
    bases[indicator] = base;
    taxes[indicator] = input.document.amountsIncludeTax
      ? gross.sub(base)
      : base.mul(rate[indicator]).toDecimalPlaces(2);
  }

  const taxable = bases[1].add(bases[2]).add(bases[3]);
  const itbis = taxes[1].add(taxes[2]).add(taxes[3]);
  const exempt = bucketGross[4];
  return {
    taxableAmount: money(taxable),
    taxableI1: money(bases[1]),
    taxableI2: money(bases[2]),
    taxableI3: money(bases[3]),
    exemptAmount: money(exempt),
    itbis: money(itbis),
    itbisI1: money(taxes[1]),
    itbisI2: money(taxes[2]),
    itbisI3: money(taxes[3]),
    total: money(taxable.add(exempt).add(itbis)),
    lines,
  };
}

export function compareDeclaredTotals(
  input: Ecf31Input,
  calculated: CalculatedTotals,
): ValidationIssue[] {
  const issues: ValidationIssue[] = [];
  for (const key of ["taxableAmount", "exemptAmount", "itbis", "total"] as const) {
    if (!new Money(input.totals[key]).eq(calculated[key])) {
      issues.push({
        path: `totals.${key}`,
        code: "total_mismatch",
        message: `Valor declarado nao corresponde ao calculado (${calculated[key]})`,
      });
    }
  }
  return issues;
}

function escapeXml(value: string): string {
  return value
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&apos;");
}

function tag(name: string, value: string | number): string {
  return `<${name}>${escapeXml(String(value))}</${name}>`;
}

function positive(value: string): boolean {
  return new Money(value).gt(0);
}

export function buildUnsignedEcf31Xml(
  input: Ecf31Input,
  totals: CalculatedTotals,
): string {
  const buckets = input.items.reduce(
    (found, item) => found.add(item.billingIndicator),
    new Set<BillingIndicator>(),
  );
  const totalTags = [
    positive(totals.taxableAmount) && tag("MontoGravadoTotal", totals.taxableAmount),
    buckets.has(1) && tag("MontoGravadoI1", totals.taxableI1),
    buckets.has(2) && tag("MontoGravadoI2", totals.taxableI2),
    buckets.has(3) && tag("MontoGravadoI3", totals.taxableI3),
    positive(totals.exemptAmount) && tag("MontoExento", totals.exemptAmount),
    buckets.has(1) && tag("ITBIS1", 18),
    buckets.has(2) && tag("ITBIS2", 16),
    buckets.has(3) && tag("ITBIS3", 0),
    (buckets.has(1) || buckets.has(2) || buckets.has(3)) && tag("TotalITBIS", totals.itbis),
    buckets.has(1) && tag("TotalITBIS1", totals.itbisI1),
    buckets.has(2) && tag("TotalITBIS2", totals.itbisI2),
    buckets.has(3) && tag("TotalITBIS3", totals.itbisI3),
    tag("MontoTotal", totals.total),
  ].filter(Boolean).join("");

  const itemTags = input.items.map((item, index) => [
    "<Item>",
    tag("NumeroLinea", index + 1),
    tag("IndicadorFacturacion", item.billingIndicator),
    tag("NombreItem", item.name),
    tag("IndicadorBienoServicio", item.kind),
    item.description ? tag("DescripcionItem", item.description) : "",
    tag("CantidadItem", new Money(item.quantity).toFixed()),
    tag("PrecioUnitarioItem", new Money(item.unitPrice).toFixed()),
    tag("MontoItem", totals.lines[index].amount),
    "</Item>",
  ].join("")).join("");

  return [
    '<?xml version="1.0" encoding="utf-8"?>',
    "<ECF><Encabezado>",
    tag("Version", "1.0"),
    "<IdDoc>",
    tag("TipoeCF", 31),
    tag("eNCF", input.document.eNCF),
    tag("FechaVencimientoSecuencia", input.document.sequenceExpirationDate),
    tag("IndicadorMontoGravado", input.document.amountsIncludeTax ? 1 : 0),
    tag("TipoIngresos", input.document.incomeType),
    tag("TipoPago", input.document.paymentType),
    input.document.paymentDueDate ? tag("FechaLimitePago", input.document.paymentDueDate) : "",
    "</IdDoc><Emisor>",
    tag("RNCEmisor", input.issuer.rnc),
    tag("RazonSocialEmisor", input.issuer.legalName),
    tag("DireccionEmisor", input.issuer.address),
    tag("FechaEmision", input.issuer.issueDate),
    "</Emisor><Comprador>",
    tag("RNCComprador", input.buyer.rnc),
    tag("RazonSocialComprador", input.buyer.legalName),
    "</Comprador><Totales>",
    totalTags,
    "</Totales></Encabezado><DetallesItems>",
    itemTags,
    "</DetallesItems>",
    tag("FechaHoraFirma", input.signatureDateTime ?? ""),
    "</ECF>",
  ].join("");
}

export async function prepareEcf31(raw: unknown, config: {
  p12Base64: string;
  certificatePassword: string;
  now?: Date;
}): Promise<{
  xml: string;
  totals: CalculatedTotals;
  steps: PrepareStep[];
  schema: typeof ECF31_SCHEMA;
}> {
  const steps: PrepareStep[] = [];
  let started = performance.now();
  const parsed = parseEcf31Input(raw, config.now);
  steps.push({ stage: "validate_input", success: parsed.issues.length === 0, durationMs: elapsed(started) });
  if (!parsed.value) {
    throw new EcfPreparationError(
      "validate_input",
      "input_validation",
      "Os dados da e-CF nao passaram na validacao",
      steps,
      parsed.issues,
    );
  }
  const input = parsed.value;

  started = performance.now();
  const totals = calculateEcf31Totals(input);
  const totalIssues = compareDeclaredTotals(input, totals);
  steps.push({ stage: "calculate_totals", success: totalIssues.length === 0, durationMs: elapsed(started) });
  if (totalIssues.length > 0) {
    throw new EcfPreparationError(
      "calculate_totals",
      "totals_inconsistent",
      "Os totais declarados nao correspondem aos valores calculados",
      steps,
      totalIssues,
    );
  }

  started = performance.now();
  const unsignedXml = buildUnsignedEcf31Xml(input, totals);
  steps.push({ stage: "generate_xml", success: true, durationMs: elapsed(started) });

  started = performance.now();
  let material: Awaited<ReturnType<typeof loadSigningMaterial>>;
  try {
    material = await loadSigningMaterial(config.p12Base64, config.certificatePassword);
    steps.push({ stage: "load_certificate", success: true, durationMs: elapsed(started) });
  } catch (error: unknown) {
    steps.push({ stage: "load_certificate", success: false, durationMs: elapsed(started) });
    throw new EcfPreparationError(
      "load_certificate",
      "certificate_configuration",
      error instanceof CertificateConfigurationError
        ? error.message
        : "Nao foi possivel carregar o certificado digital",
      steps,
    );
  }

  started = performance.now();
  let signedXml: string;
  try {
    signedXml = signXmlDocument(unsignedXml, material, "ECF");
    steps.push({ stage: "sign_xml", success: true, durationMs: elapsed(started) });
  } catch {
    steps.push({ stage: "sign_xml", success: false, durationMs: elapsed(started) });
    throw new EcfPreparationError(
      "sign_xml",
      "signature_failure",
      "Nao foi possivel gerar uma assinatura e-CF valida",
      steps,
    );
  }

  started = performance.now();
  let xsdResult: Awaited<ReturnType<typeof validateEcf31Xsd>>;
  try {
    xsdResult = await validateEcf31Xsd(signedXml);
  } catch {
    steps.push({ stage: "validate_xsd", success: false, durationMs: elapsed(started) });
    throw new EcfPreparationError(
      "validate_xsd",
      "internal",
      "O mecanismo de validacao XSD nao pode ser executado",
      steps,
    );
  }
  steps.push({ stage: "validate_xsd", success: xsdResult.valid, durationMs: elapsed(started) });
  if (!xsdResult.valid) {
    throw new EcfPreparationError(
      "validate_xsd",
      "xsd_validation",
      "O XML assinado nao atende ao XSD E31 oficial",
      steps,
      [],
      xsdResult.errors,
    );
  }

  started = performance.now();
  try {
    verifyXmlSignature(signedXml, material, "ECF");
    steps.push({ stage: "verify_signature", success: true, durationMs: elapsed(started) });
  } catch {
    steps.push({ stage: "verify_signature", success: false, durationMs: elapsed(started) });
    throw new EcfPreparationError(
      "verify_signature",
      "signature_failure",
      "O XML final falhou na verificacao criptografica",
      steps,
    );
  }

  return { xml: signedXml, totals, steps, schema: ECF31_SCHEMA };
}
