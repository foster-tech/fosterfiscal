from __future__ import annotations

from dataclasses import dataclass
from decimal import Decimal, ROUND_HALF_UP
from pathlib import Path

from reportlab.lib import colors
from reportlab.lib.enums import TA_LEFT, TA_RIGHT
from reportlab.lib.pagesizes import A4
from reportlab.lib.styles import ParagraphStyle
from reportlab.lib.units import mm
from reportlab.pdfgen import canvas
from reportlab.platypus import Paragraph, Table, TableStyle


ROOT = Path(__file__).resolve().parents[1]
OUTPUT_DIR = ROOT / "output" / "pdf" / "proformas"
LOGO_PATH = Path(
    r"G:\Meu Drive\FosterTech\ReBranding\LOGOS\LOGO FUNDO BRANCO 1.png"
)

DEEP_INDIGO = colors.HexColor("#0B1444")
TECH_BLUE = colors.HexColor("#1E90FF")
INK = colors.HexColor("#101426")
MUTED = colors.HexColor("#536078")
LINE = colors.HexColor("#D7DEE9")
PALE_BLUE = colors.HexColor("#EEF5FF")

COMPANY_NAME = "FOSTERTECH SOLUTIONS SRL"
COMPANY_RNC = "132071506"
COMPANY_ADDRESS = (
    "Calle Máximo Avilés Blonda #12 - IM Plaza Local 2B., "
    "Julieta Morales, República Dominicana"
)
COMPANY_PHONE = "(849) 220-8455"

ISSUE_DATE = "10/11/2026"
VALID_UNTIL = "10/12/2026"
TERMS = "30 días"
USD_AMOUNT = Decimal("4000.00")
EXCHANGE_RATE = Decimal("61.45")
ITBIS_RATE = Decimal("0.18")
SERVICE_DESCRIPTION = (
    "Entrega wireframes, diseño UI/UX y arquitectura y diseño de base de datos"
)
BANK_NOTE = (
    "Instrucciones Transferencias Bancarias: Banco Popular Dominicano, "
    "Cuenta Corriente 817687411."
)


@dataclass(frozen=True)
class Customer:
    number: str
    filename: str
    name: str
    rnc: str
    address: str
    phone: str


CUSTOMERS = [
    Customer(
        number="PF-2026-001",
        filename="proforma-mercasid.pdf",
        name="MERCASID, S.A.",
        rnc="101-80768-7",
        address=(
            "Av. Máximo Gómez #182, Ensanche La Fe, Santo Domingo, "
            "República Dominicana"
        ),
        phone="(809) 381-5121",
    ),
    Customer(
        number="PF-2026-002",
        filename="proforma-induveca.pdf",
        name="INDUVECA, S.A.",
        rnc="122-01122-6",
        address=(
            "Av. Máximo Gómez #182, Ensanche La Fe, Santo Domingo, "
            "República Dominicana"
        ),
        phone="(809) 565-2151",
    ),
]


def quantize(value: Decimal) -> Decimal:
    return value.quantize(Decimal("0.01"), rounding=ROUND_HALF_UP)


BASE_DOP = quantize(USD_AMOUNT * EXCHANGE_RATE)
ITBIS = quantize(BASE_DOP * ITBIS_RATE)
TOTAL_DOP = BASE_DOP + ITBIS


def money(value: Decimal, currency: str = "RD$") -> str:
    return f"{currency}{value:,.2f}"


def paragraph(
    text: str,
    size: float = 8,
    bold: bool = False,
    align: int = TA_LEFT,
    color=INK,
) -> Paragraph:
    font = "Helvetica-Bold" if bold else "Helvetica"
    return Paragraph(
        text,
        ParagraphStyle(
            name=f"p-{font}-{size}-{align}",
            fontName=font,
            fontSize=size,
            leading=size * 1.25,
            alignment=align,
            textColor=color,
            spaceAfter=0,
            spaceBefore=0,
        ),
    )


def draw_company(c: canvas.Canvas) -> None:
    page_width, page_height = A4
    if not LOGO_PATH.exists():
        raise FileNotFoundError(f"Logo não encontrado: {LOGO_PATH}")
    c.drawImage(
        str(LOGO_PATH),
        20 * mm,
        page_height - 41 * mm,
        51 * mm,
        21 * mm,
        preserveAspectRatio=True,
        anchor="w",
        mask="auto",
    )
    c.setFillColor(DEEP_INDIGO)
    c.setFont("Helvetica-Bold", 8)
    c.drawString(20 * mm, page_height - 48 * mm, COMPANY_NAME)
    c.setFont("Helvetica", 7.5)
    c.setFillColor(MUTED)
    company_lines = [
        COMPANY_ADDRESS,
        f"República Dominicana | Tel. {COMPANY_PHONE}",
        f"RNC: {COMPANY_RNC}",
    ]
    y = page_height - 53 * mm
    for line in company_lines:
        p = paragraph(line, 7.5, color=MUTED)
        _, h = p.wrap(92 * mm, 15 * mm)
        p.drawOn(c, 20 * mm, y - h + 2 * mm)
        y -= h + 1.2 * mm


