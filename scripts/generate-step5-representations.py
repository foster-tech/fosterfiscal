from __future__ import annotations

import io
import shutil
import textwrap
import urllib.parse
import xml.etree.ElementTree as ET
from dataclasses import dataclass
from decimal import Decimal, InvalidOperation
from pathlib import Path

import qrcode
from reportlab.lib import colors
from reportlab.lib.enums import TA_CENTER, TA_LEFT, TA_RIGHT
from reportlab.lib.pagesizes import A4
from reportlab.lib.styles import ParagraphStyle
from reportlab.lib.units import mm
from reportlab.pdfgen import canvas
from reportlab.platypus import Paragraph, Table, TableStyle


ROOT = Path(__file__).resolve().parents[1]
OUTPUT_DIR = ROOT / "output" / "pdf" / "dgii-step5"
RENDER_DIR = ROOT / "tmp" / "pdfs" / "dgii-step5-rendered"
LOGO_PATH = Path(
    r"G:\Meu Drive\FosterTech\ReBranding\LOGOS\LOGO FUNDO BRANCO 1.png"
)

DEEP_INDIGO = colors.HexColor("#0B1444")
TECH_BLUE = colors.HexColor("#1E90FF")
CYAN = colors.HexColor("#00E5FF")
VIOLET = colors.HexColor("#7A2CFF")
INK = colors.HexColor("#101426")
MUTED = colors.HexColor("#536078")
PALE_BLUE = colors.HexColor("#EEF5FF")
PALE_CYAN = colors.HexColor("#E9FCFF")

COMPANY_NAME = "FOSTERTECH SOLUTIONS SRL"
COMPANY_RNC = "132071506"
COMPANY_ADDRESS_LINE_1 = (
    "Calle Máximo Avilés Blonda #12 - IM Plaza Local 2B., Julieta Morales"
)
COMPANY_ADDRESS_LINE_2 = "República Dominicana"
COMPANY_PHONE = "Tel. (849) 220-8455"
BANK_NOTE = (
    "Instrucciones Transferencias Bancaria: Banco Popular Dominicano "
    "Cuenta Corriente 817687411"
)

COMPLETION = (
    ROOT
    / "examples"
    / "certificacion"
    / "simulation"
    / "completion"
    / "generated"
    / "2026-11-03T23-28-52-410Z"
)
RECOVERY = (
    ROOT
    / "examples"
    / "certificacion"
    / "simulation"
    / "recovery"
    / "generated"
    / "2026-11-03T22-53-31-847Z"
)

TYPE_NAMES = {
    "31": "Factura de Crédito Fiscal Electrónica",
    "32": "Factura de Consumo Electrónica",
    "33": "Nota de Débito Electrónica",
    "34": "Nota de Crédito Electrónica",
    "41": "Comprobante Electrónico de Compras",
    "43": "Comprobante Electrónico para Gastos Menores",
    "44": "Comprobante Electrónico para Regímenes Especiales",
    "45": "Comprobante Electrónico Gubernamental",
    "46": "Comprobante Electrónico para Exportaciones",
    "47": "Comprobante Electrónico para Pagos al Exterior",
}

MODIFICATION_NAMES = {
    "1": "Anula el NCF modificado",
    "2": "Corrige texto del comprobante fiscal modificado",
    "3": "Corrige montos del NCF modificado",
    "4": "Reemplazo de NCF emitido en contingencia",
}

# The XML stores the DGII unit code. Showing the code avoids changing the
# certified source data when no textual catalogue is embedded in the e-CF.
UNIT_LABELS = {
    "": "-",
    "1": "Código 1",
    "23": "Código 23",
    "31": "Código 31",
    "55": "Código 55",
}

