#!/usr/bin/env python3
import io
import json
import sys
import zipfile
from datetime import datetime, timezone
from xml.sax.saxutils import escape


NS_CP = "http://schemas.openxmlformats.org/package/2006/metadata/core-properties"
NS_DC = "http://purl.org/dc/elements/1.1/"
NS_DCTERMS = "http://purl.org/dc/terms/"
NS_DCMITYPE = "http://purl.org/dc/dcmitype/"
NS_XSI = "http://www.w3.org/2001/XMLSchema-instance"


def xml_escape(value: str) -> str:
    return escape(value or "", {'"': '&quot;', "'": '&apos;'})


def build_content_types(slide_count: int) -> str:
    slides = "".join(
        f'<Override PartName="/ppt/slides/slide{i}.xml" ContentType="application/vnd.openxmlformats-officedocument.presentationml.slide+xml"/>'
        for i in range(1, slide_count + 1)
    )
    return (
        '<?xml version="1.0" encoding="UTF-8" standalone="yes"?>'
        '<Types xmlns="http://schemas.openxmlformats.org/package/2006/content-types">'
        '<Default Extension="rels" ContentType="application/vnd.openxmlformats-package.relationships+xml"/>'
        '<Default Extension="xml" ContentType="application/xml"/>'
        '<Override PartName="/ppt/presentation.xml" ContentType="application/vnd.openxmlformats-officedocument.presentationml.presentation.main+xml"/>'
        '<Override PartName="/ppt/slideMasters/slideMaster1.xml" ContentType="application/vnd.openxmlformats-officedocument.presentationml.slideMaster+xml"/>'
        '<Override PartName="/ppt/slideLayouts/slideLayout1.xml" ContentType="application/vnd.openxmlformats-officedocument.presentationml.slideLayout+xml"/>'
        '<Override PartName="/ppt/theme/theme1.xml" ContentType="application/vnd.openxmlformats-officedocument.theme+xml"/>'
        f'{slides}'
        '<Override PartName="/docProps/core.xml" ContentType="application/vnd.openxmlformats-package.core-properties+xml"/>'
        '<Override PartName="/docProps/app.xml" ContentType="application/vnd.openxmlformats-officedocument.extended-properties+xml"/>'
        '<Override PartName="/ppt/presProps.xml" ContentType="application/vnd.openxmlformats-officedocument.presentationml.presProps+xml"/>'
        '<Override PartName="/ppt/viewProps.xml" ContentType="application/vnd.openxmlformats-officedocument.presentationml.viewProps+xml"/>'
        '<Override PartName="/ppt/tableStyles.xml" ContentType="application/vnd.openxmlformats-officedocument.presentationml.tableStyles+xml"/>'
        '</Types>'
    )


def build_root_rels() -> str:
    return (
        '<?xml version="1.0" encoding="UTF-8" standalone="yes"?>'
        '<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships">'
        '<Relationship Id="rId1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/officeDocument" Target="ppt/presentation.xml"/>'
        '<Relationship Id="rId2" Type="http://schemas.openxmlformats.org/package/2006/relationships/metadata/core-properties" Target="docProps/core.xml"/>'
        '<Relationship Id="rId3" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/extended-properties" Target="docProps/app.xml"/>'
        '</Relationships>'
    )


def build_app_xml(slide_count: int) -> str:
    return (
        '<?xml version="1.0" encoding="UTF-8" standalone="yes"?>'
        '<Properties xmlns="http://schemas.openxmlformats.org/officeDocument/2006/extended-properties" '
        'xmlns:vt="http://schemas.openxmlformats.org/officeDocument/2006/docPropsVTypes">'
        '<Application>EJC</Application>'
        '<PresentationFormat>Widescreen</PresentationFormat>'
        f'<Slides>{slide_count}</Slides>'
        '<Notes>0</Notes>'
        '<HiddenSlides>0</HiddenSlides>'
        '<MMClips>0</MMClips>'
        '<ScaleCrop>false</ScaleCrop>'
        '<HeadingPairs><vt:vector size="2" baseType="variant"><vt:variant><vt:lpstr>Slides</vt:lpstr></vt:variant><vt:variant><vt:i4>'
        f'{slide_count}'
        '</vt:i4></vt:variant></vt:vector></HeadingPairs>'
        '<TitlesOfParts><vt:vector size="1" baseType="lpstr"><vt:lpstr>Montagem</vt:lpstr></vt:vector></TitlesOfParts>'
        '<Company></Company>'
        '<LinksUpToDate>false</LinksUpToDate>'
        '<SharedDoc>false</SharedDoc>'
        '<HyperlinksChanged>false</HyperlinksChanged>'
        '<AppVersion>1.0</AppVersion>'
        '</Properties>'
    )


