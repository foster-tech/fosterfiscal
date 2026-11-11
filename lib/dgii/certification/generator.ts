import { DOMParser, onWarningStopParsing } from "@xmldom/xmldom";

type XmlDocument = ReturnType<DOMParser["parseFromString"]>;
type XmlElement = NonNullable<XmlDocument["documentElement"]>;

type XsdPlan = {
  kind: "element" | "any";
  name: string;
  sourceName: string;
  minOccurs: number;
  maxOccurs: number;
  children: XsdPlan[];
};

type LeafPattern = {
  name: string;
  repeatDepth: number;
};

type HeaderEntry = {
  key: string;
  base: string;
  indices: number[];
};

type Occurrence = {
  index: number;
  appendIndex: boolean;
};

const OMITTED_VALUE = "#e";

function xmlDocument(xml: string) {
  if (/<!DOCTYPE|<!ENTITY/i.test(xml)) throw new Error("DTD nao permitido no XSD");
  return new DOMParser({ onError: onWarningStopParsing }).parseFromString(
    xml,
    "application/xml",
  );
}

function childElements(node: XmlDocument | XmlElement): XmlElement[] {
  return Array.from(node.childNodes).filter(
    (child): child is XmlElement => child.nodeType === 1,
  );
}

function firstChild(node: XmlDocument | XmlElement, localName: string): XmlElement | null {
  return childElements(node).find((child) => child.localName === localName) ?? null;
}

function occurs(value: string | null, fallback: number): number {
  if (!value) return fallback;
  if (value === "unbounded") return Number.MAX_SAFE_INTEGER;
  const parsed = Number(value);
  if (!Number.isSafeInteger(parsed) || parsed < 0) throw new Error(`Ocorrencia XSD invalida: ${value}`);
  return parsed;
}

function parsePlan(element: XmlElement, ancestors: string[] = []): XsdPlan {
  if (element.localName === "any") {
    return {
      kind: "any",
      name: "Signature",
      sourceName: "Signature",
      minOccurs: occurs(element.getAttribute("minOccurs"), 1),
      maxOccurs: occurs(element.getAttribute("maxOccurs"), 1),
      children: [],
    };
  }
  const name = element.getAttribute("name");
  if (!name) throw new Error("Elemento XSD sem nome");
  const complexType = firstChild(element, "complexType");
  const sequence = complexType ? firstChild(complexType, "sequence") : null;
  const children = sequence
    ? childElements(sequence)
        .filter((child) => child.localName === "element" || child.localName === "any")
        .map((child) => parsePlan(child, [...ancestors, name]))
    : [];
  const sourceName = name === "NumeroLinea" && ancestors.at(-1) === "DescuentoORecargo"
    ? "NumeroLineaDoR"
    : name;
  return {
    kind: "element",
    name,
    sourceName,
    minOccurs: occurs(element.getAttribute("minOccurs"), 1),
    maxOccurs: occurs(element.getAttribute("maxOccurs"), 1),
    children,
  };
}

export function parseRootPlan(schema: string, expectedRoot: "ECF" | "RFCE"): XsdPlan {
  const document = xmlDocument(schema.replace(/^\uFEFF/, ""));
  const root = Array.from(document.getElementsByTagNameNS("*", "element")).find(
    (element) => element.parentNode === document.documentElement && element.getAttribute("name") === expectedRoot,
  );
  if (!root) throw new Error(`Raiz ${expectedRoot} ausente no XSD`);
  return parsePlan(root);
}

function normalizedBase(value: string): string {
  return value.trim().replace(/\s+/g, "").toLocaleLowerCase("en-US");
}

function headerEntry(header: string): HeaderEntry {
  const trimmed = header.trim();
  const base = trimmed.replace(/(?:\[\d+\])+$/, "");
  const indices = Array.from(trimmed.matchAll(/\[(\d+)\]/g)).map((match) => Number(match[1]));
  return { key: normalizedBase(trimmed), base: normalizedBase(base), indices };
}

function headerName(name: string, indices: number[]): string {
  return `${name}${indices.map((index) => `[${index}]`).join("")}`;
}

function escaped(value: string): string {
  return value
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&apos;");
}

function leafPatterns(plan: XsdPlan): LeafPattern[] {
  if (plan.kind === "any") return [];
  if (plan.children.length === 0) {
    return [{ name: plan.sourceName, repeatDepth: plan.maxOccurs > 1 ? 1 : 0 }];
  }
  const ownDepth = plan.maxOccurs > 1 ? 1 : 0;
  return plan.children.flatMap((child) =>
    leafPatterns(child).map((leaf) => ({
      name: leaf.name,
      repeatDepth: leaf.repeatDepth + ownDepth,
    })),
  );
}

class RowSource {
  readonly entries: HeaderEntry[];
  readonly values = new Map<string, string>();

  constructor(headers: string[], row: Record<string, string>) {
    this.entries = headers.map(headerEntry);
    for (const [header, value] of Object.entries(row)) {
      this.values.set(normalizedBase(header), value ?? "");
    }
  }