SOURCES = [
    (
        "01-tipo-31.pdf",
        COMPLETION / "01-envio-ecf" / "132071506E310009000101.xml",
        "31",
    ),
    (
        "02-tipo-32-mayor-igual-250mil.pdf",
        COMPLETION / "01-envio-ecf" / "132071506E320009000101.xml",
        "32-ge",
    ),
    (
        "03-tipo-33.pdf",
        RECOVERY / "01-envio-ecf" / "132071506E330009000001.xml",
        "33",
    ),
    (
        "04-tipo-34.pdf",
        RECOVERY / "01-envio-ecf" / "132071506E340009000001.xml",
        "34",
    ),
    (
        "05-tipo-41.pdf",
        COMPLETION / "01-envio-ecf" / "132071506E410009000101.xml",
        "41",
    ),
    (
        "06-tipo-43.pdf",
        COMPLETION / "01-envio-ecf" / "132071506E430009000101.xml",
        "43",
    ),
    (
        "07-tipo-44.pdf",
        COMPLETION / "01-envio-ecf" / "132071506E440009000101.xml",
        "44",
    ),
    (
        "08-tipo-45.pdf",
        COMPLETION / "01-envio-ecf" / "132071506E450009000101.xml",
        "45",
    ),
    (
        "09-tipo-46.pdf",
        RECOVERY / "01-envio-ecf" / "132071506E460009000001.xml",
        "46",
    ),
    (
        "10-tipo-47.pdf",
        RECOVERY / "01-envio-ecf" / "132071506E470009000001.xml",
        "47",
    ),
    (
        "11-tipo-32-menor-250mil.pdf",
        COMPLETION
        / "03-upload-manual-ecf32"
        / "132071506E320009000102.xml",
        "32-lt",
    ),
]


@dataclass(frozen=True)
class Invoice:
    source: Path
    kind: str
    root: ET.Element

    def text(self, tag: str, default: str = "") -> str:
        element = self.root.find(f".//{tag}")
        return (element.text or "").strip() if element is not None else default

    def items(self) -> list[ET.Element]:
        return list(self.root.findall(".//DetallesItems/Item"))


def decimal(value: str) -> Decimal:
    try:
        return Decimal(value or "0")
    except InvalidOperation:
        return Decimal("0")


def money(value: str | Decimal) -> str:
    amount = value if isinstance(value, Decimal) else decimal(value)
    return f"{amount:,.2f}"


def item_text(item: ET.Element, tag: str, default: str = "") -> str:
    element = item.find(tag)
    return (element.text or "").strip() if element is not None else default


def item_itbis(item: ET.Element) -> Decimal:
    for tag in ("ITBISItem", "MontoITBIS", "MontoITBISItem"):
        value = item_text(item, tag)
        if value:
            return decimal(value)
    indicator = item_text(item, "IndicadorFacturacion")
    if indicator == "1":
        return (decimal(item_text(item, "MontoItem")) * Decimal("0.18")).quantize(
            Decimal("0.01")
        )
    if indicator == "2":
        return (decimal(item_text(item, "MontoItem")) * Decimal("0.16")).quantize(
            Decimal("0.01")
        )
    return Decimal("0")


def signature_value(invoice: Invoice) -> str:
    for element in invoice.root.iter():
        if element.tag.split("}")[-1] == "SignatureValue":
            return (element.text or "").strip()
    raise ValueError(f"SignatureValue ausente em {invoice.source}")


def security_code(invoice: Invoice) -> str:
    value = signature_value(invoice)
    if len(value) < 6:
        raise ValueError(f"SignatureValue inválido em {invoice.source}")
    return value[:6]


