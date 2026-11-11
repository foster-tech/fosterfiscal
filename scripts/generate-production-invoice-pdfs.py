from __future__ import annotations

import io
import json
import urllib.parse
import xml.etree.ElementTree as ET
from dataclasses import dataclass
from decimal import Decimal
from pathlib import Path

import qrcode
from reportlab.lib import colors
from reportlab.lib.enums import TA_CENTER, TA_LEFT, TA_RIGHT
from reportlab.lib.pagesizes import A4
from reportlab.lib.styles import ParagraphStyle
from reportlab.lib.units import mm
from reportlab.lib.utils import ImageReader
from reportlab.pdfgen import canvas
from reportlab.platypus import Paragraph, Table, TableStyle


ROOT = Path(__file__).resolve().parents[1]
MANIFEST_PATH = ROOT / "output" / "ecf" / "production" / "2026-11-11" / "manifest.json"
OUTPUT_DIR = ROOT / "output" / "pdf" / "production" / "2026-11-11"
LOGO_PATH = Path(r"G:\Meu Drive\FosterTech\ReBranding\LOGOS\LOGO FUNDO BRANCO 1.png")

DEEP_INDIGO = colors.HexColor("#0B1444")
TECH_BLUE = colors.HexColor("#1E90FF")
CYAN = colors.HexColor("#00E5FF")
INK = colors.HexColor("#101426")
MUTED = colors.HexColor("#576178")
LINE = colors.HexColor("#D8DEE9")
ROW = colors.HexColor("#F4F6FA")

COMPANY_NAME = "FOSTERTECH SOLUTIONS SRL"
COMPANY_RNC = "132071506"
COMPANY_ADDRESS = (
    "Calle Máximo Avilés Blonda #12 - IM Plaza Local 2B, "
    "Julieta Morales, República Dominicana"
)
COMPANY_PHONE = "Tel. (849) 220-8455"
TRANSFER_NOTE = (
    "Instrucciones Transferencias Bancarias: Banco Popular Dominicano, "
    "Cuenta Corriente 817687411."
)
EXCHANGE_NOTE = "Monto equivalente a USD 4,000.00. Tasa de conversión: USD 1.00 = RD$61.45."

BUYER_EXTRAS = {
    "101807687": {
        "phone": "(809) 381-5121",
        "slug": "mercasid",
        "address": "Av. Máximo Gómez #182, Ensanche La Fe, Santo Domingo, República Dominicana",
    },
    "122011226": {
        "phone": "(809) 565-2151",
        "slug": "induveca",
        "address": "Av. Máximo Gómez #182, Ensanche La Fe, Santo Domingo, República Dominicana",
    },
}

DISPLAY_ITEM_NAMES = {
    "Entrega wireframes, diseno UI/UX y arquitectura y diseno de base de datos": (
        "Entrega wireframes, diseño UI/UX y arquitectura y diseño de base de datos"
    ),
}


@dataclass(frozen=True)
class Invoice:
    source: Path
    root: ET.Element

    def text(self, tag: str, default: str = "") -> str:
        for element in self.root.iter():
            if element.tag.split("}")[-1] == tag:
                return (element.text or "").strip()
        return default

    def items(self) -> list[ET.Element]:
        return [
            element
            for element in self.root.iter()
            if element.tag.split("}")[-1] == "Item"
        ]


def child_text(element: ET.Element, tag: str, default: str = "") -> str:
    for child in list(element):
        if child.tag.split("}")[-1] == tag:
            return (child.text or "").strip()
    return default


def amount(value: str) -> Decimal:
    return Decimal(value or "0")


def money(value: str | Decimal) -> str:
    parsed = value if isinstance(value, Decimal) else amount(value)
    return f"RD$ {parsed:,.2f}"


def signature_value(invoice: Invoice) -> str:
    value = invoice.text("SignatureValue")
    if len(value) < 6:
        raise ValueError(f"SignatureValue inválido: {invoice.source}")
    return value


def security_code(invoice: Invoice) -> str:
    return signature_value(invoice)[:6]


def qr_url(invoice: Invoice) -> str:
    parameters = [
        ("RncEmisor", invoice.text("RNCEmisor")),
        ("RncComprador", invoice.text("RNCComprador")),
        ("ENCF", invoice.text("eNCF")),
        ("FechaEmision", invoice.text("FechaEmision")),
        ("MontoTotal", f"{amount(invoice.text('MontoTotal')):.2f}"),
        ("FechaFirma", invoice.text("FechaHoraFirma")),
        ("CodigoSeguridad", security_code(invoice)),
    ]
    query = urllib.parse.urlencode(parameters, quote_via=urllib.parse.quote)
    return f"https://ecf.dgii.gov.do/ecf/ConsultaTimbre?{query}"