def draw_header(c: canvas.Canvas, customer: Customer) -> None:
    page_width, page_height = A4
    right_x = page_width - 20 * mm
    c.setFillColor(DEEP_INDIGO)
    c.setFont("Helvetica-Bold", 20)
    c.drawRightString(right_x, page_height - 25 * mm, "FACTURA PROFORMA")
    c.setFont("Helvetica-Bold", 8)
    c.setFillColor(TECH_BLUE)
    c.drawRightString(right_x, page_height - 31 * mm, "SIN NCF - SIN VALOR FISCAL")

    rows = [
        ("Proforma No.:", customer.number),
        ("Fecha de emisión:", ISSUE_DATE),
        ("Válida hasta:", VALID_UNTIL),
        ("Términos:", TERMS),
        ("Moneda:", "DOP"),
        ("Referencia:", money(USD_AMOUNT, "USD ")),
    ]
    table = Table(
        [[paragraph(label, 7, align=TA_RIGHT, color=MUTED), paragraph(value, 7, True, TA_RIGHT)] for label, value in rows],
        colWidths=[31 * mm, 42 * mm],
    )
    table.setStyle(
        TableStyle(
            [
                ("VALIGN", (0, 0), (-1, -1), "MIDDLE"),
                ("LEFTPADDING", (0, 0), (-1, -1), 2),
                ("RIGHTPADDING", (0, 0), (-1, -1), 0),
                ("TOPPADDING", (0, 0), (-1, -1), 1.5),
                ("BOTTOMPADDING", (0, 0), (-1, -1), 1.5),
            ]
        )
    )
    _, h = table.wrap(73 * mm, 45 * mm)
    table.drawOn(c, page_width - 93 * mm, page_height - 36 * mm - h)


def draw_customer(c: canvas.Canvas, customer: Customer) -> float:
    page_width, page_height = A4
    top = page_height - 91 * mm
    c.setStrokeColor(LINE)
    c.setLineWidth(0.7)
    c.line(20 * mm, top + 7 * mm, page_width - 20 * mm, top + 7 * mm)
    c.setFillColor(TECH_BLUE)
    c.setFont("Helvetica-Bold", 9)
    c.drawString(20 * mm, top + 1.5 * mm, "FACTURAR A")
    c.setFillColor(INK)
    c.setFont("Helvetica-Bold", 10)
    c.drawString(20 * mm, top - 5 * mm, customer.name)
    c.setFont("Helvetica", 8)
    c.drawString(20 * mm, top - 10 * mm, f"RNC: {customer.rnc}")
    c.drawString(20 * mm, top - 15 * mm, f"Tel.: {customer.phone}")
    address = paragraph(customer.address, 8, color=MUTED)
    _, h = address.wrap(85 * mm, 18 * mm)
    address.drawOn(c, 105 * mm, top - 6 * mm - h)
    return top - 25 * mm


def draw_items(c: canvas.Canvas, top: float) -> float:
    page_width, _ = A4
    data = [
        [
            paragraph("DESCRIPCIÓN", 7.5, True, color=colors.white),
            paragraph("CANT.", 7.5, True, TA_RIGHT, colors.white),
            paragraph("PRECIO", 7.5, True, TA_RIGHT, colors.white),
            paragraph("ITBIS", 7.5, True, TA_RIGHT, colors.white),
            paragraph("TOTAL", 7.5, True, TA_RIGHT, colors.white),
        ],
        [
            paragraph(SERVICE_DESCRIPTION, 8.2, True),
            paragraph("1.00", 8, align=TA_RIGHT),
            paragraph(money(BASE_DOP), 8, align=TA_RIGHT),
            paragraph(money(ITBIS), 8, align=TA_RIGHT),
            paragraph(money(TOTAL_DOP), 8, True, TA_RIGHT),
        ],
    ]
    table = Table(
        data,
        colWidths=[79 * mm, 17 * mm, 25 * mm, 23 * mm, 26 * mm],
    )
    table.setStyle(
        TableStyle(
            [
                ("BACKGROUND", (0, 0), (-1, 0), DEEP_INDIGO),
                ("BACKGROUND", (0, 1), (-1, 1), PALE_BLUE),
                ("GRID", (0, 0), (-1, -1), 0.4, LINE),
                ("VALIGN", (0, 0), (-1, -1), "MIDDLE"),
                ("LEFTPADDING", (0, 0), (-1, -1), 4),
                ("RIGHTPADDING", (0, 0), (-1, -1), 4),
                ("TOPPADDING", (0, 0), (-1, -1), 5),
                ("BOTTOMPADDING", (0, 0), (-1, -1), 5),
            ]
        )
    )
    _, h = table.wrap(page_width - 40 * mm, 50 * mm)
    table.drawOn(c, 20 * mm, top - h)
    return top - h