def qr_url(invoice: Invoice) -> str:
    total = f"{decimal(invoice.text('MontoTotal')):.2f}"
    code = security_code(invoice)
    if invoice.kind == "32-lt":
        query = urllib.parse.urlencode(
            {
                "rncemisor": invoice.text("RNCEmisor"),
                "encf": invoice.text("eNCF"),
                "montototal": total,
                "codigoseguridad": code,
            },
            quote_via=urllib.parse.quote,
        )
        return f"https://fc.dgii.gov.do/certecf/consultatimbrefc?{query}"

    parameters = [("rncemisor", invoice.text("RNCEmisor"))]
    rnc_buyer = invoice.text("RNCComprador")
    if rnc_buyer:
        parameters.append(("rnccomprador", rnc_buyer))
    parameters.extend(
        [
            ("encf", invoice.text("eNCF")),
            ("fechaemision", invoice.text("FechaEmision")),
            ("montototal", total),
            ("fechafirma", invoice.text("FechaHoraFirma")),
            ("codigoseguridad", code),
        ]
    )

    query = urllib.parse.urlencode(
        parameters,
        quote_via=urllib.parse.quote,
    )
    return f"https://ecf.dgii.gov.do/certecf/consultatimbre?{query}"


def paragraph(
    text: str,
    size: float = 7.5,
    align: int = TA_LEFT,
    bold: bool = False,
    text_color=INK,
):
    font = "Helvetica-Bold" if bold else "Helvetica"
    style = ParagraphStyle(
        name=f"p-{size}-{align}-{bold}",
        fontName=font,
        fontSize=size,
        leading=size + 1.8,
        alignment=align,
        textColor=text_color,
        wordWrap="CJK",
    )
    safe = (
        str(text)
        .replace("&", "&amp;")
        .replace("<", "&lt;")
        .replace(">", "&gt;")
    )
    return Paragraph(safe, style)


def draw_wrapped(c: canvas.Canvas, text: str, x: float, y: float, width_chars: int):
    c.setFont("Helvetica", 7.2)
    for line in textwrap.wrap(text, width=width_chars)[:3]:
        c.drawString(x, y, line)
        y -= 9


def draw_header(c: canvas.Canvas, invoice: Invoice):
    page_width, page_height = A4
    from reportlab.lib.utils import ImageReader

    if not LOGO_PATH.exists():
        raise FileNotFoundError(f"Logo da FosterTech não encontrado: {LOGO_PATH}")
    c.drawImage(
        ImageReader(LOGO_PATH),
        20 * mm,
        page_height - 35 * mm,
        58 * mm,
        21 * mm,
        preserveAspectRatio=True,
        anchor="sw",
        mask="auto",
    )

    title = TYPE_NAMES[invoice.text("TipoeCF")]
    title_p = paragraph(title, 15, TA_RIGHT, True, INK)
    title_width = 82 * mm
    title_p.wrapOn(c, title_width, 20 * mm)
    title_p.drawOn(c, page_width - 20 * mm - title_width, page_height - 26 * mm)

    meta_label_x = page_width - 96 * mm
    meta_value_x = page_width - 20 * mm
    meta_y = page_height - 36 * mm
    metadata = [
        ("Factura No.:", invoice.text("NumeroFacturaInterna") or invoice.text("eNCF")),
        ("Tipo comprobante:", title),
        ("e-NCF:", invoice.text("eNCF")),
        ("Fecha emisión:", invoice.text("FechaEmision")),
    ]
    for label, value in metadata:
        c.setFillColor(MUTED)
        c.setFont("Helvetica", 6.4)
        c.drawRightString(meta_label_x, meta_y, label)
        c.setFillColor(INK)
        c.setFont("Helvetica-Bold", 6.4)
        c.drawRightString(meta_value_x, meta_y, value)
        meta_y -= 4 * mm

    if invoice.text("FechaVencimientoSecuencia"):
        c.setFillColor(MUTED)
        c.setFont("Helvetica", 6.4)
        c.drawRightString(meta_label_x, meta_y, "Vence secuencia:")
        c.setFillColor(INK)
        c.setFont("Helvetica-Bold", 6.4)
        c.drawRightString(meta_value_x, meta_y, invoice.text("FechaVencimientoSecuencia"))
        meta_y -= 4 * mm

    if invoice.text("NCFModificado"):
        c.setFillColor(MUTED)
        c.setFont("Helvetica", 6.4)
        c.drawRightString(meta_label_x, meta_y, "NCF modificado:")
        c.setFillColor(INK)
        c.setFont("Helvetica-Bold", 6.4)
        c.drawRightString(meta_value_x, meta_y, invoice.text("NCFModificado"))
        meta_y -= 4 * mm
        modification = MODIFICATION_NAMES.get(
            invoice.text("CodigoModificacion"),
            f"Código de modificación {invoice.text('CodigoModificacion')}",
        )
        c.setFont("Helvetica", 6.2)
        c.drawRightString(meta_value_x, meta_y, modification)

    company_y = page_height - 48 * mm
    c.setFillColor(MUTED)
    c.setFont("Helvetica-Bold", 6.8)
    c.drawString(20 * mm, company_y, COMPANY_NAME)
    c.setFont("Helvetica", 6.4)
    c.drawString(20 * mm, company_y - 4 * mm, COMPANY_ADDRESS_LINE_1)
    c.drawString(20 * mm, company_y - 8 * mm, COMPANY_ADDRESS_LINE_2)
    c.drawString(20 * mm, company_y - 12 * mm, COMPANY_PHONE)
    c.setFillColor(INK)
    c.setFont("Helvetica-Bold", 6.8)
    c.drawString(20 * mm, company_y - 17 * mm, f"RNC: {COMPANY_RNC}")
    c.drawString(20 * mm, company_y - 21 * mm, f"FECHA EMISIÓN: {invoice.text('FechaEmision')}")

    c.setStrokeColor(colors.HexColor("#D7DEE9"))
    c.setLineWidth(0.5)
    c.line(20 * mm, page_height - 72 * mm, page_width - 20 * mm, page_height - 72 * mm)