def paragraph(
    text: str,
    size: float = 7.2,
    align: int = TA_LEFT,
    bold: bool = False,
    color=INK,
    leading: float | None = None,
) -> Paragraph:
    style = ParagraphStyle(
        name=f"invoice-{size}-{align}-{bold}",
        fontName="Helvetica-Bold" if bold else "Helvetica",
        fontSize=size,
        leading=leading or size + 1.8,
        alignment=align,
        textColor=color,
        wordWrap="CJK",
    )
    escaped = (
        str(text)
        .replace("&", "&amp;")
        .replace("<", "&lt;")
        .replace(">", "&gt;")
    )
    return Paragraph(escaped, style)


def draw_header(c: canvas.Canvas, invoice: Invoice) -> None:
    page_width, page_height = A4
    c.drawImage(
        ImageReader(LOGO_PATH),
        18 * mm,
        page_height - 35 * mm,
        56 * mm,
        20 * mm,
        preserveAspectRatio=True,
        anchor="sw",
        mask="auto",
    )

    c.setFillColor(DEEP_INDIGO)
    c.setFont("Helvetica-Bold", 18)
    c.drawRightString(page_width - 18 * mm, page_height - 20 * mm, "Factura")
    c.setFillColor(TECH_BLUE)
    c.setFont("Helvetica-Bold", 8.5)
    c.drawRightString(
        page_width - 18 * mm,
        page_height - 26 * mm,
        "Factura de Crédito Fiscal Electrónica",
    )

    metadata = [
        ("e-NCF", invoice.text("eNCF")),
        ("Fecha de emisión", invoice.text("FechaEmision")),
        ("Vencimiento", invoice.text("FechaLimitePago")),
        ("Vence secuencia", invoice.text("FechaVencimientoSecuencia")),
        ("Términos", "Crédito - 30 días"),
    ]
    label_x = page_width - 90 * mm
    value_x = page_width - 18 * mm
    y = page_height - 34 * mm
    for label, value in metadata:
        c.setFillColor(MUTED)
        c.setFont("Helvetica", 6.5)
        c.drawRightString(label_x, y, f"{label}:")
        c.setFillColor(INK)
        c.setFont("Helvetica-Bold", 6.8)
        c.drawRightString(value_x, y, value)
        y -= 4.5 * mm

    company_y = page_height - 48 * mm
    c.setFillColor(MUTED)
    c.setFont("Helvetica-Bold", 7)
    c.drawString(18 * mm, company_y, COMPANY_NAME)
    company = paragraph(COMPANY_ADDRESS, 6.4, color=MUTED, leading=8)
    company.wrapOn(c, 78 * mm, 14 * mm)
    company.drawOn(c, 18 * mm, company_y - 10 * mm)
    c.setFont("Helvetica", 6.5)
    c.drawString(18 * mm, company_y - 13.5 * mm, COMPANY_PHONE)
    c.setFillColor(INK)
    c.setFont("Helvetica-Bold", 6.8)
    c.drawString(18 * mm, company_y - 18 * mm, f"RNC: {COMPANY_RNC}")

    c.setStrokeColor(LINE)
    c.setLineWidth(0.6)
    c.line(18 * mm, page_height - 72 * mm, page_width - 18 * mm, page_height - 72 * mm)


def draw_buyer(c: canvas.Canvas, invoice: Invoice) -> None:
    page_width, page_height = A4
    y = page_height - 79 * mm
    buyer_rnc = invoice.text("RNCComprador")
    extras = BUYER_EXTRAS.get(buyer_rnc, {})

    c.setFillColor(TECH_BLUE)
    c.setFont("Helvetica-Bold", 7)
    c.drawString(18 * mm, y, "FACTURAR A")
    c.setFillColor(INK)
    c.setFont("Helvetica-Bold", 8.5)
    c.drawString(18 * mm, y - 6 * mm, invoice.text("RazonSocialComprador"))
    c.setFont("Helvetica-Bold", 6.8)
    c.drawString(18 * mm, y - 11 * mm, f"RNC: {buyer_rnc}")
    if extras.get("phone"):
        c.setFont("Helvetica", 6.8)
        c.drawString(18 * mm, y - 15.5 * mm, f"Tel.: {extras['phone']}")

    buyer_address = extras.get("address") or invoice.text("DireccionComprador")
    address = paragraph(buyer_address, 6.8, leading=8.6)
    address.wrapOn(c, 82 * mm, 20 * mm)
    address.drawOn(c, 108 * mm, y - 15 * mm)

    c.setStrokeColor(LINE)
    c.line(18 * mm, y - 21 * mm, page_width - 18 * mm, y - 21 * mm)


