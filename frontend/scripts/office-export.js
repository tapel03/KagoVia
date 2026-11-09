/* =========================================================
   KagoBuild office export
   Builds real Word (.docx), Excel (.xlsx) and PowerPoint (.pptx)
   files in the browser. No CDN and no library: the files are
   Office Open XML packed into a ZIP (store method), so the page's
   Content-Security-Policy ('self' scripts only) is respected.

   Public API (window.OfficeExport):
     docx(name, { title, subtitle, blocks:[ {h}, {p}, {bullets:[]}, {table:{cols,rows}}, {image:{png,w,h}} ] })
     xlsx(name, { sheets:[ {name, cols:[], rows:[[]]} ] })
     pptx(name, { title, subtitle, slides:[ {title, bullets?, table?:{cols,rows}, image?:{png,w,h}} ] })
     table(fmt, name, { title, subtitle, cols, rows })   one table in any format
     menu(button, items[{fmt,label,hint,run}])            attach a format dropdown
     svgToPng(svgElement, width) -> Promise<{png,w,h}>
   ========================================================= */
(function () {
    "use strict";

    /* ---------------- ZIP (store) ---------------- */
    var CRC_TABLE = (function () {
        var t = new Uint32Array(256);
        for (var n = 0; n < 256; n++) {
            var c = n;
            for (var k = 0; k < 8; k++) c = c & 1 ? 0xEDB88320 ^ (c >>> 1) : c >>> 1;
            t[n] = c >>> 0;
        }
        return t;
    })();

    function crc32(bytes) {
        var c = 0xFFFFFFFF;
        for (var i = 0; i < bytes.length; i++) c = CRC_TABLE[(c ^ bytes[i]) & 0xFF] ^ (c >>> 8);
        return (c ^ 0xFFFFFFFF) >>> 0;
    }

    var enc = new TextEncoder();

    function zip(files) {
        // files: [{name, data: string | Uint8Array}]
        var now = new Date();
        var dosTime = (now.getHours() << 11) | (now.getMinutes() << 5) | (now.getSeconds() >> 1);
        var dosDate = ((now.getFullYear() - 1980) << 9) | ((now.getMonth() + 1) << 5) | now.getDate();
        var parts = [], central = [], offset = 0;

        files.forEach(function (f) {
            var name = enc.encode(f.name);
            var data = typeof f.data === "string" ? enc.encode(f.data) : f.data;
            var crc = crc32(data);

            var lh = new DataView(new ArrayBuffer(30));
            lh.setUint32(0, 0x04034b50, true);
            lh.setUint16(4, 20, true);
            lh.setUint16(6, 0x0800, true);
            lh.setUint16(8, 0, true);
            lh.setUint16(10, dosTime, true);
            lh.setUint16(12, dosDate, true);
            lh.setUint32(14, crc, true);
            lh.setUint32(18, data.length, true);
            lh.setUint32(22, data.length, true);
            lh.setUint16(26, name.length, true);
            lh.setUint16(28, 0, true);
            parts.push(new Uint8Array(lh.buffer), name, data);

            var ch = new DataView(new ArrayBuffer(46));
            ch.setUint32(0, 0x02014b50, true);
            ch.setUint16(4, 20, true);
            ch.setUint16(6, 20, true);
            ch.setUint16(8, 0x0800, true);
            ch.setUint16(10, 0, true);
            ch.setUint16(12, dosTime, true);
            ch.setUint16(14, dosDate, true);
            ch.setUint32(16, crc, true);
            ch.setUint32(20, data.length, true);
            ch.setUint32(24, data.length, true);
            ch.setUint16(28, name.length, true);
            ch.setUint32(42, offset, true);
            central.push(new Uint8Array(ch.buffer), name);

            offset += 30 + name.length + data.length;
        });

        var cdSize = central.reduce(function (s, p) { return s + p.length; }, 0);
        var end = new DataView(new ArrayBuffer(22));
        end.setUint32(0, 0x06054b50, true);
        end.setUint16(8, files.length, true);
        end.setUint16(10, files.length, true);
        end.setUint32(12, cdSize, true);
        end.setUint32(16, offset, true);

        return parts.concat(central, [new Uint8Array(end.buffer)]);
    }

    function save(name, chunks, mime) {
        var blob = new Blob(chunks, { type: mime });
        var a = document.createElement("a");
        a.href = URL.createObjectURL(blob);
        a.download = name;
        document.body.appendChild(a);
        a.click();
        a.remove();
        setTimeout(function () { URL.revokeObjectURL(a.href); }, 4000);
    }

    /* ---------------- helpers ---------------- */
    function x(v) {
        // XML-escape and drop characters XML 1.0 does not allow
        return String(v == null ? "" : v)
            .replace(/[\u0000-\u0008\u000B\u000C\u000E-\u001F￾￿]/g, "")
            .replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/"/g, "&quot;");
    }

    var XML = '<?xml version="1.0" encoding="UTF-8" standalone="yes"?>\n';
    var NS_R = "http://schemas.openxmlformats.org/officeDocument/2006/relationships";
    var NS_PKG_R = "http://schemas.openxmlformats.org/package/2006/relationships";
    var REL = "http://schemas.openxmlformats.org/officeDocument/2006/relationships/";

    function rels(list) {
        return XML + '<Relationships xmlns="' + NS_PKG_R + '">' + list.map(function (r) {
            return '<Relationship Id="' + r[0] + '" Type="' + REL + r[1] + '" Target="' + r[2] + '"/>';
        }).join("") + "</Relationships>";
    }

    function contentTypes(overrides, png) {
        return XML + '<Types xmlns="http://schemas.openxmlformats.org/package/2006/content-types">' +
            '<Default Extension="rels" ContentType="application/vnd.openxmlformats-package.relationships+xml"/>' +
            '<Default Extension="xml" ContentType="application/xml"/>' +
            (png ? '<Default Extension="png" ContentType="image/png"/>' : "") +
            overrides.map(function (o) { return '<Override PartName="' + o[0] + '" ContentType="' + o[1] + '"/>'; }).join("") +
            '<Override PartName="/docProps/core.xml" ContentType="application/vnd.openxmlformats-package.core-properties+xml"/>' +
            "</Types>";
    }

    function core(title) {
        var iso = new Date().toISOString().replace(/\.\d+Z$/, "Z");
        return XML + '<cp:coreProperties xmlns:cp="http://schemas.openxmlformats.org/package/2006/metadata/core-properties" xmlns:dc="http://purl.org/dc/elements/1.1/" xmlns:dcterms="http://purl.org/dc/terms/" xmlns:xsi="http://www.w3.org/2001/XMLSchema-instance">' +
            "<dc:title>" + x(title || "KagoBuild export") + "</dc:title><dc:creator>KagoBuild</dc:creator>" +
            '<dcterms:created xsi:type="dcterms:W3CDTF">' + iso + '</dcterms:created><dcterms:modified xsi:type="dcterms:W3CDTF">' + iso + "</dcterms:modified>" +
            "</cp:coreProperties>";
    }

    function rootRels(main) {
        return rels([["rId1", "officeDocument", main], ["rId2", "../package/2006/relationships/metadata/core-properties", "docProps/core.xml"]])
            .replace(REL + "../package/2006/relationships/metadata/core-properties", "http://schemas.openxmlformats.org/package/2006/relationships/metadata/core-properties");
    }

    function stamp() {
        var d = new Date();
        return d.toLocaleDateString("en-ZA", { day: "numeric", month: "long", year: "numeric" });
    }

    function withExt(name, ext) {
        name = String(name || "export").replace(/[\\/:*?"<>|]+/g, "-");
        return /\.[a-z]{3,4}$/i.test(name) ? name.replace(/\.[a-z]{3,4}$/i, "." + ext) : name + "." + ext;
    }

    /* ---------------- Word (.docx) ---------------- */
    var W_NS = 'xmlns:w="http://schemas.openxmlformats.org/wordprocessingml/2006/main" xmlns:r="' + NS_R + '" ' +
        'xmlns:wp="http://schemas.openxmlformats.org/drawingml/2006/wordprocessingDrawing" ' +
        'xmlns:a="http://schemas.openxmlformats.org/drawingml/2006/main" ' +
        'xmlns:pic="http://schemas.openxmlformats.org/drawingml/2006/picture"';

    function wPara(text, style, opts) {
        opts = opts || {};
        var ppr = (style ? '<w:pStyle w:val="' + style + '"/>' : "") + (opts.numbered ? '<w:numPr><w:ilvl w:val="0"/><w:numId w:val="1"/></w:numPr>' : "") + (opts.align ? '<w:jc w:val="' + opts.align + '"/>' : "");
        var rpr = (opts.bold ? "<w:b/>" : "") + (opts.color ? '<w:color w:val="' + opts.color + '"/>' : "") + (opts.size ? '<w:sz w:val="' + opts.size + '"/>' : "");
        var lines = String(text == null ? "" : text).split(/\r?\n/);
        var runs = lines.map(function (l, i) {
            return "<w:r>" + (rpr ? "<w:rPr>" + rpr + "</w:rPr>" : "") + (i ? "<w:br/>" : "") + '<w:t xml:space="preserve">' + x(l) + "</w:t></w:r>";
        }).join("");
        return "<w:p>" + (ppr ? "<w:pPr>" + ppr + "</w:pPr>" : "") + runs + "</w:p>";
    }

    function wTable(t, usable) {
        var n = Math.max(1, t.cols.length);
        var colW = Math.floor(usable / n);
        var border = function (s) { return "<w:" + s + ' w:val="single" w:sz="4" w:space="0" w:color="D9D6D6"/>'; };
        var cell = function (v, head) {
            return '<w:tc><w:tcPr><w:tcW w:w="' + colW + '" w:type="dxa"/>' + (head ? '<w:shd w:val="clear" w:color="auto" w:fill="F4F3F4"/>' : "") + "</w:tcPr>" +
                '<w:p><w:pPr><w:spacing w:before="40" w:after="40"/></w:pPr><w:r><w:rPr>' + (head ? "<w:b/>" : "") + '<w:sz w:val="18"/></w:rPr><w:t xml:space="preserve">' + x(v) + "</w:t></w:r></w:p></w:tc>";
        };
        return '<w:tbl><w:tblPr><w:tblW w:w="' + (colW * n) + '" w:type="dxa"/><w:tblBorders>' +
            border("top") + border("left") + border("bottom") + border("right") + border("insideH") + border("insideV") +
            '</w:tblBorders><w:tblLayout w:type="fixed"/><w:tblCellMar><w:left w:w="80" w:type="dxa"/><w:right w:w="80" w:type="dxa"/></w:tblCellMar></w:tblPr>' +
            "<w:tblGrid>" + t.cols.map(function () { return '<w:gridCol w:w="' + colW + '"/>'; }).join("") + "</w:tblGrid>" +
            '<w:tr><w:trPr><w:tblHeader/></w:trPr>' + t.cols.map(function (c) { return cell(c, true); }).join("") + "</w:tr>" +
            t.rows.map(function (r) { return '<w:tr><w:trPr><w:cantSplit/></w:trPr>' + t.cols.map(function (_, i) { return cell(r[i], false); }).join("") + "</w:tr>"; }).join("") +
            "</w:tbl>" + wPara("", null);
    }

    function wImage(img, rid, id, usableTwips) {
        var maxEmu = Math.round(usableTwips * 635); // 1 twip = 635 EMU
        var cx = Math.min(maxEmu, Math.round(img.w * 9525));
        var cy = Math.round(cx * img.h / img.w);
        return '<w:p><w:pPr><w:jc w:val="center"/></w:pPr><w:r><w:drawing><wp:inline distT="0" distB="0" distL="0" distR="0">' +
            '<wp:extent cx="' + cx + '" cy="' + cy + '"/><wp:docPr id="' + id + '" name="Picture ' + id + '"/>' +
            '<a:graphic><a:graphicData uri="http://schemas.openxmlformats.org/drawingml/2006/picture"><pic:pic>' +
            '<pic:nvPicPr><pic:cNvPr id="' + id + '" name="image' + id + '.png"/><pic:cNvPicPr/></pic:nvPicPr>' +
            '<pic:blipFill><a:blip r:embed="' + rid + '"/><a:stretch><a:fillRect/></a:stretch></pic:blipFill>' +
            '<pic:spPr><a:xfrm><a:off x="0" y="0"/><a:ext cx="' + cx + '" cy="' + cy + '"/></a:xfrm><a:prstGeom prst="rect"><a:avLst/></a:prstGeom></pic:spPr>' +
            "</pic:pic></a:graphicData></a:graphic></wp:inline></w:drawing></w:r></w:p>";
    }

    var W_STYLES = XML + '<w:styles xmlns:w="http://schemas.openxmlformats.org/wordprocessingml/2006/main">' +
        '<w:docDefaults><w:rPrDefault><w:rPr><w:rFonts w:ascii="Arial" w:hAnsi="Arial" w:cs="Arial" w:eastAsia="Arial"/><w:sz w:val="20"/><w:lang w:val="en-ZA"/></w:rPr></w:rPrDefault>' +
        '<w:pPrDefault><w:pPr><w:spacing w:after="120" w:line="276" w:lineRule="auto"/></w:pPr></w:pPrDefault></w:docDefaults>' +
        '<w:style w:type="paragraph" w:default="1" w:styleId="Normal"><w:name w:val="Normal"/></w:style>' +
        '<w:style w:type="paragraph" w:styleId="Title"><w:name w:val="Title"/><w:basedOn w:val="Normal"/><w:pPr><w:spacing w:after="60"/></w:pPr><w:rPr><w:b/><w:color w:val="171615"/><w:sz w:val="40"/></w:rPr></w:style>' +
        '<w:style w:type="paragraph" w:styleId="Subtitle"><w:name w:val="Subtitle"/><w:basedOn w:val="Normal"/><w:pPr><w:spacing w:after="240"/></w:pPr><w:rPr><w:color w:val="6B6667"/><w:sz w:val="20"/></w:rPr></w:style>' +
        '<w:style w:type="paragraph" w:styleId="Heading1"><w:name w:val="heading 1"/><w:basedOn w:val="Normal"/><w:next w:val="Normal"/><w:pPr><w:keepNext/><w:spacing w:before="240" w:after="100"/><w:outlineLvl w:val="0"/></w:pPr><w:rPr><w:b/><w:color w:val="E5322D"/><w:sz w:val="28"/></w:rPr></w:style>' +
        '<w:style w:type="paragraph" w:styleId="ListBullet"><w:name w:val="List Bullet"/><w:basedOn w:val="Normal"/><w:pPr><w:spacing w:after="60"/><w:ind w:left="360" w:hanging="360"/></w:pPr></w:style>' +
        "</w:styles>";

    var W_NUMBERING = XML + '<w:numbering xmlns:w="http://schemas.openxmlformats.org/wordprocessingml/2006/main">' +
        '<w:abstractNum w:abstractNumId="0"><w:multiLevelType w:val="singleLevel"/><w:lvl w:ilvl="0"><w:start w:val="1"/><w:numFmt w:val="bullet"/><w:lvlText w:val="•"/><w:lvlJc w:val="left"/><w:pPr><w:ind w:left="360" w:hanging="360"/></w:pPr></w:lvl></w:abstractNum>' +
        '<w:num w:numId="1"><w:abstractNumId w:val="0"/></w:num></w:numbering>';

    function buildDocx(doc) {
        var widest = (doc.blocks || []).reduce(function (m, b) { return b.table ? Math.max(m, b.table.cols.length) : m; }, 0);
        var landscape = widest > 6;
        var pageW = landscape ? 16838 : 11906, pageH = landscape ? 11906 : 16838, margin = 1134;
        var usable = pageW - margin * 2;
        var media = [], body = "";

        if (doc.title) body += wPara(doc.title, "Title");
        body += wPara((doc.subtitle ? doc.subtitle + " · " : "") + "Generated by KagoBuild on " + stamp(), "Subtitle");

        (doc.blocks || []).forEach(function (b) {
            if (b.h != null) body += wPara(b.h, "Heading1");
            else if (b.p != null) body += wPara(b.p, null, b.style || {});
            else if (b.bullets) b.bullets.forEach(function (t) { body += wPara(t, "ListBullet", { numbered: true }); });
            else if (b.table) body += wTable(b.table, usable);
            else if (b.image) {
                media.push(b.image.png);
                body += wImage(b.image, "rIdImg" + media.length, media.length, usable);
            }
        });

        body += '<w:sectPr><w:pgSz w:w="' + pageW + '" w:h="' + pageH + '"' + (landscape ? ' w:orient="landscape"' : "") + "/>" +
            '<w:pgMar w:top="' + margin + '" w:right="' + margin + '" w:bottom="' + margin + '" w:left="' + margin + '" w:header="567" w:footer="567" w:gutter="0"/></w:sectPr>';

        var docRels = [["rId1", "styles", "styles.xml"], ["rId2", "numbering", "numbering.xml"]]
            .concat(media.map(function (_, i) { return ["rIdImg" + (i + 1), "image", "media/image" + (i + 1) + ".png"]; }));

        var files = [
            { name: "[Content_Types].xml", data: contentTypes([
                ["/word/document.xml", "application/vnd.openxmlformats-officedocument.wordprocessingml.document.main+xml"],
                ["/word/styles.xml", "application/vnd.openxmlformats-officedocument.wordprocessingml.styles+xml"],
                ["/word/numbering.xml", "application/vnd.openxmlformats-officedocument.wordprocessingml.numbering+xml"]
            ], media.length > 0) },
            { name: "_rels/.rels", data: rootRels("word/document.xml") },
            { name: "docProps/core.xml", data: core(doc.title) },
            { name: "word/document.xml", data: XML + "<w:document " + W_NS + "><w:body>" + body + "</w:body></w:document>" },
            { name: "word/styles.xml", data: W_STYLES },
            { name: "word/numbering.xml", data: W_NUMBERING },
            { name: "word/_rels/document.xml.rels", data: rels(docRels) }
        ];
        media.forEach(function (png, i) { files.push({ name: "word/media/image" + (i + 1) + ".png", data: png }); });
        return zip(files);
    }

    /* ---------------- Excel (.xlsx) ---------------- */
    function colName(i) {
        var s = "";
        i += 1;
        while (i > 0) { var m = (i - 1) % 26; s = String.fromCharCode(65 + m) + s; i = Math.floor((i - 1) / 26); }
        return s;
    }

    function isNum(v) {
        return typeof v === "number" ? isFinite(v) : (typeof v === "string" && /^-?\d+(\.\d+)?$/.test(v.trim()) && v.trim().length < 16);
    }

    function sheetXml(s) {
        var cols = s.cols, rows = s.rows;
        var widths = cols.map(function (c, i) {
            var w = String(c).length;
            rows.forEach(function (r) { w = Math.max(w, String(r[i] == null ? "" : r[i]).length); });
            return Math.min(60, Math.max(8, w + 2));
        });
        var cell = function (v, ref, head) {
            if (!head && isNum(v)) return '<c r="' + ref + '"><v>' + Number(v) + "</v></c>";
            return '<c r="' + ref + '" t="inlineStr"' + (head ? ' s="1"' : "") + '><is><t xml:space="preserve">' + x(v) + "</t></is></c>";
        };
        var data = '<row r="1">' + cols.map(function (c, i) { return cell(c, colName(i) + "1", true); }).join("") + "</row>" +
            rows.map(function (r, ri) {
                var n = ri + 2;
                return '<row r="' + n + '">' + cols.map(function (_, i) { return cell(r[i], colName(i) + n, false); }).join("") + "</row>";
            }).join("");
        var last = colName(Math.max(0, cols.length - 1)) + (rows.length + 1);
        return XML + '<worksheet xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main" xmlns:r="' + NS_R + '">' +
            '<dimension ref="A1:' + last + '"/>' +
            '<sheetViews><sheetView workbookViewId="0"><pane ySplit="1" topLeftCell="A2" activePane="bottomLeft" state="frozen"/></sheetView></sheetViews>' +
            '<sheetFormatPr defaultRowHeight="15"/>' +
            "<cols>" + widths.map(function (w, i) { return '<col min="' + (i + 1) + '" max="' + (i + 1) + '" width="' + w + '" customWidth="1"/>'; }).join("") + "</cols>" +
            "<sheetData>" + data + "</sheetData>" +
            (cols.length ? '<autoFilter ref="A1:' + last + '"/>' : "") +
            "</worksheet>";
    }

    var X_STYLES = XML + '<styleSheet xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main">' +
        '<fonts count="2"><font><sz val="11"/><name val="Calibri"/></font><font><b/><sz val="11"/><color rgb="FFFFFFFF"/><name val="Calibri"/></font></fonts>' +
        '<fills count="3"><fill><patternFill patternType="none"/></fill><fill><patternFill patternType="gray125"/></fill><fill><patternFill patternType="solid"><fgColor rgb="FFE5322D"/><bgColor indexed="64"/></patternFill></fill></fills>' +
        '<borders count="1"><border><left/><right/><top/><bottom/><diagonal/></border></borders>' +
        '<cellStyleXfs count="1"><xf numFmtId="0" fontId="0" fillId="0" borderId="0"/></cellStyleXfs>' +
        '<cellXfs count="2"><xf numFmtId="0" fontId="0" fillId="0" borderId="0" xfId="0"/><xf numFmtId="0" fontId="1" fillId="2" borderId="0" xfId="0" applyFont="1" applyFill="1"/></cellXfs>' +
        '<cellStyles count="1"><cellStyle name="Normal" xfId="0" builtinId="0"/></cellStyles>' +
        "</styleSheet>";

    function buildXlsx(book) {
        var used = {};
        var sheets = book.sheets.map(function (s, i) {
            var nm = String(s.name || "Sheet" + (i + 1)).replace(/[\[\]:*?\/\\]/g, " ").slice(0, 31).trim() || "Sheet" + (i + 1);
            while (used[nm.toLowerCase()]) nm = nm.slice(0, 28) + " " + (i + 1);
            used[nm.toLowerCase()] = 1;
            return { name: nm, cols: s.cols, rows: s.rows };
        });
        var files = [
            { name: "[Content_Types].xml", data: contentTypes([
                ["/xl/workbook.xml", "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet.main+xml"],
                ["/xl/styles.xml", "application/vnd.openxmlformats-officedocument.spreadsheetml.styles+xml"]
            ].concat(sheets.map(function (_, i) { return ["/xl/worksheets/sheet" + (i + 1) + ".xml", "application/vnd.openxmlformats-officedocument.spreadsheetml.worksheet+xml"]; }))) },
            { name: "_rels/.rels", data: rootRels("xl/workbook.xml") },
            { name: "docProps/core.xml", data: core(book.title || sheets[0].name) },
            { name: "xl/workbook.xml", data: XML + '<workbook xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main" xmlns:r="' + NS_R + '"><sheets>' +
                sheets.map(function (s, i) { return '<sheet name="' + x(s.name) + '" sheetId="' + (i + 1) + '" r:id="rId' + (i + 1) + '"/>'; }).join("") +
                "</sheets>" + (sheets.some(function (s) { return s.cols.length; }) ? "<definedNames>" + sheets.map(function (s, i) {
                    return s.cols.length ? '<definedName name="_xlnm._FilterDatabase" localSheetId="' + i + '" hidden="1">\'' + x(s.name.replace(/'/g, "''")) + "'!$A$1:$" + colName(s.cols.length - 1) + "$" + (s.rows.length + 1) + "</definedName>" : "";
                }).join("") + "</definedNames>" : "") + "</workbook>" },
            { name: "xl/_rels/workbook.xml.rels", data: rels(sheets.map(function (_, i) { return ["rId" + (i + 1), "worksheet", "worksheets/sheet" + (i + 1) + ".xml"]; })
                .concat([["rId" + (sheets.length + 1), "styles", "styles.xml"]])) },
            { name: "xl/styles.xml", data: X_STYLES }
        ];
        sheets.forEach(function (s, i) { files.push({ name: "xl/worksheets/sheet" + (i + 1) + ".xml", data: sheetXml(s) }); });
        return zip(files);
    }

    /* ---------------- PowerPoint (.pptx) ---------------- */
    var P_NS = 'xmlns:a="http://schemas.openxmlformats.org/drawingml/2006/main" xmlns:r="' + NS_R + '" xmlns:p="http://schemas.openxmlformats.org/presentationml/2006/main"';
    var SW = 12192000, SH = 6858000; // 16:9
    var EMPTY_TREE = '<p:nvGrpSpPr><p:cNvPr id="1" name=""/><p:cNvGrpSpPr/><p:nvPr/></p:nvGrpSpPr><p:grpSpPr><a:xfrm><a:off x="0" y="0"/><a:ext cx="0" cy="0"/><a:chOff x="0" y="0"/><a:chExt cx="0" cy="0"/></a:xfrm></p:grpSpPr>';

    var THEME = XML + '<a:theme xmlns:a="http://schemas.openxmlformats.org/drawingml/2006/main" name="KagoBuild"><a:themeElements>' +
        '<a:clrScheme name="KagoBuild"><a:dk1><a:srgbClr val="171615"/></a:dk1><a:lt1><a:srgbClr val="FFFFFF"/></a:lt1><a:dk2><a:srgbClr val="3A3637"/></a:dk2><a:lt2><a:srgbClr val="F4F3F4"/></a:lt2>' +
        '<a:accent1><a:srgbClr val="E5322D"/></a:accent1><a:accent2><a:srgbClr val="F59E0B"/></a:accent2><a:accent3><a:srgbClr val="16A34A"/></a:accent3><a:accent4><a:srgbClr val="2563EB"/></a:accent4><a:accent5><a:srgbClr val="7C3AED"/></a:accent5><a:accent6><a:srgbClr val="6B6667"/></a:accent6>' +
        '<a:hlink><a:srgbClr val="E5322D"/></a:hlink><a:folHlink><a:srgbClr val="9B1C18"/></a:folHlink></a:clrScheme>' +
        '<a:fontScheme name="KagoBuild"><a:majorFont><a:latin typeface="Arial"/><a:ea typeface=""/><a:cs typeface=""/></a:majorFont><a:minorFont><a:latin typeface="Arial"/><a:ea typeface=""/><a:cs typeface=""/></a:minorFont></a:fontScheme>' +
        '<a:fmtScheme name="KagoBuild"><a:fillStyleLst><a:solidFill><a:schemeClr val="phClr"/></a:solidFill><a:solidFill><a:schemeClr val="phClr"/></a:solidFill><a:solidFill><a:schemeClr val="phClr"/></a:solidFill></a:fillStyleLst>' +
        '<a:lnStyleLst><a:ln w="6350"><a:solidFill><a:schemeClr val="phClr"/></a:solidFill></a:ln><a:ln w="12700"><a:solidFill><a:schemeClr val="phClr"/></a:solidFill></a:ln><a:ln w="19050"><a:solidFill><a:schemeClr val="phClr"/></a:solidFill></a:ln></a:lnStyleLst>' +
        '<a:effectStyleLst><a:effectStyle><a:effectLst/></a:effectStyle><a:effectStyle><a:effectLst/></a:effectStyle><a:effectStyle><a:effectLst/></a:effectStyle></a:effectStyleLst>' +
        '<a:bgFillStyleLst><a:solidFill><a:schemeClr val="phClr"/></a:solidFill><a:solidFill><a:schemeClr val="phClr"/></a:solidFill><a:solidFill><a:schemeClr val="phClr"/></a:solidFill></a:bgFillStyleLst></a:fmtScheme>' +
        "</a:themeElements><a:objectDefaults/><a:extraClrSchemeLst/></a:theme>";

    var CLRMAP = 'bg1="lt1" tx1="dk1" bg2="lt2" tx2="dk2" accent1="accent1" accent2="accent2" accent3="accent3" accent4="accent4" accent5="accent5" accent6="accent6" hlink="hlink" folHlink="folHlink"';

    function pText(id, name, xPos, y, w, h, paras, opts) {
        opts = opts || {};
        return '<p:sp><p:nvSpPr><p:cNvPr id="' + id + '" name="' + name + '"/><p:cNvSpPr txBox="1"/><p:nvPr/></p:nvSpPr>' +
            '<p:spPr><a:xfrm><a:off x="' + xPos + '" y="' + y + '"/><a:ext cx="' + w + '" cy="' + h + '"/></a:xfrm><a:prstGeom prst="rect"><a:avLst/></a:prstGeom>' +
            (opts.fill ? '<a:solidFill><a:srgbClr val="' + opts.fill + '"/></a:solidFill>' : "<a:noFill/>") + "</p:spPr>" +
            '<p:txBody><a:bodyPr wrap="square" lIns="0" tIns="0" rIns="0" bIns="0" anchor="' + (opts.anchor || "t") + '"><a:normAutofit/></a:bodyPr><a:lstStyle/>' +
            paras.map(function (p) {
                var bullet = p.bullet ? '<a:pPr marL="285750" indent="-285750"><a:buFont typeface="Arial"/><a:buChar char="•"/></a:pPr>' : "<a:pPr/>";
                return "<a:p>" + bullet + '<a:r><a:rPr lang="en-ZA" sz="' + (p.size || 1800) + '"' + (p.bold ? ' b="1"' : "") + ' dirty="0"><a:solidFill><a:srgbClr val="' + (p.color || "171615") + '"/></a:solidFill></a:rPr><a:t>' + x(p.text) + "</a:t></a:r></a:p>";
            }).join("") + "</p:txBody></p:sp>";
    }

    function pLine(id, color, y, h) {
        return '<p:sp><p:nvSpPr><p:cNvPr id="' + id + '" name="Accent"/><p:cNvSpPr/><p:nvPr/></p:nvSpPr><p:spPr><a:xfrm><a:off x="457200" y="' + y + '"/><a:ext cx="914400" cy="' + h + '"/></a:xfrm><a:prstGeom prst="rect"><a:avLst/></a:prstGeom><a:solidFill><a:srgbClr val="' + color + '"/></a:solidFill><a:ln><a:noFill/></a:ln></p:spPr></p:sp>';
    }

    function pTable(id, t, y) {
        var w = SW - 914400, n = Math.max(1, t.cols.length), colW = Math.floor(w / n);
        var fontSz = n > 6 ? 1000 : 1200, rowH = n > 6 ? 300000 : 340000;
        var ln = function (tag) { return "<a:" + tag + ' w="6350"><a:solidFill><a:srgbClr val="D9D6D6"/></a:solidFill></a:' + tag + ">"; };
        var cell = function (v, head) {
            return '<a:tc><a:txBody><a:bodyPr/><a:lstStyle/><a:p><a:r><a:rPr lang="en-ZA" sz="' + fontSz + '"' + (head ? ' b="1"' : "") + ' dirty="0"><a:solidFill><a:srgbClr val="' + (head ? "FFFFFF" : "171615") + '"/></a:solidFill></a:rPr><a:t>' + x(v) + "</a:t></a:r></a:p></a:txBody>" +
                '<a:tcPr marL="72000" marR="72000" marT="36000" marB="36000" anchor="ctr">' + ln("lnL") + ln("lnR") + ln("lnT") + ln("lnB") +
                '<a:solidFill><a:srgbClr val="' + (head ? "E5322D" : "FFFFFF") + '"/></a:solidFill></a:tcPr></a:tc>';
        };
        return '<p:graphicFrame><p:nvGraphicFramePr><p:cNvPr id="' + id + '" name="Table ' + id + '"/><p:cNvGraphicFramePr><a:graphicFrameLocks noGrp="1"/></p:cNvGraphicFramePr><p:nvPr/></p:nvGraphicFramePr>' +
            '<p:xfrm><a:off x="457200" y="' + y + '"/><a:ext cx="' + (colW * n) + '" cy="' + (rowH * (t.rows.length + 1)) + '"/></p:xfrm>' +
            '<a:graphic><a:graphicData uri="http://schemas.openxmlformats.org/drawingml/2006/table"><a:tbl><a:tblPr firstRow="1"/><a:tblGrid>' +
            t.cols.map(function () { return '<a:gridCol w="' + colW + '"/>'; }).join("") + "</a:tblGrid>" +
            '<a:tr h="' + rowH + '">' + t.cols.map(function (c) { return cell(c, true); }).join("") + "</a:tr>" +
            t.rows.map(function (r) { return '<a:tr h="' + rowH + '">' + t.cols.map(function (_, i) { return cell(r[i] == null ? "" : r[i], false); }).join("") + "</a:tr>"; }).join("") +
            "</a:tbl></a:graphicData></a:graphic></p:graphicFrame>";
    }

    function pPic(id, rid, img, y) {
        var maxW = SW - 914400, maxH = SH - y - 400000;
        var ratio = img.w / img.h, w = maxW, h = Math.round(w / ratio);
        if (h > maxH) { h = maxH; w = Math.round(h * ratio); }
        var xPos = Math.round((SW - w) / 2);
        return '<p:pic><p:nvPicPr><p:cNvPr id="' + id + '" name="Picture ' + id + '"/><p:cNvPicPr><a:picLocks noChangeAspect="1"/></p:cNvPicPr><p:nvPr/></p:nvPicPr>' +
            '<p:blipFill><a:blip r:embed="' + rid + '"/><a:stretch><a:fillRect/></a:stretch></p:blipFill>' +
            '<p:spPr><a:xfrm><a:off x="' + xPos + '" y="' + y + '"/><a:ext cx="' + w + '" cy="' + h + '"/></a:xfrm><a:prstGeom prst="rect"><a:avLst/></a:prstGeom></p:spPr></p:pic>';
    }

    function slideXml(inner, bg) {
        return XML + "<p:sld " + P_NS + "><p:cSld>" + (bg ? '<p:bg><p:bgPr><a:solidFill><a:srgbClr val="' + bg + '"/></a:solidFill><a:effectLst/></p:bgPr></p:bg>' : "") + "<p:spTree>" + EMPTY_TREE + inner + '</p:spTree></p:cSld><p:clrMapOvr><a:masterClrMapping/></p:clrMapOvr></p:sld>';
    }

    function buildPptx(deck) {
        // Expand: long tables split across slides (max rows per slide)
        var slides = [];
        (deck.slides || []).forEach(function (s) {
            if (s.table && s.table.rows.length) {
                var per = s.table.cols.length > 6 ? 13 : 12, total = Math.ceil(s.table.rows.length / per);
                for (var i = 0; i < total; i++) {
                    slides.push({ title: s.title + (total > 1 ? " (" + (i + 1) + " of " + total + ")" : ""), table: { cols: s.table.cols, rows: s.table.rows.slice(i * per, i * per + per) } });
                }
            } else slides.push(s);
        });

        var xml = [], media = [];
        // Cover slide
        xml.push({ img: 0, xml: slideXml(
            pLine(2, "E5322D", 2286000, 76200) +
            pText(3, "Title", 457200, 2514600, SW - 914400, 1100000, [{ text: deck.title || "KagoBuild", size: 4000, bold: true, color: "FFFFFF" }]) +
            pText(4, "Subtitle", 457200, 3657600, SW - 914400, 900000, [
                { text: deck.subtitle || "Report", size: 1800, color: "D9D6D6" },
                { text: "Generated by KagoBuild on " + stamp(), size: 1400, color: "A9A3A4" }
            ]), "171615") });
        slides.forEach(function (s) {
            var inner = pLine(2, "E5322D", 380000, 50800) +
                pText(3, "Title", 457200, 500000, SW - 914400, 700000, [{ text: s.title || "", size: 2600, bold: true }]);
            var top = 1300000, img = 0;
            if (s.table) inner += pTable(4, s.table, top);
            else if (s.image) {
                media.push(s.image.png);
                img = media.length;
                inner += pPic(4, "rIdImg", s.image, top);
            } else if (s.bullets) {
                inner += pText(4, "Body", 457200, top, SW - 914400, SH - top - 500000, s.bullets.map(function (b) { return { text: b, size: 2000, bullet: true }; }));
            }
            xml.push({ img: img, xml: slideXml(inner) });
        });

        var n = xml.length;
        var overrides = [
            ["/ppt/presentation.xml", "application/vnd.openxmlformats-officedocument.presentationml.presentation.main+xml"],
            ["/ppt/slideMasters/slideMaster1.xml", "application/vnd.openxmlformats-officedocument.presentationml.slideMaster+xml"],
            ["/ppt/slideLayouts/slideLayout1.xml", "application/vnd.openxmlformats-officedocument.presentationml.slideLayout+xml"],
            ["/ppt/theme/theme1.xml", "application/vnd.openxmlformats-officedocument.theme+xml"],
            ["/ppt/presProps.xml", "application/vnd.openxmlformats-officedocument.presentationml.presProps+xml"],
            ["/ppt/viewProps.xml", "application/vnd.openxmlformats-officedocument.presentationml.viewProps+xml"],
            ["/ppt/tableStyles.xml", "application/vnd.openxmlformats-officedocument.presentationml.tableStyles+xml"]
        ];
        for (var i = 1; i <= n; i++) overrides.push(["/ppt/slides/slide" + i + ".xml", "application/vnd.openxmlformats-officedocument.presentationml.slide+xml"]);

        var presRels = [["rId1", "slideMaster", "slideMasters/slideMaster1.xml"], ["rId2", "theme", "theme/theme1.xml"],
            ["rId3", "presProps", "presProps.xml"], ["rId4", "viewProps", "viewProps.xml"], ["rId5", "tableStyles", "tableStyles.xml"]];
        for (i = 1; i <= n; i++) presRels.push(["rId" + (i + 10), "slide", "slides/slide" + i + ".xml"]);

        var files = [
            { name: "[Content_Types].xml", data: contentTypes(overrides, media.length > 0) },
            { name: "_rels/.rels", data: rootRels("ppt/presentation.xml") },
            { name: "docProps/core.xml", data: core(deck.title) },
            { name: "ppt/presentation.xml", data: XML + "<p:presentation " + P_NS + ' saveSubsetFonts="1">' +
                '<p:sldMasterIdLst><p:sldMasterId id="2147483648" r:id="rId1"/></p:sldMasterIdLst><p:sldIdLst>' +
                xml.map(function (_, k) { return '<p:sldId id="' + (256 + k) + '" r:id="rId' + (k + 11) + '"/>'; }).join("") +
                '</p:sldIdLst><p:sldSz cx="' + SW + '" cy="' + SH + '"/><p:notesSz cx="6858000" cy="9144000"/></p:presentation>' },
            { name: "ppt/_rels/presentation.xml.rels", data: rels(presRels) },
            { name: "ppt/presProps.xml", data: XML + "<p:presentationPr " + P_NS + "/>" },
            { name: "ppt/viewProps.xml", data: XML + "<p:viewPr " + P_NS + '><p:normalViewPr><p:restoredLeft sz="15620"/><p:restoredTop sz="94660"/></p:normalViewPr><p:gridSpacing cx="76200" cy="76200"/></p:viewPr>' },
            { name: "ppt/tableStyles.xml", data: XML + '<a:tblStyleLst xmlns:a="http://schemas.openxmlformats.org/drawingml/2006/main" def="{5C22544A-7EE6-4342-B048-85BDC9FD1C3A}"/>' },
            { name: "ppt/theme/theme1.xml", data: THEME },
            { name: "ppt/slideMasters/slideMaster1.xml", data: XML + "<p:sldMaster " + P_NS + "><p:cSld><p:bg><p:bgRef idx=\"1001\"><a:schemeClr val=\"bg1\"/></p:bgRef></p:bg><p:spTree>" + EMPTY_TREE + "</p:spTree></p:cSld>" +
                "<p:clrMap " + CLRMAP + '/><p:sldLayoutIdLst><p:sldLayoutId id="2147483649" r:id="rId1"/></p:sldLayoutIdLst></p:sldMaster>' },
            { name: "ppt/slideMasters/_rels/slideMaster1.xml.rels", data: rels([["rId1", "slideLayout", "../slideLayouts/slideLayout1.xml"], ["rId2", "theme", "../theme/theme1.xml"]]) },
            { name: "ppt/slideLayouts/slideLayout1.xml", data: XML + "<p:sldLayout " + P_NS + ' type="blank" preserve="1"><p:cSld name="Blank"><p:spTree>' + EMPTY_TREE + "</p:spTree></p:cSld><p:clrMapOvr><a:masterClrMapping/></p:clrMapOvr></p:sldLayout>" },
            { name: "ppt/slideLayouts/_rels/slideLayout1.xml.rels", data: rels([["rId1", "slideMaster", "../slideMasters/slideMaster1.xml"]]) }
        ];
        xml.forEach(function (s, k) {
            files.push({ name: "ppt/slides/slide" + (k + 1) + ".xml", data: s.xml });
            var r = [["rId1", "slideLayout", "../slideLayouts/slideLayout1.xml"]];
            if (s.img) r.push(["rIdImg", "image", "../media/image" + s.img + ".png"]);
            files.push({ name: "ppt/slides/_rels/slide" + (k + 1) + ".xml.rels", data: rels(r) });
        });
        media.forEach(function (png, k) { files.push({ name: "ppt/media/image" + (k + 1) + ".png", data: png }); });
        return zip(files);
    }

    /* ---------------- public helpers ---------------- */
    var MIME = {
        docx: "application/vnd.openxmlformats-officedocument.wordprocessingml.document",
        xlsx: "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet",
        pptx: "application/vnd.openxmlformats-officedocument.presentationml.presentation"
    };

    function clean(rows) {
        return rows.map(function (r) { return r.map(function (v) { return v == null ? "" : v; }); });
    }

    var api = {
        docx: function (name, doc) { save(withExt(name, "docx"), buildDocx(doc), MIME.docx); },
        xlsx: function (name, book) { save(withExt(name, "xlsx"), buildXlsx(book), MIME.xlsx); },
        pptx: function (name, deck) { save(withExt(name, "pptx"), buildPptx(deck), MIME.pptx); },

        // Internal builders, exposed for tests
        _build: { docx: buildDocx, xlsx: buildXlsx, pptx: buildPptx },

        table: function (fmt, name, t) {
            var rows = clean(t.rows);
            if (fmt === "xlsx") return api.xlsx(name, { title: t.title, sheets: [{ name: t.sheet || t.title, cols: t.cols, rows: rows }] });
            if (fmt === "docx") return api.docx(name, { title: t.title, subtitle: t.subtitle, blocks: (t.intro ? [{ p: t.intro }] : []).concat([{ table: { cols: t.cols, rows: rows } }]) });
            if (fmt === "pptx") return api.pptx(name, { title: t.title, subtitle: t.subtitle, slides: [{ title: t.title, table: { cols: t.cols, rows: rows } }] });
        },

        LABELS: {
            xlsx: { label: "Excel spreadsheet", hint: ".xlsx, sort and filter", badge: "X" },
            docx: { label: "Word document", hint: ".docx, ready to print", badge: "W" },
            pptx: { label: "PowerPoint slides", hint: ".pptx, for meetings", badge: "P" }
        },

        /* Attach a small dropdown of formats to a button.
           items: [{fmt, label?, hint?, run(fmt)}] */
        menu: function (btn, items) {
            var wrap = document.createElement("div");
            wrap.className = "ox-menu";
            wrap.setAttribute("role", "menu");
            wrap.hidden = true;
            items.forEach(function (it) {
                var meta = api.LABELS[it.fmt] || {};
                var b = document.createElement("button");
                b.type = "button";
                b.setAttribute("role", "menuitem");
                b.className = "ox-item";
                var badge = document.createElement("span");
                badge.className = "ox-badge ox-" + it.fmt;
                badge.textContent = (it.badge || meta.badge || it.fmt).toUpperCase();
                var txt = document.createElement("span");
                txt.className = "ox-text";
                var strong = document.createElement("strong");
                strong.textContent = it.label || meta.label || it.fmt;
                var small = document.createElement("small");
                small.textContent = it.hint || meta.hint || "";
                txt.appendChild(strong);
                txt.appendChild(small);
                b.appendChild(badge);
                b.appendChild(txt);
                b.addEventListener("click", function () {
                    close();
                    Promise.resolve().then(function () { return it.run(it.fmt); }).catch(function (e) {
                        console.error("Export failed", e);
                    });
                });
                wrap.appendChild(b);
            });
            document.body.appendChild(wrap);
            btn.setAttribute("aria-haspopup", "menu");
            btn.setAttribute("aria-expanded", "false");

            function place() {
                var r = btn.getBoundingClientRect();
                wrap.style.visibility = "hidden";
                wrap.hidden = false;
                var w = wrap.offsetWidth, h = wrap.offsetHeight;
                var top = r.bottom + 6;
                if (top + h > window.innerHeight - 8) top = Math.max(8, r.top - h - 6);
                wrap.style.top = top + "px";
                wrap.style.left = Math.max(8, Math.min(r.right - w, window.innerWidth - w - 8)) + "px";
                wrap.style.visibility = "";
            }
            function open() {
                document.querySelectorAll(".ox-menu").forEach(function (m) { if (m !== wrap) m.hidden = true; });
                place();
                btn.setAttribute("aria-expanded", "true");
                var f = wrap.querySelector("button");
                if (f) f.focus({ preventScroll: true });
            }
            function close() {
                if (wrap.hidden) return;
                wrap.hidden = true;
                btn.setAttribute("aria-expanded", "false");
            }
            btn.addEventListener("click", function (e) {
                e.preventDefault();
                e.stopPropagation();
                if (wrap.hidden) open(); else close();
            });
            document.addEventListener("click", function (e) { if (!wrap.contains(e.target) && e.target !== btn) close(); });
            document.addEventListener("keydown", function (e) {
                if (wrap.hidden) return;
                if (e.key === "Escape") { close(); btn.focus(); }
                if (e.key === "ArrowDown" || e.key === "ArrowUp") {
                    var list = Array.prototype.slice.call(wrap.querySelectorAll("button"));
                    var i = list.indexOf(document.activeElement);
                    i = e.key === "ArrowDown" ? (i + 1) % list.length : (i - 1 + list.length) % list.length;
                    list[i].focus();
                    e.preventDefault();
                }
            });
            // Keep the menu attached to its button while the page scrolls
            // (phones scroll a little on tap); close only once the button is off screen.
            function follow(e) {
                if (wrap.hidden || wrap.contains(e && e.target)) return;
                var r = btn.getBoundingClientRect();
                if (r.bottom < 0 || r.top > window.innerHeight) close(); else place();
            }
            window.addEventListener("resize", follow);
            document.addEventListener("scroll", follow, true);
            return { open: open, close: close, el: wrap };
        },

        // Render an <svg> element to PNG bytes (for Word / PowerPoint)
        svgToPng: function (svg, width) {
            return new Promise(function (resolve, reject) {
                var vb = svg.viewBox && svg.viewBox.baseVal;
                var vw = vb && vb.width ? vb.width : svg.clientWidth || 900;
                var vh = vb && vb.height ? vb.height : svg.clientHeight || 700;
                var w = width || 1600, h = Math.round(w * vh / vw);
                var clone = svg.cloneNode(true);
                clone.setAttribute("xmlns", "http://www.w3.org/2000/svg");
                clone.setAttribute("width", w);
                clone.setAttribute("height", h);
                var src = new XMLSerializer().serializeToString(clone);
                var url = URL.createObjectURL(new Blob([src], { type: "image/svg+xml" }));
                var img = new Image();
                img.onload = function () {
                    var c = document.createElement("canvas");
                    c.width = w; c.height = h;
                    var g = c.getContext("2d");
                    g.fillStyle = "#FFFFFF";
                    g.fillRect(0, 0, w, h);
                    g.drawImage(img, 0, 0, w, h);
                    URL.revokeObjectURL(url);
                    c.toBlob(function (b) {
                        if (!b) return reject(new Error("PNG failed"));
                        b.arrayBuffer().then(function (buf) { resolve({ png: new Uint8Array(buf), w: w, h: h, blob: b }); });
                    }, "image/png");
                };
                img.onerror = function () { URL.revokeObjectURL(url); reject(new Error("Could not draw the plan")); };
                img.src = url;
            });
        },

        saveBlob: function (name, blob) { save(name, [blob], blob.type); }
    };

    window.OfficeExport = api;
})();