def draw_buyer(c: canvas.Canvas, invoice: Invoice):
    page_width, page_height = A4
    y = page_height - 78 * mm
    buyer = invoice.text("RazonSocialComprador") or "No informado"
    rnc = invoice.text("RNCComprador") or "No informado"
    address = invoice.text("DireccionComprador") or "Dirección no informada"

    c.setFillColor(MUTED)
    c.setFont("Helvetica", 6.8)
    c.drawString(20 * mm, y, "Facturar a")
    c.setFillColor(INK)
    c.setFont("Helvetica-Bold", 7.2)
    c.drawString(20 * mm, y - 5 * mm, buyer)
    c.drawString(20 * mm, y - 9 * mm, f"RNC: {rnc}")

    c.setFont("Helvetica", 6.6)
    address_y = y - 5 * mm
    for line in textwrap.wrap(address, width=62)[:3]:
        c.drawString(105 * mm, address_y, line)
        address_y -= 4 * mm

    c.setStrokeColor(colors.HexColor("#D7DEE9"))
    c.setLineWidth(0.5)
    c.line(20 * mm, y - 15 * mm, page_width - 20 * mm, y - 15 * mm)


def draw_items(c: canvas.Canvas, invoice: Invoice) -> float:
    page_width, page_height = A4
    rows = [[
        paragraph("Cant.", 7, TA_CENTER, True, colors.white),
        paragraph("Descripción", 7, TA_CENTER, True, colors.white),
        paragraph("Unidad de medida", 7, TA_CENTER, True, colors.white),
        paragraph("Precio", 7, TA_CENTER, True, colors.white),
        paragraph("ITBIS", 7, TA_CENTER, True, colors.white),
        paragraph("Valor", 7, TA_CENTER, True, colors.white),
    ]]
    for item in invoice.items():
        indicator = item_text(item, "IndicadorFacturacion")
        name = item_text(item, "NombreItem")
        if indicator == "4":
            name = f"E  {name}"
        unit = item_text(item, "UnidadMedida")
        rows.append(
            [
                paragraph(item_text(item, "CantidadItem"), 6.8, TA_RIGHT),
                paragraph(name, 6.8),
                paragraph(UNIT_LABELS.get(unit, f"Código {unit}"), 6.6, TA_CENTER),
                paragraph(money(item_text(item, "PrecioUnitarioItem")), 6.8, TA_RIGHT),
                paragraph(money(item_itbis(item)), 6.8, TA_RIGHT),
                paragraph(money(item_text(item, "MontoItem")), 6.8, TA_RIGHT),
            ]
        )

    available_width = page_width - 40 * mm
    table = Table(
        rows,
        colWidths=[15 * mm, 65 * mm, 24 * mm, 24 * mm, 22 * mm, 26 * mm],
        repeatRows=1,
    )
    table.setStyle(
        TableStyle(
            [
                ("BACKGROUND", (0, 0), (-1, 0), colors.HexColor("#356FB4")),
                ("TEXTCOLOR", (0, 0), (-1, 0), colors.white),
                ("BACKGROUND", (0, 1), (-1, -1), colors.white),
                ("ROWBACKGROUNDS", (0, 1), (-1, -1), [colors.white, colors.HexColor("#F4F5F7")]),
                ("GRID", (0, 0), (-1, -1), 0.35, colors.HexColor("#D0D5DD")),
                ("VALIGN", (0, 0), (-1, -1), "MIDDLE"),
                ("TOPPADDING", (0, 0), (-1, -1), 3),
                ("BOTTOMPADDING", (0, 0), (-1, -1), 3),
                ("LEFTPADDING", (0, 0), (-1, -1), 3),
                ("RIGHTPADDING", (0, 0), (-1, -1), 3),
            ]
        )
    )
    _, height = table.wrap(available_width, 100 * mm)
    top = page_height - 100 * mm
    table.drawOn(c, 20 * mm, top - height)
    return top - height