def draw_items(c: canvas.Canvas, invoice: Invoice) -> float:
    page_width, page_height = A4
    rows = [[
        paragraph("CANT.", 6.7, TA_CENTER, True, colors.white),
        paragraph("DESCRIPCIÓN", 6.7, TA_CENTER, True, colors.white),
        paragraph("PRECIO", 6.7, TA_CENTER, True, colors.white),
        paragraph("ITBIS", 6.7, TA_CENTER, True, colors.white),
        paragraph("TOTAL", 6.7, TA_CENTER, True, colors.white),
    ]]

    for item in invoice.items():
        quantity = amount(child_text(item, "CantidadItem"))
        unit_price = amount(child_text(item, "PrecioUnitarioItem"))
        line_total = amount(child_text(item, "MontoItem"))
        itbis = (line_total * Decimal("0.18")).quantize(Decimal("0.01"))
        raw_description = child_text(item, "NombreItem")
        description = DISPLAY_ITEM_NAMES.get(raw_description, raw_description)
        detail = child_text(item, "DescripcionItem").replace("RD$61.45", "RD$ 61.45")
        combined = f"<b>{description}</b><br/><font color='#576178'>{detail}</font>"
        desc_style = ParagraphStyle(
            name="item-description",
            fontName="Helvetica",
            fontSize=6.8,
            leading=8.5,
            textColor=INK,
            wordWrap="CJK",
        )
        rows.append([
            paragraph(f"{quantity:g}", 7, TA_CENTER),
            Paragraph(combined, desc_style),
            paragraph(money(unit_price), 7, TA_RIGHT),
            paragraph(money(itbis), 7, TA_RIGHT),
            paragraph(money(line_total + itbis), 7, TA_RIGHT, True),
        ])

    table = Table(
        rows,
        colWidths=[14 * mm, 87 * mm, 27 * mm, 25 * mm, 26 * mm],
        repeatRows=1,
    )
    table.setStyle(TableStyle([
        ("BACKGROUND", (0, 0), (-1, 0), colors.HexColor("#356FB4")),
        ("ROWBACKGROUNDS", (0, 1), (-1, -1), [colors.white, ROW]),
        ("GRID", (0, 0), (-1, -1), 0.4, LINE),
        ("VALIGN", (0, 0), (-1, -1), "MIDDLE"),
        ("TOPPADDING", (0, 0), (-1, 0), 5),
        ("BOTTOMPADDING", (0, 0), (-1, 0), 5),
        ("TOPPADDING", (0, 1), (-1, -1), 7),
        ("BOTTOMPADDING", (0, 1), (-1, -1), 7),
        ("LEFTPADDING", (0, 0), (-1, -1), 4),
        ("RIGHTPADDING", (0, 0), (-1, -1), 4),
    ]))
    _, height = table.wrap(page_width - 36 * mm, 70 * mm)
    top = page_height - 109 * mm
    table.drawOn(c, 18 * mm, top - height)
    return top - height


def draw_totals_and_qr(c: canvas.Canvas, invoice: Invoice, table_bottom: float) -> None:
    page_width, _ = A4
    subtotal = amount(invoice.text("MontoGravadoTotal"))
    itbis = amount(invoice.text("TotalITBIS"))
    total = amount(invoice.text("MontoTotal"))

    totals = Table(
        [
            [paragraph("Subtotal", 7, TA_RIGHT), paragraph(money(subtotal), 7, TA_RIGHT)],
            [paragraph("ITBIS (18%)", 7, TA_RIGHT), paragraph(money(itbis), 7, TA_RIGHT)],
            [paragraph("Total general", 8, TA_RIGHT, True), paragraph(money(total), 8, TA_RIGHT, True)],
        ],
        colWidths=[42 * mm, 38 * mm],
    )
    totals.setStyle(TableStyle([
        ("LINEBELOW", (0, 0), (-1, -1), 0.4, LINE),
        ("LINEABOVE", (0, -1), (-1, -1), 0.9, TECH_BLUE),
        ("TOPPADDING", (0, 0), (-1, -1), 4),
        ("BOTTOMPADDING", (0, 0), (-1, -1), 4),
    ]))
    _, totals_height = totals.wrap(80 * mm, 40 * mm)
    totals_y = table_bottom - totals_height - 5 * mm
    totals.drawOn(c, page_width - 98 * mm, totals_y)

    qr = qrcode.QRCode(
        error_correction=qrcode.constants.ERROR_CORRECT_M,
        border=3,
        box_size=5,
    )
    qr.add_data(qr_url(invoice))
    qr.make(fit=True)
    qr_image = qr.make_image(fill_color="black", back_color="white")
    buffer = io.BytesIO()
    qr_image.save(buffer, format="PNG")
    buffer.seek(0)

    qr_size = 34 * mm
    qr_y = max(78 * mm, table_bottom - qr_size - 6 * mm)
    c.drawImage(ImageReader(buffer), 18 * mm, qr_y, qr_size, qr_size, mask="auto")
    c.setFillColor(DEEP_INDIGO)
    c.setFont("Helvetica-Bold", 6.7)
    c.drawString(18 * mm, qr_y - 4 * mm, f"Código de seguridad: {security_code(invoice)}")
    c.drawString(18 * mm, qr_y - 8 * mm, f"Fecha de firma digital: {invoice.text('FechaHoraFirma')}")