def draw_totals(c: canvas.Canvas, top: float) -> float:
    page_width, _ = A4
    rows = [
        ("Subtotal", money(BASE_DOP), False),
        ("ITBIS (18%)", money(ITBIS), False),
        ("TOTAL GENERAL", money(TOTAL_DOP), True),
    ]
    table = Table(
        [[paragraph(label, 8, bold, TA_RIGHT), paragraph(value, 8, bold, TA_RIGHT)] for label, value, bold in rows],
        colWidths=[42 * mm, 34 * mm],
    )
    table.setStyle(
        TableStyle(
            [
                ("LINEBELOW", (0, 0), (-1, -1), 0.4, LINE),
                ("LINEABOVE", (0, -1), (-1, -1), 1, DEEP_INDIGO),
                ("BACKGROUND", (0, -1), (-1, -1), PALE_BLUE),
                ("VALIGN", (0, 0), (-1, -1), "MIDDLE"),
                ("TOPPADDING", (0, 0), (-1, -1), 4),
                ("BOTTOMPADDING", (0, 0), (-1, -1), 4),
            ]
        )
    )
    _, h = table.wrap(76 * mm, 35 * mm)
    table.drawOn(c, page_width - 96 * mm, top - h - 3 * mm)
    return top - h - 3 * mm


def draw_notes(c: canvas.Canvas, top: float) -> None:
    page_width, _ = A4
    y = min(top - 16 * mm, 112 * mm)
    c.setFillColor(DEEP_INDIGO)
    c.setFont("Helvetica-Bold", 9)
    c.drawString(20 * mm, y, "NOTAS")
    notes = [
        (
            f"Tasa de conversión utilizada para esta proforma: "
            f"{money(EXCHANGE_RATE)} por USD 1.00."
        ),
        (
            f"Conversión: {money(USD_AMOUNT, 'USD ')} x {money(EXCHANGE_RATE)} "
            f"= {money(BASE_DOP)}."
        ),
        BANK_NOTE,
        "Documento proforma sin NCF y sin valor fiscal.",
    ]
    y -= 6 * mm
    for text in notes:
        p = paragraph(text, 8, color=INK)
        _, h = p.wrap(page_width - 40 * mm, 15 * mm)
        p.drawOn(c, 20 * mm, y - h)
        y -= h + 2.2 * mm

    signature_y = 47 * mm
    c.setStrokeColor(MUTED)
    c.setLineWidth(0.6)
    c.line(35 * mm, signature_y, 78 * mm, signature_y)
    c.line(page_width - 78 * mm, signature_y, page_width - 35 * mm, signature_y)
    c.setFillColor(MUTED)
    c.setFont("Helvetica", 7)
    c.drawCentredString(56.5 * mm, signature_y - 4 * mm, "Firma autorizada")
    c.drawCentredString(page_width - 56.5 * mm, signature_y - 4 * mm, "Aceptación del cliente")


def draw_footer(c: canvas.Canvas, customer: Customer) -> None:
    page_width, _ = A4
    c.setStrokeColor(LINE)
    c.line(20 * mm, 18 * mm, page_width - 20 * mm, 18 * mm)
    c.setFillColor(MUTED)
    c.setFont("Helvetica", 7)
    c.drawString(20 * mm, 12 * mm, "FosterTech Solutions SRL - Factura proforma")
    c.drawRightString(page_width - 20 * mm, 12 * mm, customer.number)


def generate(customer: Customer) -> Path:
    output = OUTPUT_DIR / customer.filename
    c = canvas.Canvas(str(output), pagesize=A4, pageCompression=1)
    c.setTitle(f"Factura proforma {customer.number} - {customer.name}")
    c.setAuthor("FosterTech Solutions SRL")
    draw_company(c)
    draw_header(c, customer)
    top = draw_customer(c, customer)
    top = draw_items(c, top)
    top = draw_totals(c, top)
    draw_notes(c, top)
    draw_footer(c, customer)
    c.showPage()
    c.save()
    return output


def main() -> None:
    OUTPUT_DIR.mkdir(parents=True, exist_ok=True)
    outputs = [generate(customer) for customer in CUSTOMERS]
    print(f"generated={len(outputs)}")
    print(f"base_dop={BASE_DOP}")
    print(f"itbis={ITBIS}")
    print(f"total_dop={TOTAL_DOP}")
    for output in outputs:
        print(f"{output.relative_to(ROOT)}\t{output.stat().st_size}")


if __name__ == "__main__":
    main()