def build_core_xml() -> str:
    created = datetime.now(timezone.utc).replace(microsecond=0).isoformat().replace("+00:00", "Z")
    return (
        '<?xml version="1.0" encoding="UTF-8" standalone="yes"?>'
        f'<cp:coreProperties xmlns:cp="{NS_CP}" xmlns:dc="{NS_DC}" xmlns:dcterms="{NS_DCTERMS}" '
        f'xmlns:dcmitype="{NS_DCMITYPE}" xmlns:xsi="{NS_XSI}">'
        '<dc:title>Montagem de Encontro - Aceitos</dc:title>'
        '<dc:creator>EJC</dc:creator>'
        '<cp:lastModifiedBy>EJC</cp:lastModifiedBy>'
        f'<dcterms:created xsi:type="dcterms:W3CDTF">{created}</dcterms:created>'
        f'<dcterms:modified xsi:type="dcterms:W3CDTF">{created}</dcterms:modified>'
        '</cp:coreProperties>'
    )


def build_presentation_xml(slide_count: int) -> str:
    slide_ids = []
    base_id = 256
    for i in range(1, slide_count + 1):
        slide_ids.append(f'<p:sldId id="{base_id + i - 1}" r:id="rId{i + 1}"/>')

    return (
        '<?xml version="1.0" encoding="UTF-8" standalone="yes"?>'
        '<p:presentation xmlns:a="http://schemas.openxmlformats.org/drawingml/2006/main" '
        'xmlns:r="http://schemas.openxmlformats.org/officeDocument/2006/relationships" '
        'xmlns:p="http://schemas.openxmlformats.org/presentationml/2006/main">'
        '<p:sldMasterIdLst><p:sldMasterId id="2147483648" r:id="rId1"/></p:sldMasterIdLst>'
        f'<p:sldIdLst>{"".join(slide_ids)}</p:sldIdLst>'
        '<p:sldSz cx="12192000" cy="6858000" type="screen16x9"/>'
        '<p:notesSz cx="6858000" cy="9144000"/>'
        '<p:defaultTextStyle/>'
        '</p:presentation>'
    )


def build_presentation_rels(slide_count: int) -> str:
    rels = [
        '<Relationship Id="rId1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/slideMaster" Target="slideMasters/slideMaster1.xml"/>'
    ]
    for i in range(1, slide_count + 1):
        rels.append(
            f'<Relationship Id="rId{i + 1}" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/slide" Target="slides/slide{i}.xml"/>'
        )

    next_id = slide_count + 2
    rels.append(f'<Relationship Id="rId{next_id}" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/presProps" Target="presProps.xml"/>')
    rels.append(f'<Relationship Id="rId{next_id + 1}" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/viewProps" Target="viewProps.xml"/>')
    rels.append(f'<Relationship Id="rId{next_id + 2}" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/tableStyles" Target="tableStyles.xml"/>')

    return (
        '<?xml version="1.0" encoding="UTF-8" standalone="yes"?>'
        '<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships">'
        f'{"".join(rels)}'
        '</Relationships>'
    )


