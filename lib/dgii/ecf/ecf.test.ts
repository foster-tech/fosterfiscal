import assert from "node:assert/strict";
import { createHash, createPrivateKey, webcrypto } from "node:crypto";
import { readFile } from "node:fs/promises";
import path from "node:path";
import test from "node:test";

import { X509CertificateGenerator, cryptoProvider } from "@peculiar/x509";

import {
  buildUnsignedEcf31Xml,
  calculateEcf31Totals,
  compareDeclaredTotals,
  Ecf31Input,
  parseEcf31Input,
} from "./prepare";
import { diagnoseXsdRuntimeError, ECF31_SCHEMA, validateEcf31Xsd } from "./xsd";
import {
  signXmlDocument,
  SigningMaterial,
  verifyXmlSignature,
} from "../xml-signature";

cryptoProvider.set(webcrypto as unknown as Crypto);

test("preserva os bytes oficiais do XSD antes de qualquer transformacao", async () => {
  const bytes = await readFile(
    path.join(process.cwd(), "schemas", "dgii", ECF31_SCHEMA.fileName),
  );
  const digest = createHash("sha256").update(bytes).digest("hex");
  const text = bytes.toString("utf8");
  const lineFeeds = text.match(/\n/g)?.length ?? 0;
  const crlf = text.match(/\r\n/g)?.length ?? 0;

  assert.equal(bytes.byteLength, ECF31_SCHEMA.byteLength);
  assert.equal(digest, ECF31_SCHEMA.sha256);
  assert.notDeepEqual(Array.from(bytes.subarray(0, 3)), [0xef, 0xbb, 0xbf]);
  assert.equal(lineFeeds, crlf);
  assert.equal(crlf, 1696);
});

function syntheticInput(): Ecf31Input {
  return {
    document: {
      eNCF: "E310000000001",
      sequenceExpirationDate: "31-12-2099",
      incomeType: "01",
      paymentType: 1,
      amountsIncludeTax: false,
    },
    issuer: {
      rnc: "000000000",
      legalName: "EMISOR SINTETICO PARA PRUEBAS",
      address: "DIRECCION SINTETICA PARA PRUEBAS",
      issueDate: "15-10-2026",
    },
    buyer: {
      rnc: "000000000",
      legalName: "COMPRADOR SINTETICO PARA PRUEBAS",
    },
    items: [
      {
        name: "SERVICIO SINTETICO",
        kind: 2,
        billingIndicator: 1,
        quantity: "2.00",
        unitPrice: "100.0000",
      },
    ],
    totals: {
      taxableAmount: "200.00",
      exemptAmount: "0.00",
      itbis: "36.00",
      total: "236.00",
    },
    signatureDateTime: "15-10-2026 12:00:00",
  };
}

async function ephemeralMaterial(): Promise<SigningMaterial> {
  const algorithm = {
    name: "RSASSA-PKCS1-v1_5",
    hash: "SHA-256",
    publicExponent: new Uint8Array([1, 0, 1]),
    modulusLength: 2048,
  };
  const keys = (await webcrypto.subtle.generateKey(
    algorithm,
    true,
    ["sign", "verify"],
  )) as CryptoKeyPair;
  const certificate = await X509CertificateGenerator.createSelfSigned({
    serialNumber: "31",
    name: "CN=FosterFiscal E31 Synthetic Test",
    notBefore: new Date(Date.now() - 60_000),
    notAfter: new Date(Date.now() + 60_000),
    signingAlgorithm: algorithm,
    keys,
  });
  const pkcs8 = await webcrypto.subtle.exportKey("pkcs8", keys.privateKey);
  return {
    privateKey: createPrivateKey({
      key: Buffer.from(pkcs8),
      format: "der",
      type: "pkcs8",
    }),
    certificatePem: certificate.toString("pem"),
  };
}

test("gera E31 sintetica, valida no XSD oficial, assina e verifica", async () => {
  const input = syntheticInput();
  const totals = calculateEcf31Totals(input);
  assert.deepEqual(compareDeclaredTotals(input, totals), []);
  const unsigned = buildUnsignedEcf31Xml(input, totals);
  const material = await ephemeralMaterial();
  const signed = signXmlDocument(unsigned, material, "ECF");
  const xsd = await validateEcf31Xsd(signed);

  assert.equal(xsd.valid, true, JSON.stringify(xsd.errors));
  assert.doesNotThrow(() => verifyXmlSignature(signed, material, "ECF"));
});

test("rejeita campo obrigatorio ausente", () => {
  const raw = syntheticInput() as unknown as Record<string, unknown>;
  delete (raw.issuer as Record<string, unknown>).legalName;
  const parsed = parseEcf31Input(raw);

  assert.equal(parsed.value, undefined);
  assert.ok(parsed.issues.some((issue) => issue.path === "issuer.legalName"));
});

test("XSD oficial rejeita ordem estrutural invalida", async () => {
  const input = syntheticInput();
  const totals = calculateEcf31Totals(input);
  const unsigned = buildUnsignedEcf31Xml(input, totals).replace(
    "<NombreItem>SERVICIO SINTETICO</NombreItem><IndicadorBienoServicio>2</IndicadorBienoServicio>",
    "<IndicadorBienoServicio>2</IndicadorBienoServicio><NombreItem>SERVICIO SINTETICO</NombreItem>",
  );
  const material = await ephemeralMaterial();
  const signed = signXmlDocument(unsigned, material, "ECF");
  const xsd = await validateEcf31Xsd(signed);

  assert.equal(xsd.valid, false);
  assert.ok(xsd.errors.some((error) => /NombreItem|IndicadorBienoServicio/.test(error.message)));
});

test("detecta totais declarados inconsistentes", () => {
  const input = syntheticInput();
  input.totals.total = "235.99";
  const issues = compareDeclaredTotals(input, calculateEcf31Totals(input));

  assert.deepEqual(issues.map((issue) => issue.path), ["totals.total"]);
});

test("detecta XML alterado depois da assinatura", async () => {
  const input = syntheticInput();
  const unsigned = buildUnsignedEcf31Xml(input, calculateEcf31Totals(input));
  const material = await ephemeralMaterial();
  const signed = signXmlDocument(unsigned, material, "ECF");
  const tampered = signed.replace("<MontoTotal>236.00</MontoTotal>", "<MontoTotal>999.00</MontoTotal>");

  assert.throws(
    () => verifyXmlSignature(tampered, material, "ECF"),
    /verificacao local/,
  );
});

test("sanitiza diagnostico interno do runtime XSD", () => {
  const error = Object.assign(
    new Error(
      "Cannot find module '/var/task/node_modules/xmllint-wasm/xmllint-node.js' for worker",
    ),
    { code: "MODULE_NOT_FOUND" },
  );
  const diagnostic = diagnoseXsdRuntimeError(error);

  assert.equal(diagnostic.code, "worker_start_failed");
  assert.equal(diagnostic.component, "worker");
  assert.equal(diagnostic.causeCode, "MODULE_NOT_FOUND");
  assert.doesNotMatch(diagnostic.message, /\/var\/task/);
  assert.match(diagnostic.message, /\[path\]/);
});
