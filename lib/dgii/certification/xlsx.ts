import { inflateRawSync } from "node:zlib";

import { DOMParser, onWarningStopParsing } from "@xmldom/xmldom";

type XmlDocument = ReturnType<DOMParser["parseFromString"]>;
type XmlElement = NonNullable<XmlDocument["documentElement"]>;

const MAX_WORKBOOK_BYTES = 20 * 1024 * 1024;
const MAX_ENTRY_BYTES = 64 * 1024 * 1024;
const MAX_TOTAL_UNCOMPRESSED_BYTES = 128 * 1024 * 1024;
const END_OF_CENTRAL_DIRECTORY = 0x06054b50;
const CENTRAL_DIRECTORY_FILE_HEADER = 0x02014b50;
const LOCAL_FILE_HEADER = 0x04034b50;

export type CertificationSheet = {
  name: string;
  headers: string[];
  rows: Array<Record<string, string>>;
};

export type CertificationWorkbook = {
  sheets: Map<string, CertificationSheet>;
};

function xmlDocument(xml: string) {
  if (/<!DOCTYPE|<!ENTITY/i.test(xml)) throw new Error("DTD nao permitido no XLSX");
  return new DOMParser({ onError: onWarningStopParsing }).parseFromString(
    xml.replace(/^\uFEFF/, ""),
    "application/xml",
  );
}

function childElements(node: XmlDocument | XmlElement): XmlElement[] {
  return Array.from(node.childNodes).filter(
    (child): child is XmlElement => child.nodeType === 1,
  );
}

function childrenNamed(node: XmlDocument | XmlElement, localName: string): XmlElement[] {
  return childElements(node).filter((child) => child.localName === localName);
}

function firstChild(node: XmlDocument | XmlElement, localName: string): XmlElement | null {
  return childrenNamed(node, localName)[0] ?? null;
}

function normalizedEntryName(name: string): string {
  const normalized = name.replace(/\\/g, "/").replace(/^\/+/, "");
  if (!normalized || normalized.includes("../") || normalized.includes("\0")) {
    throw new Error("Nome de entrada ZIP inseguro");
  }
  return normalized;
}

function locateEndOfCentralDirectory(buffer: Buffer): number {
  const start = Math.max(0, buffer.length - 65_557);
  for (let offset = buffer.length - 22; offset >= start; offset -= 1) {
    if (buffer.readUInt32LE(offset) === END_OF_CENTRAL_DIRECTORY) return offset;
  }
  throw new Error("Diretorio central ZIP nao encontrado");
}

function unzipXlsx(buffer: Buffer): Map<string, Buffer> {
  if (buffer.length === 0 || buffer.length > MAX_WORKBOOK_BYTES) {
    throw new Error("O XLSX excede o limite permitido");
  }
  const endOffset = locateEndOfCentralDirectory(buffer);
  const entryCount = buffer.readUInt16LE(endOffset + 10);
  const centralSize = buffer.readUInt32LE(endOffset + 12);
  const centralOffset = buffer.readUInt32LE(endOffset + 16);
  if (centralOffset + centralSize > buffer.length || entryCount > 1_000) {
    throw new Error("Diretorio central ZIP invalido");
  }

  const entries = new Map<string, Buffer>();
  let offset = centralOffset;
  let totalUncompressed = 0;
  for (let index = 0; index < entryCount; index += 1) {
    if (offset + 46 > buffer.length || buffer.readUInt32LE(offset) !== CENTRAL_DIRECTORY_FILE_HEADER) {
      throw new Error("Cabecalho ZIP invalido");
    }
    const flags = buffer.readUInt16LE(offset + 8);
    const method = buffer.readUInt16LE(offset + 10);
    const compressedSize = buffer.readUInt32LE(offset + 20);
    const uncompressedSize = buffer.readUInt32LE(offset + 24);
    const nameLength = buffer.readUInt16LE(offset + 28);
    const extraLength = buffer.readUInt16LE(offset + 30);
    const commentLength = buffer.readUInt16LE(offset + 32);
    const localOffset = buffer.readUInt32LE(offset + 42);
    const nextOffset = offset + 46 + nameLength + extraLength + commentLength;
    if (nextOffset > buffer.length || uncompressedSize > MAX_ENTRY_BYTES) {
      throw new Error("Entrada ZIP excede o limite permitido");
    }
    if ((flags & 0x1) !== 0) throw new Error("XLSX criptografado nao e suportado");

    const name = normalizedEntryName(
      buffer.subarray(offset + 46, offset + 46 + nameLength).toString("utf8"),
    );
    if (localOffset + 30 > buffer.length || buffer.readUInt32LE(localOffset) !== LOCAL_FILE_HEADER) {
      throw new Error("Entrada ZIP local invalida");
    }
    const localNameLength = buffer.readUInt16LE(localOffset + 26);
    const localExtraLength = buffer.readUInt16LE(localOffset + 28);
    const dataOffset = localOffset + 30 + localNameLength + localExtraLength;
    if (dataOffset + compressedSize > buffer.length) throw new Error("Entrada ZIP truncada");
    const compressed = buffer.subarray(dataOffset, dataOffset + compressedSize);
    let contents: Buffer;
    if (method === 0) contents = Buffer.from(compressed);
    else if (method === 8) contents = inflateRawSync(compressed, { maxOutputLength: MAX_ENTRY_BYTES });
    else throw new Error(`Metodo de compactacao ZIP ${method} nao suportado`);
    if (contents.length !== uncompressedSize) throw new Error("Tamanho ZIP descompactado invalido");

    totalUncompressed += contents.length;
    if (totalUncompressed > MAX_TOTAL_UNCOMPRESSED_BYTES) {
      throw new Error("O XLSX descompactado excede o limite permitido");
    }
    entries.set(name, contents);
    offset = nextOffset;
  }
  return entries;
}