def build_slide_master_xml() -> str:
    return (
        '<?xml version="1.0" encoding="UTF-8" standalone="yes"?>'
        '<p:sldMaster xmlns:a="http://schemas.openxmlformats.org/drawingml/2006/main" '
        'xmlns:r="http://schemas.openxmlformats.org/officeDocument/2006/relationships" '
        'xmlns:p="http://schemas.openxmlformats.org/presentationml/2006/main">'
        '<p:cSld name="Slide Master">'
        '<p:bg><p:bgPr><a:solidFill><a:schemeClr val="bg1"/></a:solidFill><a:effectLst/></p:bgPr></p:bg>'
        '<p:spTree>'
        '<p:nvGrpSpPr><p:cNvPr id="1" name=""/><p:cNvGrpSpPr/><p:nvPr/></p:nvGrpSpPr>'
        '<p:grpSpPr><a:xfrm><a:off x="0" y="0"/><a:ext cx="0" cy="0"/><a:chOff x="0" y="0"/><a:chExt cx="0" cy="0"/></a:xfrm></p:grpSpPr>'
        '</p:spTree>'
        '</p:cSld>'
        '<p:clrMap bg1="lt1" tx1="dk1" bg2="lt2" tx2="dk2" accent1="accent1" accent2="accent2" accent3="accent3" accent4="accent4" accent5="accent5" accent6="accent6" hlink="hlink" folHlink="folHlink"/>'
        '<p:sldLayoutIdLst><p:sldLayoutId id="2147483649" r:id="rId1"/></p:sldLayoutIdLst>'
        '<p:txStyles>'
        '<p:titleStyle><a:lvl1pPr algn="l"/></p:titleStyle>'
        '<p:bodyStyle><a:lvl1pPr marL="0" indent="0"/></p:bodyStyle>'
        '<p:otherStyle><a:defPPr/></p:otherStyle>'
        '</p:txStyles>'
        '</p:sldMaster>'
    )


def build_slide_master_rels() -> str:
    return (
        '<?xml version="1.0" encoding="UTF-8" standalone="yes"?>'
        '<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships">'
        '<Relationship Id="rId1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/slideLayout" Target="../slideLayouts/slideLayout1.xml"/>'
        '<Relationship Id="rId2" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/theme" Target="../theme/theme1.xml"/>'
        '</Relationships>'
    )


def build_slide_layout_xml() -> str:
    return (
        '<?xml version="1.0" encoding="UTF-8" standalone="yes"?>'
        '<p:sldLayout xmlns:a="http://schemas.openxmlformats.org/drawingml/2006/main" '
        'xmlns:r="http://schemas.openxmlformats.org/officeDocument/2006/relationships" '
        'xmlns:p="http://schemas.openxmlformats.org/presentationml/2006/main" type="blank" preserve="1">'
        '<p:cSld name="Blank">'
        '<p:spTree>'
        '<p:nvGrpSpPr><p:cNvPr id="1" name=""/><p:cNvGrpSpPr/><p:nvPr/></p:nvGrpSpPr>'
        '<p:grpSpPr><a:xfrm><a:off x="0" y="0"/><a:ext cx="0" cy="0"/><a:chOff x="0" y="0"/><a:chExt cx="0" cy="0"/></a:xfrm></p:grpSpPr>'
        '</p:spTree>'
        '</p:cSld>'
        '<p:clrMapOvr><a:masterClrMapping/></p:clrMapOvr>'
        '</p:sldLayout>'
    )


def build_slide_layout_rels() -> str:
    return (
        '<?xml version="1.0" encoding="UTF-8" standalone="yes"?>'
        '<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships">'
        '<Relationship Id="rId1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/slideMaster" Target="../slideMasters/slideMaster1.xml"/>'
        '</Relationships>'
    )


def build_theme_xml() -> str:
    return (
        '<?xml version="1.0" encoding="UTF-8" standalone="yes"?>'
        '<a:theme xmlns:a="http://schemas.openxmlformats.org/drawingml/2006/main" name="Office Theme">'
        '<a:themeElements>'
        '<a:clrScheme name="Office">'
        '<a:dk1><a:srgbClr val="000000"/></a:dk1>'
        '<a:lt1><a:srgbClr val="FFFFFF"/></a:lt1>'
        '<a:dk2><a:srgbClr val="44546A"/></a:dk2>'
        '<a:lt2><a:srgbClr val="E7E6E6"/></a:lt2>'
        '<a:accent1><a:srgbClr val="5B9BD5"/></a:accent1>'
        '<a:accent2><a:srgbClr val="ED7D31"/></a:accent2>'
        '<a:accent3><a:srgbClr val="A5A5A5"/></a:accent3>'
        '<a:accent4><a:srgbClr val="FFC000"/></a:accent4>'
        '<a:accent5><a:srgbClr val="4472C4"/></a:accent5>'
        '<a:accent6><a:srgbClr val="70AD47"/></a:accent6>'
        '<a:hlink><a:srgbClr val="0563C1"/></a:hlink>'
        '<a:folHlink><a:srgbClr val="954F72"/></a:folHlink>'
        '</a:clrScheme>'
        '<a:fontScheme name="Office">'
        '<a:majorFont><a:latin typeface="Calibri"/></a:majorFont>'
        '<a:minorFont><a:latin typeface="Calibri"/></a:minorFont>'
        '</a:fontScheme>'
        '<a:fmtScheme name="Office"><a:fillStyleLst><a:solidFill><a:schemeClr val="phClr"/></a:solidFill></a:fillStyleLst><a:lnStyleLst><a:ln w="9525" cap="flat" cmpd="sng" algn="ctr"><a:solidFill><a:schemeClr val="phClr"/></a:solidFill><a:prstDash val="solid"/></a:ln></a:lnStyleLst><a:effectStyleLst><a:effectStyle><a:effectLst/></a:effectStyle></a:effectStyleLst><a:bgFillStyleLst><a:solidFill><a:schemeClr val="phClr"/></a:solidFill></a:bgFillStyleLst></a:fmtScheme>'
        '</a:themeElements>'
        '<a:objectDefaults/><a:extraClrSchemeLst/>'
        '</a:theme>'
    )