  value(name: string, indices: number[]): string | undefined {
    const value = this.values.get(normalizedBase(headerName(name, indices)));
    if (value === undefined || value === "" || value.toLocaleLowerCase("en-US") === OMITTED_VALUE) {
      return undefined;
    }
    return value;
  }

  repetitions(plan: XsdPlan, parentIndices: number[]): Occurrence[] {
    if (plan.maxOccurs <= 1) return [{ index: 1, appendIndex: false }];
    const patterns = plan.children.length === 0
      ? [{ name: plan.sourceName, repeatDepth: 0 }]
      : plan.children.flatMap(leafPatterns);
    if (patterns.length === 0) return [];
    const minimumDepth = Math.min(...patterns.map((pattern) => pattern.repeatDepth));
    const anchors = patterns.filter((pattern) => pattern.repeatDepth === minimumDepth);
    let maximum = 0;
    for (const entry of this.entries) {
      for (const anchor of anchors) {
        if (entry.base !== normalizedBase(anchor.name)) continue;
        const expectedLength = parentIndices.length + 1 + anchor.repeatDepth;
        if (entry.indices.length !== expectedLength) continue;
        if (!parentIndices.every((index, position) => entry.indices[position] === index)) continue;
        maximum = Math.max(maximum, entry.indices[parentIndices.length]);
      }
    }
    if (maximum > 0) {
      if (maximum > plan.maxOccurs) {
        throw new Error(
          `A planilha excede maxOccurs de ${plan.name}: ${maximum} > ${plan.maxOccurs} (indices pais: ${parentIndices.join(",") || "nenhum"})`,
        );
      }
      return Array.from({ length: maximum }, (_, index) => ({ index: index + 1, appendIndex: true }));
    }

    const unindexed = anchors.some((anchor) =>
      this.entries.some((entry) =>
        entry.base === normalizedBase(anchor.name) &&
        entry.indices.length === parentIndices.length + anchor.repeatDepth &&
        parentIndices.every((index, position) => entry.indices[position] === index),
      ),
    );
    return unindexed ? [{ index: 1, appendIndex: false }] : [];
  }
}

function planHasValue(plan: XsdPlan, source: RowSource, indices: number[]): boolean {
  if (plan.kind === "any") return false;
  for (const occurrence of source.repetitions(plan, indices)) {
    const occurrenceIndices = occurrence.appendIndex ? [...indices, occurrence.index] : indices;
    if (plan.children.length === 0) {
      if (source.value(plan.sourceName, occurrenceIndices) !== undefined) return true;
    } else if (plan.children.some((child) => planHasValue(child, source, occurrenceIndices))) {
      return true;
    }
  }
  return false;
}

function renderPlan(plan: XsdPlan, source: RowSource, indices: number[], path: string): string {
  if (plan.kind === "any") return "";
  const occurrences = source.repetitions(plan, indices);
  if (occurrences.length === 0) {
    if (plan.minOccurs > 0) throw new Error(`Campo ou secao obrigatoria ausente: ${path}`);
    return "";
  }
  const rendered: string[] = [];
  for (const occurrence of occurrences) {
    const occurrenceIndices = occurrence.appendIndex ? [...indices, occurrence.index] : indices;
    const occurrencePath = plan.maxOccurs > 1 ? `${path}[${occurrence.index}]` : path;
    if (plan.children.length === 0) {
      const value = source.value(plan.sourceName, occurrenceIndices);
      if (value === undefined) {
        if (plan.minOccurs > 0 && plan.maxOccurs === 1) {
          throw new Error(`Campo obrigatorio ausente: ${occurrencePath}`);
        }
        continue;
      }
      rendered.push(`<${plan.name}>${escaped(value)}</${plan.name}>`);
      continue;
    }

    const occurrenceHasValue = plan.children.some((child) =>
      planHasValue(child, source, occurrenceIndices),
    );
    if (!occurrenceHasValue) continue;
    const children = plan.children
      .map((child) => renderPlan(child, source, occurrenceIndices, `${occurrencePath}.${child.name}`))
      .join("");
    if (!children) {
      if (plan.minOccurs > 0 && plan.maxOccurs === 1) {
        throw new Error(`Secao obrigatoria vazia: ${occurrencePath}`);
      }
      continue;
    }
    rendered.push(`<${plan.name}>${children}</${plan.name}>`);
  }
  if (rendered.length < plan.minOccurs) {
    throw new Error(`Quantidade minima nao atendida: ${path}`);
  }
  return rendered.join("");
}

export function buildUnsignedXmlFromRow(input: {
  schema: string;
  root: "ECF" | "RFCE";
  headers: string[];
  row: Record<string, string>;
}): string {
  const plan = parseRootPlan(input.schema, input.root);
  const source = new RowSource(input.headers, input.row);
  const body = renderPlan(plan, source, [], input.root);
  if (!body) throw new Error(`Nao foi possivel gerar ${input.root}`);
  return `<?xml version="1.0" encoding="utf-8"?>${body}`;
}