def draw_totals_and_qr(c: canvas.Canvas, invoice: Invoice, table_bottom: float):
    page_width, _ = A4
    divider_y = table_bottom - 3 * mm

    totals = []
    if decimal(invoice.text("MontoGravadoTotal")):
        totals.append(("Subtotal gravado", invoice.text("MontoGravadoTotal")))
    if decimal(invoice.text("MontoExento")):
        totals.append(("Subtotal exento", invoice.text("MontoExento")))
    if decimal(invoice.text("TotalITBIS")):
        totals.append(("Total ITBIS", invoice.text("TotalITBIS")))
    if decimal(invoice.text("MontoImpuestoAdicional")):
        totals.append(("Total impuestos adicionales", invoice.text("MontoImpuestoAdicional")))
    totals.append(("TOTAL", invoice.text("MontoTotal")))

    table = Table(
        [[paragraph(label, 7.2, TA_RIGHT, label == "TOTAL"), paragraph(money(value), 7.2, TA_RIGHT, label == "TOTAL")] for label, value in totals],
        colWidths=[45 * mm, 31 * mm],
    )
    table.setStyle(
        TableStyle(
            [
                ("LINEBELOW", (0, 0), (-1, -1), 0.35, colors.HexColor("#D7DEE9")),
                ("BACKGROUND", (0, -1), (-1, -1), colors.white),
                ("LINEABOVE", (0, -1), (-1, -1), 0.8, colors.HexColor("#D7DEE9")),
                ("VALIGN", (0, 0), (-1, -1), "MIDDLE"),
                ("TOPPADDING", (0, 0), (-1, -1), 2.5),
                ("BOTTOMPADDING", (0, 0), (-1, -1), 2.5),
            ]
        )
    )
    _, height = table.wrap(76 * mm, 45 * mm)
    table.drawOn(c, page_width - 96 * mm, divider_y - 2 * mm - height)

    qr = qrcode.QRCode(error_correction=qrcode.constants.ERROR_CORRECT_M, border=3, box_size=5)
    qr.add_data(qr_url(invoice))
    qr.make(fit=True)
    qr_image = qr.make_image(fill_color="black", back_color="white")
    buffer = io.BytesIO()
    qr_image.save(buffer, format="PNG")
    buffer.seek(0)
    from reportlab.lib.utils import ImageReader

    qr_x = 20 * mm
    qr_size = 32 * mm
    qr_y = max(74 * mm, divider_y - qr_size - 5 * mm)
    c.drawImage(ImageReader(buffer), qr_x, qr_y, qr_size, qr_size, mask="auto")
    c.setFillColor(DEEP_INDIGO)
    c.setFont("Helvetica-Bold", 7.2)
    c.drawString(qr_x, qr_y - 4 * mm, f"Código de seguridad: {security_code(invoice)}")
    c.drawString(qr_x, qr_y - 8 * mm, f"Fecha de firma digital: {invoice.text('FechaHoraFirma')}")


