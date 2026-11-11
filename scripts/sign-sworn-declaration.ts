import { createHash } from "node:crypto";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import path from "node:path";

import {
  loadSigningMaterial,
  signXmlDocument,
  verifyXmlSignature,
} from "../lib/dgii/xml-signature";

const inputArgument = process.argv[2];
if (!inputArgument) {
  throw new Error("Informe o caminho do XML da declaracao jurada");
}

const inputPath = path.resolve(inputArgument);
const outputPath = path.resolve(
  process.argv[3] ?? "output/xml/declaracion-jurada.firmada.xml",
);

function requiredEnvironment(name: string): string {
  const value = process.env[name];
  if (value === undefined || value === "") {
    throw new Error(`Variavel ${name} ausente`);
  }
  return value;
}

async function main(): Promise<void> {
  if (inputPath === outputPath) {
    throw new Error("O arquivo de saida deve ser diferente do original");
  }

  const originalXml = await readFile(inputPath, "utf8");
  if (/<!DOCTYPE|<!ENTITY/i.test(originalXml)) {
    throw new Error("DTD e ENTITY nao sao permitidos");
  }
  if (/<(?:[\w.-]+:)?Signature\b/i.test(originalXml)) {
    throw new Error("O XML de origem ja contem uma assinatura");
  }

  const material = await loadSigningMaterial(
    requiredEnvironment("DGII_CERT_P12_BASE64"),
    process.env.DGII_CERT_PASSWORD ?? "",
  );
  const signedXml = signXmlDocument(
    originalXml,
    material,
    "DeclaracionJurada",
  );
  verifyXmlSignature(signedXml, material, "DeclaracionJurada");

  await mkdir(path.dirname(outputPath), { recursive: true });
  await writeFile(outputPath, signedXml, {
    encoding: "utf8",
    flag: "wx",
    mode: 0o600,
  });

  console.log(JSON.stringify({
    success: true,
    input: inputPath,
    output: outputPath,
    inputBytes: Buffer.byteLength(originalXml, "utf8"),
    outputBytes: Buffer.byteLength(signedXml, "utf8"),
    inputSha256: createHash("sha256").update(originalXml).digest("hex"),
    outputSha256: createHash("sha256").update(signedXml).digest("hex"),
    signatureProfile: "RSA-SHA256 / SHA-256 / C14N 1.0 enveloped",
    verified: true,
  }, null, 2));
}

main().catch((error: unknown) => {
  console.error(JSON.stringify({
    success: false,
    error: error instanceof Error ? error.message : "Falha desconhecida",
  }));
  process.exitCode = 1;
});
