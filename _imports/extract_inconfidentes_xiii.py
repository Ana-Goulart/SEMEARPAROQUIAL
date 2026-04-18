import json
import re
import xml.etree.ElementTree as ET
import zipfile

XLSX_PATH = "/SemearParoquial/XIII.xlsx"
NS = {"a": "http://schemas.openxmlformats.org/spreadsheetml/2006/main"}


def col_idx(ref):
    m = re.match(r"([A-Z]+)", ref)
    n = 0
    for ch in m.group(1):
        n = n * 26 + ord(ch) - 64
    return n - 1


def excel_serial_to_date(serial):
    from datetime import datetime, timedelta

    base = datetime(1899, 12, 30)
    return (base + timedelta(days=int(float(serial)))).strftime("%Y-%m-%d")


def normalize_date(raw):
    value = str(raw or "").strip()
    if not value:
        return None
    if re.match(r"^\d{1,2}/\d{1,2}/\d{4}$", value):
        d, m, y = value.split("/")
        return f"{int(y):04d}-{int(m):02d}-{int(d):02d}"
    if re.match(r"^\d+(\.\d+)?$", value):
        return excel_serial_to_date(value)
    return None


def strip_accents(value):
    import unicodedata

    return "".join(
        ch for ch in unicodedata.normalize("NFD", str(value or "")) if unicodedata.category(ch) != "Mn"
    )


def normalize_team(raw):
    value = strip_accents(str(raw or "").strip()).lower()
    if not value or value == "nao serviu":
        return None
    if value == "apoio e acolhida":
        return "Apoio e Acolhida"
    if value == "cafezinho":
        return "Cafezinho"
    if value == "cozinha":
        return "Cozinha"
    if value == "financas":
        return "Finanças"
    if value == "liturgia externa":
        return "Liturgia Externa"
    if value == "liturgia interna":
        return "Liturgia Interna"
    if value in ("ordem e limpeza", "ordem"):
        return "Ordem"
    if value == "sala":
        return "Sala"
    if value == "secretaria":
        return "Secretaria"
    return str(raw or "").strip()


def map_circle_name(rgb):
    color = str(rgb or "").upper()
    if color in ("FF00B0F0", "FF0F9ED5"):
        return "Azul"
    if color == "FFFFFF00":
        return "Amarelo"
    if color in ("FFFF3399", "FFFF99FF"):
        return "Rosa"
    if color in ("FF00FF00", "FF00B050", "FF4EA72E"):
        return "Verde"
    if color == "FFFF0000":
        return "Vermelho"
    if color == "FF7F6000":
        return "Marrom"
    return None


def parse_origin(raw):
    value = str(raw or "").strip()
    m = re.match(r"^(\d+)[°º]?\s+(.+)$", value, re.I)
    if not m:
        return {"origem": "INCONFIDENTES", "numero": None, "nome": value or None}
    numero = int(m.group(1))
    nome = m.group(2).strip()
    if strip_accents(nome).lower() == "inconfidentes":
        return {"origem": "INCONFIDENTES", "numero": numero, "nome": "Inconfidentes"}
    return {"origem": "OUTRO_EJC", "numero": numero, "nome": nome}


with zipfile.ZipFile(XLSX_PATH) as z:
    shared_strings = []
    if "xl/sharedStrings.xml" in z.namelist():
        root = ET.fromstring(z.read("xl/sharedStrings.xml"))
        for si in root.findall("a:si", NS):
            shared_strings.append("".join((t.text or "") for t in si.iterfind(".//a:t", NS)))

    styles = ET.fromstring(z.read("xl/styles.xml"))
    fills = []
    for fill in styles.find("a:fills", NS).findall("a:fill", NS):
        patt = fill.find("a:patternFill", NS)
        fg = patt.find("a:fgColor", NS) if patt is not None else None
        fills.append((fg.attrib.get("rgb") if fg is not None else None))
    cell_xfs = [xf.attrib.get("fillId") for xf in styles.find("a:cellXfs", NS).findall("a:xf", NS)]

    sheet = ET.fromstring(z.read("xl/worksheets/sheet1.xml"))
    rows = []
    for row in sheet.findall(".//a:sheetData/a:row", NS):
        vals = []
        styles_map = {}
        for c in row.findall("a:c", NS):
            idx = col_idx(c.attrib["r"])
            while len(vals) <= idx:
                vals.append("")
            v = c.find("a:v", NS)
            if v is None:
                value = ""
            elif c.attrib.get("t") == "s":
                value = shared_strings[int(v.text)]
            else:
                value = v.text or ""
            vals[idx] = value
            if "s" in c.attrib:
                styles_map[idx] = int(c.attrib["s"])
        rows.append((vals, styles_map))

headers = rows[0][0]
items = []

for vals, styles_map in rows[1:]:
    if not "".join(vals).strip():
        continue
    while len(vals) < len(headers):
        vals.append("")

    color_rgb = None
    if 6 in styles_map:
        fill_id = cell_xfs[styles_map[6]]
        color_rgb = fills[int(fill_id)] if fill_id is not None else None

    historico = []
    for i in range(9, len(headers)):
        equipe = normalize_team(vals[i])
        if not equipe:
            continue
        num_match = re.search(r"(\d+)", str(headers[i] or ""))
        if not num_match:
            continue
        historico.append({"numero": int(num_match.group(1)), "equipe": equipe})

    items.append(
        {
            "nome": str(vals[0] or "").strip(),
            "telefone": str(vals[8] or "").strip() or None,
            "instagram": str(vals[3] or "").strip() or None,
            "data_nascimento": normalize_date(vals[1]),
            "circulo": map_circle_name(color_rgb),
            "origemInfo": parse_origin(vals[7]),
            "historico": historico,
        }
    )

print(json.dumps(items, ensure_ascii=False))
