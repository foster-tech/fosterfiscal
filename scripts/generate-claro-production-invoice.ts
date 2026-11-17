import { createHash } from "node:crypto";
import { mkdir, writeFile } from "node:fs/promises";
import path from "node:path";

import { prepareEcf31, type Ecf31Input } from "../lib/dgii/ecf/prepare";

const OUTPUT_DIR = path.resolve("output/ecf/production/2026-11-17-claro-encf-10");
const ISSUER_RNC = "132071506";
const ENCF = "E310000000010";
const SOURCE_PROFORMA =
  "G:\\Meu Drive\\FosterTech\\Financiero\\2026\\2026-11\\Proforma\\PROFORMA-2026-000202 - PO-4600007706.pdf";
const SOURCE_PROFORMA_SHA256 =
  "f1e1c6d757b7e6b95ecb6fd135e01262cc5e10fbbde8544db6255b9467200cb2";

function requiredEnvironment(name: string): string {
  const value = process.env[name];
  if (!value) throw new Error(`Variavel ${name} ausente`);
  return value;
}

function invoiceInput(): Ecf31Input {
  return {
    document: {
      eNCF: ENCF,
      sequenceExpirationDate: "31-12-2027",
      incomeType: "01",
      paymentType: 2,
      paymentDueDate: "17-12-2026",
      amountsIncludeTax: false,
    },
    issuer: {
      rnc: ISSUER_RNC,
      legalName: "FOSTERTECH SOLUTIONS SRL",
      address:
        "Calle Maximo Aviles Blonda #12, IM Plaza Local 2B, Julieta Morales, D.N.",
      issueDate: "17-11-2026",
    },
    buyer: {
      rnc: "101001577",
      legalName: "COMPAÑÍA DOMINICANA DE TELÉFONOS, S.A.",
      address:
        "Edif. Corporativo, Av. John F. Kennedy #54, Serralles, Santo Domingo, Republica Dominicana",
      purchaseOrderNumber: "4600007706",
    },
    items: [
      {
        name: "Servicio de Analisis y Desarrollo",
        description:
          "Soporte al sistema Ensemble (Horizonte). PO: 4600007706.",
        kind: 2,
        billingIndicator: 1,
        quantity: "1.00",
        unitPrice: "213000.0000",
      },
    ],
    totals: {
      taxableAmount: "213000.00",
      exemptAmount: "0.00",
      itbis: "38340.00",
      total: "251340.00",
    },
  };
}

async function main(): Promise<void> {
  const prepared = await prepareEcf31(invoiceInput(), {
    p12Base64: requiredEnvironment("DGII_CERT_P12_BASE64"),
    certificatePassword: process.env.DGII_CERT_PASSWORD ?? "",
  });

  await mkdir(OUTPUT_DIR, { recursive: true });
  const xmlPath = path.join(OUTPUT_DIR, `factura-claro-${ENCF}.xml`);
  await writeFile(xmlPath, prepared.xml, {
    encoding: "utf8",
    flag: "wx",
    mode: 0o600,
  });

  const entry = {
    buyer: "COMPAÑÍA DOMINICANA DE TELÉFONOS, S.A.",
    buyerRnc: "101001577",
    purchaseOrderNumber: "4600007706",
    encf: ENCF,
    output: xmlPath,
    bytes: Buffer.byteLength(prepared.xml, "utf8"),
    sha256: createHash("sha256").update(prepared.xml).digest("hex"),
    totals: prepared.totals,
    schema: prepared.schema,
    signed: true,
    transmitted: false,
  };

  const manifestPath = path.join(OUTPUT_DIR, "manifest.json");
  await writeFile(
    manifestPath,
    JSON.stringify(
      {
        environment: "ecf",
        issuerRnc: ISSUER_RNC,
        issueDate: "17-11-2026",
        paymentDueDate: "17-12-2026",
        sequenceExpirationDate: "31-12-2027",
        sourceProforma: {
          path: SOURCE_PROFORMA,
          sha256: SOURCE_PROFORMA_SHA256,
        },
        submittedToDgii: false,
        invoices: [entry],
      },
      null,
      2,
    ),
    { encoding: "utf8", flag: "wx", mode: 0o600 },
  );

  console.log(
    JSON.stringify(
      {
        success: true,
        submittedToDgii: false,
        manifest: manifestPath,
        invoice: entry,
      },
      null,
      2,
    ),
  );
}

main().catch((error: unknown) => {
  console.error(
    JSON.stringify({
      success: false,
      error: error instanceof Error ? error.message : "Falha desconhecida",
    }),
  );
  process.exitCode = 1;
});