def draw_notes_and_signatures(c: canvas.Canvas):
    page_width, _ = A4
    c.setFillColor(INK)
    c.setFont("Helvetica-Bold", 7.2)
    c.drawString(20 * mm, 54 * mm, "NOTAS")
    note = paragraph(BANK_NOTE, 6.8, TA_LEFT, False, INK)
    note.wrapOn(c, page_width - 40 * mm, 12 * mm)
    note.drawOn(c, 20 * mm, 45 * mm)

    c.setStrokeColor(MUTED)
    c.setLineWidth(0.6)
    c.line(34 * mm, 27 * mm, 72 * mm, 27 * mm)
    c.line(page_width - 72 * mm, 27 * mm, page_width - 34 * mm, 27 * mm)
    c.setFillColor(MUTED)
    c.setFont("Helvetica", 6.4)
    c.drawCentredString(53 * mm, 23.5 * mm, "Firma autorizada")
    c.drawCentredString(page_width - 53 * mm, 23.5 * mm, "Recibido por")


def draw_footer(c: canvas.Canvas, invoice: Invoice):
    page_width, _ = A4
    c.setFillColor(MUTED)
    c.setFont("Helvetica-Oblique", 5.8)
    c.drawString(20 * mm, 11 * mm, "Representación impresa de certificación - Foster Fiscal")
    c.drawRightString(page_width - 20 * mm, 11 * mm, invoice.source.name)


def generate_pdf(invoice: Invoice, output: Path):
    c = canvas.Canvas(str(output), pagesize=A4, pageCompression=1)
    c.setTitle(f"{TYPE_NAMES[invoice.text('TipoeCF')]} - {invoice.text('eNCF')}")
    c.setAuthor("Foster Fiscal")
    draw_footer(c, invoice)
    draw_header(c, invoice)
    draw_buyer(c, invoice)
    bottom = draw_items(c, invoice)
    draw_totals_and_qr(c, invoice, bottom)
    draw_notes_and_signatures(c)
    c.showPage()
    c.save()


def main():
    if not LOGO_PATH.exists():
        raise FileNotFoundError(f"Logo da FosterTech não encontrado: {LOGO_PATH}")
    shutil.rmtree(OUTPUT_DIR, ignore_errors=True)
    shutil.rmtree(RENDER_DIR, ignore_errors=True)
    OUTPUT_DIR.mkdir(parents=True, exist_ok=True)
    RENDER_DIR.mkdir(parents=True, exist_ok=True)

    generated = []
    for filename, source, kind in SOURCES:
        if not source.exists():
            raise FileNotFoundError(source)
        invoice = Invoice(source=source, kind=kind, root=ET.parse(source).getroot())
        expected_type = kind.split("-")[0]
        if invoice.text("TipoeCF") != expected_type:
            raise ValueError(f"Tipo inesperado em {source}: {invoice.text('TipoeCF')}")
        output = OUTPUT_DIR / filename
        generate_pdf(invoice, output)
        generated.append(output)

    total_bytes = sum(path.stat().st_size for path in generated)
    if total_bytes >= 10 * 1024 * 1024:
        raise ValueError(f"Conjunto excede 10 MB: {total_bytes} bytes")

    print(f"generated={len(generated)}")
    print(f"total_bytes={total_bytes}")
    for path in generated:
        print(f"{path.relative_to(ROOT)}\t{path.stat().st_size}")


if __name__ == "__main__":
    main()