function requiredEntry(entries: Map<string, Buffer>, name: string): Buffer {
  const entry = entries.get(name);
  if (!entry) throw new Error(`Entrada obrigatoria ausente no XLSX: ${name}`);
  return entry;
}

function relationshipTarget(base: string, target: string): string {
  if (target.startsWith("/")) return normalizedEntryName(target);
  const parts = base.split("/");
  parts.pop();
  for (const segment of target.replace(/\\/g, "/").split("/")) {
    if (!segment || segment === ".") continue;
    if (segment === "..") parts.pop();
    else parts.push(segment);
  }
  return normalizedEntryName(parts.join("/"));
}

function sharedStrings(entries: Map<string, Buffer>): string[] {
  const entry = entries.get("xl/sharedStrings.xml");
  if (!entry) return [];
  const document = xmlDocument(entry.toString("utf8"));
  return Array.from(document.getElementsByTagNameNS("*", "si")).map((item) =>
    Array.from(item.getElementsByTagNameNS("*", "t"))
      .map((text) => text.textContent ?? "")
      .join(""),
  );
}

function cellColumn(reference: string): number {
  const letters = /^[A-Z]+/.exec(reference)?.[0];
  if (!letters) throw new Error(`Referencia de celula invalida: ${reference}`);
  let column = 0;
  for (const character of letters) column = column * 26 + character.charCodeAt(0) - 64;
  return column - 1;
}

function cellText(cell: XmlElement, strings: string[]): string {
  const type = cell.getAttribute("t");
  if (type === "inlineStr") {
    return Array.from(cell.getElementsByTagNameNS("*", "t"))
      .map((text) => text.textContent ?? "")
      .join("");
  }
  const raw = firstChild(cell, "v")?.textContent ?? "";
  if (type === "s") {
    const index = Number(raw);
    if (!Number.isSafeInteger(index) || strings[index] === undefined) {
      throw new Error("Indice de shared string invalido");
    }
    return strings[index];
  }
  if (type === "b") return raw === "1" ? "TRUE" : "FALSE";
  return raw;
}

function parseSheet(name: string, xml: Buffer, strings: string[]): CertificationSheet {
  const document = xmlDocument(xml.toString("utf8"));
  const parsedRows = new Map<number, Map<number, string>>();
  for (const row of Array.from(document.getElementsByTagNameNS("*", "row"))) {
    const rowNumber = Number(row.getAttribute("r"));
    if (!Number.isSafeInteger(rowNumber) || rowNumber < 1) throw new Error("Linha XLSX invalida");
    const values = new Map<number, string>();
    for (const cell of childrenNamed(row, "c")) {
      const reference = cell.getAttribute("r");
      if (!reference) throw new Error("Celula XLSX sem referencia");
      values.set(cellColumn(reference), cellText(cell, strings));
    }
    parsedRows.set(rowNumber, values);
  }

  const headerRow = parsedRows.get(1);
  if (!headerRow) throw new Error(`A aba ${name} nao possui cabecalho`);
  const maxColumn = Math.max(...headerRow.keys());
  const headers: string[] = [];
  const normalizedHeaders = new Set<string>();
  for (let column = 0; column <= maxColumn; column += 1) {
    const header = (headerRow.get(column) ?? "").trim();
    if (!header) throw new Error(`Cabecalho vazio na aba ${name}, coluna ${column + 1}`);
    const normalized = header.toLocaleLowerCase("en-US");
    if (normalizedHeaders.has(normalized)) throw new Error(`Cabecalho duplicado na aba ${name}: ${header}`);
    normalizedHeaders.add(normalized);
    headers.push(header);
  }

  const rows = Array.from(parsedRows.entries())
    .filter(([rowNumber]) => rowNumber > 1)
    .sort(([left], [right]) => left - right)
    .map(([, values]) => Object.fromEntries(headers.map((header, column) => [header, values.get(column) ?? ""])));
  return { name, headers, rows };
}

export function parseCertificationWorkbook(buffer: Buffer): CertificationWorkbook {
  const entries = unzipXlsx(buffer);
  const workbook = xmlDocument(requiredEntry(entries, "xl/workbook.xml").toString("utf8"));
  const relationships = xmlDocument(
    requiredEntry(entries, "xl/_rels/workbook.xml.rels").toString("utf8"),
  );
  const relationshipMap = new Map(
    Array.from(relationships.getElementsByTagNameNS("*", "Relationship")).map((item) => [
      item.getAttribute("Id"),
      item.getAttribute("Target"),
    ]),
  );
  const strings = sharedStrings(entries);
  const sheets = new Map<string, CertificationSheet>();
  for (const sheet of Array.from(workbook.getElementsByTagNameNS("*", "sheet"))) {
    const name = sheet.getAttribute("name");
    const relationshipId = sheet.getAttributeNS(
      "http://schemas.openxmlformats.org/officeDocument/2006/relationships",
      "id",
    );
    const target = relationshipMap.get(relationshipId);
    if (!name || !target) throw new Error("Relacionamento de aba invalido no XLSX");
    const entryName = relationshipTarget("xl/workbook.xml", target);
    sheets.set(name, parseSheet(name, requiredEntry(entries, entryName), strings));
  }
  return { sheets };
}