def draw_notes_and_footer(c: canvas.Canvas, invoice: Invoice) -> None:
    page_width, _ = A4
    c.setFillColor(INK)
    c.setFont("Helvetica-Bold", 7)
    c.drawString(18 * mm, 57 * mm, "NOTAS")
    exchange = paragraph(EXCHANGE_NOTE, 6.7, leading=8.7)
    exchange.wrapOn(c, page_width - 36 * mm, 10 * mm)
    exchange.drawOn(c, 18 * mm, 48 * mm)
    transfer = paragraph(TRANSFER_NOTE, 6.7, leading=8.7)
    transfer.wrapOn(c, page_width - 36 * mm, 10 * mm)
    transfer.drawOn(c, 18 * mm, 42 * mm)

    c.setStrokeColor(MUTED)
    c.setLineWidth(0.6)
    c.line(34 * mm, 27 * mm, 74 * mm, 27 * mm)
    c.line(page_width - 74 * mm, 27 * mm, page_width - 34 * mm, 27 * mm)
    c.setFillColor(MUTED)
    c.setFont("Helvetica", 6.2)
    c.drawCentredString(54 * mm, 23.5 * mm, "Firma autorizada")
    c.drawCentredString(page_width - 54 * mm, 23.5 * mm, "Recibido por")

    c.setFont("Helvetica-Oblique", 5.8)
    c.drawString(18 * mm, 10 * mm, "Representación impresa de e-CF - Foster Fiscal")
    c.drawRightString(page_width - 18 * mm, 10 * mm, invoice.text("eNCF"))


def output_name(invoice: Invoice) -> str:
    rnc = invoice.text("RNCComprador")
    slug = BUYER_EXTRAS.get(rnc, {}).get("slug", rnc)
    return f"factura-{slug}-{invoice.text('eNCF')}.pdf"


def generate(invoice: Invoice, destination: Path) -> None:
    c = canvas.Canvas(str(destination), pagesize=A4, pageCompression=1)
    c.setTitle(f"Factura {invoice.text('eNCF')} - {invoice.text('RazonSocialComprador')}")
    c.setAuthor("Foster Fiscal")
    c.setSubject("Representación impresa de Comprobante Fiscal Electrónico")
    draw_header(c, invoice)
    draw_buyer(c, invoice)
    table_bottom = draw_items(c, invoice)
    draw_totals_and_qr(c, invoice, table_bottom)
    draw_notes_and_footer(c, invoice)
    c.showPage()
    c.save()


def main() -> None:
    if not MANIFEST_PATH.exists():
        raise FileNotFoundError(MANIFEST_PATH)
    if not LOGO_PATH.exists():
        raise FileNotFoundError(LOGO_PATH)

    manifest = json.loads(MANIFEST_PATH.read_text(encoding="utf-8"))
    if manifest.get("submittedToDgii") is not False:
        raise ValueError("O manifesto não confirma que os XMLs permanecem sem transmissão.")

    OUTPUT_DIR.mkdir(parents=True, exist_ok=True)
    generated: list[Path] = []
    for entry in manifest["invoices"]:
        source = Path(entry["output"])
        invoice = Invoice(source=source, root=ET.parse(source).getroot())
        if invoice.text("TipoeCF") != "31":
            raise ValueError(f"Tipo e-CF inesperado em {source}")
        if invoice.text("RNCEmisor") != COMPANY_RNC:
            raise ValueError(f"RNC emissor inesperado em {source}")
        destination = OUTPUT_DIR / output_name(invoice)
        generate(invoice, destination)
        generated.append(destination)

    print(json.dumps({
        "submittedToDgii": False,
        "generated": [
            {"path": str(path), "bytes": path.stat().st_size}
            for path in generated
        ],
    }, ensure_ascii=False, indent=2))


if __name__ == "__main__":
    main()