def build_pres_props_xml() -> str:
    return (
        '<?xml version="1.0" encoding="UTF-8" standalone="yes"?>'
        '<p:presentationPr xmlns:a="http://schemas.openxmlformats.org/drawingml/2006/main" xmlns:r="http://schemas.openxmlformats.org/officeDocument/2006/relationships" xmlns:p="http://schemas.openxmlformats.org/presentationml/2006/main"/>'
    )


def build_view_props_xml() -> str:
    return (
        '<?xml version="1.0" encoding="UTF-8" standalone="yes"?>'
        '<p:viewPr xmlns:a="http://schemas.openxmlformats.org/drawingml/2006/main" xmlns:r="http://schemas.openxmlformats.org/officeDocument/2006/relationships" xmlns:p="http://schemas.openxmlformats.org/presentationml/2006/main">'
        '<p:normalViewPr><p:restoredLeft sz="15620"/><p:restoredTop sz="94660"/></p:normalViewPr>'
        '<p:slideViewPr><p:cSldViewPr snapToGrid="1" snapToObjects="1" showGuides="1"/></p:slideViewPr>'
        '<p:notesTextViewPr><p:cViewPr varScale="1"><p:scale><a:sx n="1" d="1"/><a:sy n="1" d="1"/></p:scale></p:cViewPr></p:notesTextViewPr>'
        '<p:gridSpacing cx="91440" cy="91440"/>'
        '</p:viewPr>'
    )


def build_table_styles_xml() -> str:
    return (
        '<?xml version="1.0" encoding="UTF-8" standalone="yes"?>'
        '<a:tblStyleLst xmlns:a="http://schemas.openxmlformats.org/drawingml/2006/main" def="{5C22544A-7EE6-4342-B048-85BDC9FD1C3A}"/>'
    )


def build_slide_xml(equipe: str, nomes: list[str], idx: int) -> str:
    equipe_txt = xml_escape(equipe)
    body_lines = ''.join(
        f'<a:p><a:pPr lvl="0" marL="228600" indent="-228600"><a:buChar char="•"/></a:pPr><a:r><a:rPr lang="pt-BR" sz="3200"/><a:t>{xml_escape(nome)}</a:t></a:r><a:endParaRPr lang="pt-BR"/></a:p>'
        for nome in nomes
    )
    if not body_lines:
        body_lines = '<a:p><a:r><a:rPr lang="pt-BR" sz="2800"/><a:t>Sem jovens aceitos.</a:t></a:r><a:endParaRPr lang="pt-BR"/></a:p>'

    return (
        '<?xml version="1.0" encoding="UTF-8" standalone="yes"?>'
        '<p:sld xmlns:a="http://schemas.openxmlformats.org/drawingml/2006/main" '
        'xmlns:r="http://schemas.openxmlformats.org/officeDocument/2006/relationships" '
        'xmlns:p="http://schemas.openxmlformats.org/presentationml/2006/main">'
        '<p:cSld>'
        '<p:spTree>'
        '<p:nvGrpSpPr><p:cNvPr id="1" name=""/><p:cNvGrpSpPr/><p:nvPr/></p:nvGrpSpPr>'
        '<p:grpSpPr><a:xfrm><a:off x="0" y="0"/><a:ext cx="0" cy="0"/><a:chOff x="0" y="0"/><a:chExt cx="0" cy="0"/></a:xfrm></p:grpSpPr>'
        f'<p:sp><p:nvSpPr><p:cNvPr id="{2 + idx * 2}" name="Titulo"/><p:cNvSpPr/><p:nvPr/></p:nvSpPr><p:spPr><a:xfrm><a:off x="457200" y="228600"/><a:ext cx="11277600" cy="914400"/></a:xfrm></p:spPr><p:txBody><a:bodyPr/><a:lstStyle/><a:p><a:r><a:rPr lang="pt-BR" sz="4400" b="1"/><a:t>Equipe: {equipe_txt}</a:t></a:r><a:endParaRPr lang="pt-BR"/></a:p></p:txBody></p:sp>'
        f'<p:sp><p:nvSpPr><p:cNvPr id="{3 + idx * 2}" name="Conteudo"/><p:cNvSpPr/><p:nvPr/></p:nvSpPr><p:spPr><a:xfrm><a:off x="685800" y="1257300"/><a:ext cx="10515600" cy="5029200"/></a:xfrm></p:spPr><p:txBody><a:bodyPr/><a:lstStyle/>{body_lines}</p:txBody></p:sp>'
        '</p:spTree>'
        '</p:cSld>'
        '<p:clrMapOvr><a:masterClrMapping/></p:clrMapOvr>'
        '</p:sld>'
    )


