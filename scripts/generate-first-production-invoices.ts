import { createHash } from "node:crypto";
import { mkdir, writeFile } from "node:fs/promises";
import path from "node:path";

import { prepareEcf31, type Ecf31Input } from "../lib/dgii/ecf/prepare";

const OUTPUT_DIR = path.resolve("output/ecf/production/2026-11-11-encf-8-9");
const ISSUER_RNC = "132071506";
const BASE_AMOUNT = "245800.00";
const ITBIS = "44244.00";
const TOTAL = "290044.00";

function requiredEnvironment(name: string): string {
  const value = process.env[name];
  if (!value) throw new Error(`Variavel ${name} ausente`);
  return value;
}

type InvoiceDefinition = {
  slug: string;
  encf: string;
  buyerRnc: string;
  buyerName: string;
  buyerAddress: string;
};

const invoices: InvoiceDefinition[] = [
  {
    slug: "mercasid",
    encf: "E310000000008",
    buyerRnc: "101807687",
    buyerName: "MERCASID, S.A.",
    buyerAddress:
      "Av. Maximo Gomez #182, Ensanche La Fe, Santo Domingo, Republica Dominicana",
  },
  {
    slug: "induveca",
    encf: "E310000000009",
    buyerRnc: "122011226",
    buyerName: "INDUVECA, S.A.",
    buyerAddress:
      "Av. Maximo Gomez #182, Ensanche La Fe, Santo Domingo, Republica Dominicana",
  },
];

function inputFor(invoice: InvoiceDefinition): Ecf31Input {
  return {
    document: {
      eNCF: invoice.encf,
      sequenceExpirationDate: "31-12-2027",
      incomeType: "01",
      paymentType: 2,
      paymentDueDate: "11-12-2026",
      amountsIncludeTax: false,
    },
    issuer: {
      rnc: ISSUER_RNC,
      legalName: "FOSTERTECH SOLUTIONS SRL",
      address:
        "Calle Maximo Aviles Blonda #12, IM Plaza Local 2B, Julieta Morales, D.N.",
      issueDate: "11-11-2026",
    },
    buyer: {
      rnc: invoice.buyerRnc,
      legalName: invoice.buyerName,
      address: invoice.buyerAddress,
    },
    items: [
      {
        name: "Entrega wireframes, diseno UI/UX y arquitectura y diseno de base de datos",
        description:
          "Servicios equivalentes a USD 4,000.00 convertidos a la tasa RD$61.45 por USD 1.00.",
        kind: 2,
        billingIndicator: 1,
        quantity: "1.00",
        unitPrice: "245800.0000",
      },
    ],
    totals: {
      taxableAmount: BASE_AMOUNT,
      exemptAmount: "0.00",
      itbis: ITBIS,
      total: TOTAL,
    },
  };
}

async function main(): Promise<void> {
  const signingConfig = {
    p12Base64: requiredEnvironment("DGII_CERT_P12_BASE64"),
    certificatePassword: process.env.DGII_CERT_PASSWORD ?? "",
  };
  await mkdir(OUTPUT_DIR, { recursive: true });

  const manifestEntries = [];
  for (const invoice of invoices) {
    const input = inputFor(invoice);
    const prepared = await prepareEcf31(input, signingConfig);
    const filename = `factura-${invoice.slug}-${invoice.encf}.xml`;
    const output = path.join(OUTPUT_DIR, filename);
    await writeFile(output, prepared.xml, {
      encoding: "utf8",
      flag: "wx",
      mode: 0o600,
    });
    manifestEntries.push({
      buyer: invoice.buyerName,
      buyerRnc: invoice.buyerRnc,
      encf: invoice.encf,
      output,
      bytes: Buffer.byteLength(prepared.xml, "utf8"),
      sha256: createHash("sha256").update(prepared.xml).digest("hex"),
      totals: prepared.totals,
      schema: prepared.schema,
      signed: true,
      transmitted: false,
    });
  }

  const manifestPath = path.join(OUTPUT_DIR, "manifest.json");
  await writeFile(manifestPath, JSON.stringify({
    environment: "ecf",
    issuerRnc: ISSUER_RNC,
    issueDate: "11-11-2026",
    paymentDueDate: "11-12-2026",
    sequenceExpirationDate: "31-12-2027",
    submittedToDgii: false,
    invoices: manifestEntries,
  }, null, 2), { encoding: "utf8", flag: "wx", mode: 0o600 });

  console.log(JSON.stringify({
    success: true,
    submittedToDgii: false,
    manifest: manifestPath,
    invoices: manifestEntries,
  }, null, 2));
}

main().catch((error: unknown) => {
  console.error(JSON.stringify({
    success: false,
    error: error instanceof Error ? error.message : "Falha desconhecida",
  }));
  process.exitCode = 1;
});