def build_slide_rels() -> str:
    return (
        '<?xml version="1.0" encoding="UTF-8" standalone="yes"?>'
        '<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships">'
        '<Relationship Id="rId1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/slideLayout" Target="../slideLayouts/slideLayout1.xml"/>'
        '</Relationships>'
    )


def generate_pptx(slides: list[dict]) -> bytes:
    if not slides:
        slides = [{"equipe": "Sem equipe", "nomes": []}]

    buf = io.BytesIO()
    with zipfile.ZipFile(buf, "w", compression=zipfile.ZIP_DEFLATED) as zf:
        slide_count = len(slides)
        zf.writestr('[Content_Types].xml', build_content_types(slide_count))
        zf.writestr('_rels/.rels', build_root_rels())
        zf.writestr('docProps/app.xml', build_app_xml(slide_count))
        zf.writestr('docProps/core.xml', build_core_xml())

        zf.writestr('ppt/presentation.xml', build_presentation_xml(slide_count))
        zf.writestr('ppt/_rels/presentation.xml.rels', build_presentation_rels(slide_count))
        zf.writestr('ppt/slideMasters/slideMaster1.xml', build_slide_master_xml())
        zf.writestr('ppt/slideMasters/_rels/slideMaster1.xml.rels', build_slide_master_rels())
        zf.writestr('ppt/slideLayouts/slideLayout1.xml', build_slide_layout_xml())
        zf.writestr('ppt/slideLayouts/_rels/slideLayout1.xml.rels', build_slide_layout_rels())
        zf.writestr('ppt/theme/theme1.xml', build_theme_xml())
        zf.writestr('ppt/presProps.xml', build_pres_props_xml())
        zf.writestr('ppt/viewProps.xml', build_view_props_xml())
        zf.writestr('ppt/tableStyles.xml', build_table_styles_xml())

        slide_rel = build_slide_rels()
        for idx, slide in enumerate(slides, start=1):
            equipe = str(slide.get('equipe') or 'Sem equipe').strip() or 'Sem equipe'
            nomes = [str(n).strip() for n in (slide.get('nomes') or []) if str(n).strip()]
            zf.writestr(f'ppt/slides/slide{idx}.xml', build_slide_xml(equipe, nomes, idx))
            zf.writestr(f'ppt/slides/_rels/slide{idx}.xml.rels', slide_rel)

    return buf.getvalue()


def main() -> int:
    try:
        payload = json.loads(sys.stdin.read() or '{}')
    except json.JSONDecodeError as exc:
        sys.stderr.write(f'JSON inválido: {exc}\n')
        return 2

    slides = payload.get('slides') or []
    try:
        out = generate_pptx(slides)
    except Exception as exc:
        sys.stderr.write(f'Erro ao gerar pptx: {exc}\n')
        return 1

    sys.stdout.buffer.write(out)
    return 0


if __name__ == '__main__':
    raise SystemExit(main())
