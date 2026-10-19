/* ════════════════════════════════════════════════════════════════════
 * bracket-sheets.js — draw sheets for brackets, as SVG, searchable
 * vector PDF, or direct print. Exposed as window.BracketSheets.
 *
 * WHY THIS EXISTS
 * The old export rasterized every sheet to a JPEG/PNG and pasted the
 * picture into jsPDF — tens of KB per page, blurry when zoomed, and
 * impossible to search (Ctrl+F "Novák" found nothing). Here each sheet
 * is described ONCE as drawing primitives (line / rect / text / image)
 * and replayed onto one of two surfaces:
 *   - SVG surface  → on-screen preview + print (vector, crisp)
 *   - PDF surface  → real jsPDF vector lines and real text objects, so
 *                    the PDF is searchable/selectable and tiny.
 *
 * SIZE: text + lines compress extremely well (compress: true). Logos are
 * downscaled once and embedded ONCE per document (jsPDF reuses an image
 * by alias on every page). The TTF font is subset to the glyphs used.
 * 50 sheets typically land well under 1 MB.
 *
 * DIACRITICS: jsPDF's built-in Helvetica only knows WinAnsi, which lacks
 * č ď ľ ĺ ň ŕ ť etc. For correct Slovak/Czech/Polish names, host a
 * Unicode TTF (see config.fonts). If the font can't be loaded, the PDF
 * still builds with Helvetica and non-WinAnsi letters are transliterated
 * (č → c) instead of printing garbage.
 *
 * DEPENDS ON: window.jspdf (jsPDF 2.x) for PDF export only.
 *             bracket-core.js is NOT required at runtime.
 *
 * BRACKET SHAPE the renderers accept:
 *   {
 *     categoryLabel, entries: [{entryId, name, country, clubName, associationIds?}],
 *     rounds: [[match]], bracketSize,
 *     system?:     "single_elimination" (default) | "cut_off",
 *     placements?: { entryId: 1 | 2 | 3 | 5 ... }   // fills Classification
 *   }
 *   match: { matchId, status, blue, red, winnerCorner?, displayNumber,
 *            roundPhase, win?, win_score?, win_type? }
 *
 * ASSOCIATION ID: when an entry carries associationIds (one per member),
 * the last 4 characters of each are printed small and light on top of the
 * bracket line, on the bracket side of the name — after it on the left
 * half, before it on the right half — e.g. "(2345/6789)" for a pair.
 *
 * OPTIONS (every public call):
 *   { title, date, location,
 *     formatNumber(match) -> string   // badge text; default displayNumber
 *     resultLabel(match)  -> string|null // default "B 2-0 PTF" from win* fields
 *   }
 * ════════════════════════════════════════════════════════════════════ */
(function (global) {
    "use strict";

    const PX_MM = 25.4 / 96;                 // layout is in CSS px @ 96dpi
    const INK = "#1e293b", TEXT = "#0f172a", MUTED = "#64748b";
    const SUBTLE = "#94a3b8";                // association-ID tag next to names
    const ELIM_W = 1123, ELIM_H = 794;       // A4 landscape
    const CUT_W = 794, CUT_H = 1123;         // A4 portrait
    const BOX_HALF_W = 15;
    const PDF_FONT = "TVSans";

    const config = {
        logos: {
            left: "/static/assets/logos/world_taekwondo.png",
            right: "/static/assets/logos/truevar.png",
        },
        fonts: {
            // Liberation Sans: Arial-metric compatible, so PDF layout matches the SVG preview. SIL OFL licence.
            regular: "/static/assets/fonts/LiberationSans-Regular.ttf",
            bold: "/static/assets/fonts/LiberationSans-Bold.ttf",
        },
        logoMaxPx: 360, // logos are downscaled to this before embedding
    };

    const cache = { logos: {}, fonts: null };
    const assets = { left: null, right: null };

    function configure(opts) {
        opts = opts || {};
        if (opts.logos) {
            Object.keys(opts.logos).forEach(side => {
                config.logos[side] = opts.logos[side];
                delete cache.logos[side];
                assets[side] = null;
            });
        }
        if (opts.fonts) { Object.assign(config.fonts, opts.fonts); cache.fonts = null; }
        if (opts.logoMaxPx) config.logoMaxPx = opts.logoMaxPx;
    }

    // ── Asset loading ───────────────────────────────────────────────────
    // Logos are redrawn onto a canvas once: downscaled (size) and turned
    // into a data URL (so neither the SVG preview nor the PDF depends on a
    // network fetch later, and a blob:-loaded SVG never taints a canvas).
    function loadLogo(side) {
        if (!cache.logos[side]) {
            const url = config.logos[side];
            cache.logos[side] = new Promise(resolve => {
                if (!url || typeof Image === "undefined") return resolve(null);
                const img = new Image();
                img.onload = () => {
                    try {
                        const scale = Math.min(1, config.logoMaxPx / Math.max(img.naturalWidth, img.naturalHeight));
                        const c = document.createElement("canvas");
                        c.width = Math.max(1, Math.round(img.naturalWidth * scale));
                        c.height = Math.max(1, Math.round(img.naturalHeight * scale));
                        c.getContext("2d").drawImage(img, 0, 0, c.width, c.height);
                        resolve({ dataUrl: c.toDataURL("image/png"), width: c.width, height: c.height, alias: `tv-logo-${side}` });
                    } catch (err) {
                        console.error("BracketSheets: logo conversion failed", url, err);
                        resolve(null);
                    }
                };
                img.onerror = () => { console.error("BracketSheets: logo failed to load", url); resolve(null); };
                img.src = url;
            }).then(a => { assets[side] = a; return a; });
        }
        return cache.logos[side];
    }

    // jsPDF only understands TrueType outlines (.ttf). A missing file often
    // comes back as an HTML error/index page with "200 OK", and jsPDF does
    // NOT throw on that — it registers a broken font and the first text()
    // call crashes ("No unicode cmap for font"). So check the magic bytes.
    function fontProblem(bytes) {
        if (bytes.length < 12) return "file is empty or truncated";
        const tag = String.fromCharCode(bytes[0], bytes[1], bytes[2], bytes[3]);
        if (bytes[0] === 0 && bytes[1] === 1 && bytes[2] === 0 && bytes[3] === 0) return null; // TrueType
        if (tag === "true") return null;                                                  // Apple TrueType
        if (tag === "OTTO") return "it is a CFF-based .otf — jsPDF needs a TrueType .ttf";
        if (tag === "wOFF" || tag === "wOF2") return "it is a .woff/.woff2 web font — jsPDF needs a .ttf";
        if (tag === "ttcf") return "it is a font collection (.ttc) — use a single .ttf";
        if (bytes[0] === 0x3C /* < */ || tag.toLowerCase().startsWith("<!do")) return "the server returned an HTML page, not a font (wrong path / 404 fallback?)";
        return "unrecognised file format";
    }

    async function fetchBase64(url) {
        if (!url) return null;
        try {
            const res = await fetch(url);
            if (!res.ok) { console.warn(`BracketSheets: font ${url} → HTTP ${res.status}`); return null; }
            const bytes = new Uint8Array(await res.arrayBuffer());
            const problem = fontProblem(bytes);
            if (problem) { console.warn(`BracketSheets: can't use font ${url}: ${problem}`); return null; }
            let bin = "";
            for (let i = 0; i < bytes.length; i += 0x8000) {
                bin += String.fromCharCode.apply(null, bytes.subarray(i, i + 0x8000));
            }
            return btoa(bin);
        } catch (err) {
            return null;
        }
    }

    function loadFonts() {
        if (!cache.fonts) {
            cache.fonts = Promise.all([fetchBase64(config.fonts.regular), fetchBase64(config.fonts.bold)])
                .then(([regular, bold]) => {
                    if (!regular) {
                        console.warn("BracketSheets: no usable Unicode font at", config.fonts.regular,
                            "— PDFs fall back to Helvetica and transliterate letters like č/ľ/ť.");
                        return null;
                    }
                    return { regular, bold: bold || regular };
                });
        }
        return cache.fonts;
    }

    // Call once at page init — makes the synchronous toSVG() include logos.
    function prepareAssets() {
        return Promise.all([loadLogo("left"), loadLogo("right"), loadFonts()]).then(() => undefined);
    }

    // Registers the Unicode font on a jsPDF doc (any doc — also usable for
    // autoTable club sheets). Returns the font family name to use.
    async function applyPdfFont(doc) {
        const fallback = () => { doc.__tvFontFallback = true; doc.setFont("helvetica", "normal"); return "helvetica"; };
        const fonts = await loadFonts();
        if (!fonts) return fallback();
        try {
            doc.addFileToVFS(`${PDF_FONT}-Regular.ttf`, fonts.regular);
            doc.addFont(`${PDF_FONT}-Regular.ttf`, PDF_FONT, "normal");
            doc.addFileToVFS(`${PDF_FONT}-Bold.ttf`, fonts.bold);
            doc.addFont(`${PDF_FONT}-Bold.ttf`, PDF_FONT, "bold");
            // addFont reports parse errors via jsPDF's PubSub instead of
            // throwing, so prove both styles actually work before using them.
            doc.setFont(PDF_FONT, "bold"); doc.getTextWidth("Aľ");
            doc.setFont(PDF_FONT, "normal"); doc.getTextWidth("Aľ");
            return PDF_FONT;
        } catch (err) {
            console.warn("BracketSheets: font was rejected by jsPDF — falling back to Helvetica.", err);
            cache.fonts = Promise.resolve(null); // don't retry a bad font on every export
            return fallback();
        }
    }

    // Transliteration used only when no Unicode font could be loaded.
    const WINANSI_EXTRA = "€‚ƒ„…†‡ˆ‰Š‹ŒŽ‘’“”•–—˜™š›œžŸ";
    const MANUAL_MAP = { "Ł": "L", "ł": "l", "Đ": "D", "đ": "d", "ı": "i", "№": "No." };
    function toWinAnsi(str) {
        let out = "";
        for (const ch of String(str)) {
            const c = ch.charCodeAt(0);
            if (c < 0x100 || WINANSI_EXTRA.includes(ch)) { out += ch; continue; }
            if (MANUAL_MAP[ch]) { out += MANUAL_MAP[ch]; continue; }
            const base = ch.normalize("NFD").replace(/[\u0300-\u036f]/g, "");
            out += (base.length === 1 && base.charCodeAt(0) < 0x100) ? base : "?";
        }
        return out;
    }

    // Safe text for any jsPDF doc prepared with applyPdfFont().
    function pdfText(doc, str) {
        const s = String(str ?? "");
        return doc && doc.__tvFontFallback ? toWinAnsi(s) : s;
    }

    // ── Surfaces ────────────────────────────────────────────────────────
    function fitBox(asset, x, y, w, h) {
        const r = Math.min(w / asset.width, h / asset.height);
        const iw = asset.width * r, ih = asset.height * r;
        return { x: x + (w - iw) / 2, y: y + (h - ih) / 2, w: iw, h: ih };
    }

    function escapeXml(str) {
        return String(str ?? "").replace(/[&<>"']/g, ch => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[ch]));
    }

    let measureCtx = null;
    function measureSvgText(str, size, bold) {
        if (measureCtx === null) {
            try { measureCtx = document.createElement("canvas").getContext("2d") || false; } catch (e) { measureCtx = false; }
        }
        const s = String(str ?? "");
        if (!measureCtx) return s.length * size * (bold ? 0.6 : 0.55);
        measureCtx.font = `${bold ? "bold " : ""}${size}px Arial, sans-serif`;
        return measureCtx.measureText(s).width;
    }

    function svgSurface(width, height) {
        const parts = [];
        const n = v => v.toFixed(1);
        return {
            width, height,
            line(x1, y1, x2, y2) {
                parts.push(`<line x1="${n(x1)}" y1="${n(y1)}" x2="${n(x2)}" y2="${n(y2)}" stroke="${INK}" stroke-width="1"/>`);
            },
            rect(x, y, w, h, o) {
                o = o || {};
                parts.push(`<rect x="${n(x)}" y="${n(y)}" width="${n(w)}" height="${n(h)}" fill="${o.fill || "none"}" stroke="${o.stroke || INK}" stroke-width="${o.strokeWidth ?? 1}"/>`);
            },
            text(x, y, str, o) {
                o = o || {};
                if (str == null || str === "") return;
                parts.push(`<text x="${n(x)}" y="${n(y)}" text-anchor="${o.anchor || "start"}" font-size="${o.size || 10}" font-weight="${o.bold ? 700 : 400}" fill="${o.color || TEXT}">${escapeXml(str)}</text>`);
            },
            image(asset, x, y, w, h) {
                if (!asset) return;
                const b = fitBox(asset, x, y, w, h);
                parts.push(`<image href="${asset.dataUrl}" x="${n(b.x)}" y="${n(b.y)}" width="${n(b.w)}" height="${n(b.h)}"/>`);
            },
            measure(str, size, bold) { return measureSvgText(str, size, bold); },
            finish() {
                return `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 ${width} ${height}" width="${width}" height="${height}" font-family="Arial, Helvetica, sans-serif">`
                    + `<rect x="0" y="0" width="${width}" height="${height}" fill="#ffffff"/>`
                    + parts.join("") + `</svg>`;
            },
        };
    }

    // Replays the same primitives as real PDF vector ops. Coordinates stay
    // in layout px and are converted to mm here; font sizes px → pt.
    function pdfSurface(doc, family, width, height) {
        const k = PX_MM;
        const setFont = (size, bold) => { doc.setFont(family, bold ? "bold" : "normal"); doc.setFontSize(size * 0.75); };
        return {
            width, height,
            line(x1, y1, x2, y2) {
                doc.setDrawColor(INK); doc.setLineWidth(k);
                doc.line(x1 * k, y1 * k, x2 * k, y2 * k);
            },
            rect(x, y, w, h, o) {
                o = o || {};
                doc.setDrawColor(o.stroke || INK); doc.setLineWidth((o.strokeWidth ?? 1) * k);
                if (o.fill && o.fill !== "none") { doc.setFillColor(o.fill); doc.rect(x * k, y * k, w * k, h * k, "FD"); }
                else doc.rect(x * k, y * k, w * k, h * k, "S");
            },
            text(x, y, str, o) {
                o = o || {};
                if (str == null || str === "") return;
                setFont(o.size || 10, o.bold);
                doc.setTextColor(o.color || TEXT);
                const align = o.anchor === "middle" ? "center" : o.anchor === "end" ? "right" : "left";
                doc.text(pdfText(doc, str), x * k, y * k, { align, baseline: "alphabetic" });
            },
            image(asset, x, y, w, h) {
                if (!asset) return;
                const b = fitBox(asset, x, y, w, h);
                doc.addImage(asset.dataUrl, "PNG", b.x * k, b.y * k, b.w * k, b.h * k, asset.alias, "FAST");
            },
            measure(str, size, bold) {
                setFont(size, bold);
                return doc.getTextWidth(pdfText(doc, str)) / k;
            },
        };
    }

    // ── Shared label logic ──────────────────────────────────────────────
    function matchResultLabel(m) {
        if (!m || !m.win || !m.win_score) return null;
        const corner = m.win === "blue" ? "B" : m.win === "red" ? "R" : null;
        if (!corner) return null;
        const type = String(m.win_type || "").toUpperCase();
        return `${corner} ${m.win_score}${type ? " " + type : ""}`;
    }

    function normalizeOpts(o) {
        o = o || {};
        return {
            title: o.title || "",
            date: o.date || "",
            location: o.location || "",
            formatNumber: o.formatNumber || (m => (m && m.displayNumber != null ? String(m.displayNumber) : "")),
            resultLabel: o.resultLabel || matchResultLabel,
        };
    }

    // Feeders always live in the same bracket, so a per-bracket lookup is
    // enough to resolve "101 Winner" — no page-global state needed.
    function matchLookup(bracket) {
        const map = {};
        bracket.rounds.forEach(r => r.forEach(m => { map[m.matchId] = m; }));
        return map;
    }

    function findEntry(bracket, entryId) {
        return (bracket.entries || []).find(e => e.entryId === entryId) || null;
    }

    function participantLabel(bracket, p, lookup, fmt) {
        if (!p) return "";
        if (p.entryId) {
            const e = findEntry(bracket, p.entryId);
            const name = (e && e.name) || p.name || p.entryId;
            const country = (e && e.country) || p.country;
            return country ? `${name} (${country})` : name;
        }
        if (p.pendingAdvancement) return "TBD";
        if (p.source && p.source.matchId) {
            const feeder = lookup[p.source.matchId];
            return `${(feeder && fmt(feeder)) || "?"} Winner`;
        }
        return "BYE";
    }

    function participantClub(bracket, p) {
        if (!p || !p.entryId) return "";
        const e = findEntry(bracket, p.entryId);
        return (e && e.clubName) || "";
    }

    // Last 4 characters of each member's association ID (the whole ID if
    // it's shorter), e.g. "(K-12)" or "(2345/6789)" for a pair. Empty when
    // nobody has one.
    function assocTag(ids) {
        const list = (Array.isArray(ids) ? ids : [ids])
            .map(id => (id == null ? "" : String(id).trim()))
            .filter(Boolean)
            .map(id => id.slice(-4));
        return list.length ? `(${list.join("/")})` : "";
    }

    function entryAssocTag(entry) {
        return entry ? assocTag(entry.associationIds || entry.associationId) : "";
    }

    function participantAssocTag(bracket, p) {
        if (!p || !p.entryId) return "";
        const e = findEntry(bracket, p.entryId);
        return assocTag((e && (e.associationIds || e.associationId)) || p.associationIds || p.associationId);
    }

    function fitFontSize(s, str, start, min, maxWidth, bold) {
        let size = start;
        while (size > min && s.measure(str, size, bold) > maxWidth) size -= 0.5;
        return size;
    }

    function classificationRows(bracket) {
        const placements = bracket.placements || {};
        const byRank = {};
        (bracket.entries || []).forEach(e => {
            const rank = placements[e.entryId];
            if (rank != null) (byRank[rank] = byRank[rank] || []).push(e);
        });
        const fmt = (rank, e) => `${rank}. ${e.name}${e.country ? ` (${e.country})` : ""}`;
        const bronze = byRank[3] || [];
        return [
            byRank[1] && byRank[1][0] ? fmt(1, byRank[1][0]) : "1",
            byRank[2] && byRank[2][0] ? fmt(2, byRank[2][0]) : "2",
            bronze[0] ? fmt(3, bronze[0]) : "3",
            bronze[1] ? fmt(3, bronze[1]) : "3",
        ];
    }

    // ── Elimination draw sheet (A4 landscape) ───────────────────────────
    // Mirrored halves converging on a centre Final; round-1 matches evenly
    // spaced, each later round's Y = average of its two feeders.
    function layoutElimination(pager, bracket, o) {
        const W = ELIM_W, H = ELIM_H;
        const s = pager.page(W, H);
        const HEADER_H = 92, FOOTER_H = 150, MARGIN_X = 16, NAME_W = 190, FINAL_GAP = 70;
        const centerX = W / 2;
        const lookup = matchLookup(bracket);
        const label = p => participantLabel(bracket, p, lookup, o.formatNumber);
        const club = p => participantClub(bracket, p);
        const assoc = p => participantAssocTag(bracket, p);

        // Header
        s.image(assets.left, 10, 0, 72, 64);
        s.image(assets.right, W - 90, 0, 80, 64);
        s.text(centerX, 24, o.title, { anchor: "middle", size: 16, bold: true });
        if (o.date) s.text(centerX, 42, o.date, { anchor: "middle", size: 12 });
        s.text(centerX, 60, `${bracket.categoryLabel} Contestants : ${(bracket.entries || []).length}`, { anchor: "middle", size: 13, bold: true });
        s.rect(10, 70, W - 20, 18);

        function badge(x, y, m) {
            s.rect(x - BOX_HALF_W, y - 8, BOX_HALF_W * 2, 16, { fill: "#ffffff" });
            s.text(x, y + 3.5, o.formatNumber(m), { anchor: "middle", size: 8.5 });
            const result = o.resultLabel(m);
            if (result) s.text(x, y + 25, result, { anchor: "middle", size: 9, color: MUTED });
        }
        // Name (+ club underneath), aligned to the page's OUTER edge: left
        // half → left-aligned at the left margin, right half →
        // right-aligned at the right margin. A club wider than the name
        // column is shrunk to fit.
        //
        // The feed line starts right where the name ends, and the small
        // association-ID tag sits ON TOP of that line, on the bracket side
        // of the name: left half "Name (SVK) (2345)───", right half
        // "───(2345) Name (SVK)". Returns the x where the feed line starts.
        function nameBlock(nameX, y, dir, p, nameSize, clubSize, maxClubW) {
            const name = label(p), clubName = club(p), tag = assoc(p);
            const anchor = dir === 1 ? "start" : "end";
            const tagSize = Math.max(5, nameSize * 0.7);
            const w = s.measure(name, nameSize);
            const lineStartX = dir === 1 ? nameX + w + 2 : nameX - w - 2;

            s.text(nameX, y - 1.5, name, { anchor, size: nameSize });
            if (tag) {
                // Raised slightly so it clears the line drawn underneath it.
                s.text(lineStartX + dir * 1.5, y - 3, tag, { anchor, size: tagSize, color: SUBTLE });
            }

            if (clubName) {
                const size = fitFontSize(s, clubName, clubSize, 5, maxClubW || NAME_W - 6);
                s.text(nameX, y + clubSize + 0.5, clubName, { anchor, size, color: MUTED });
            }
            return lineStartX;
        }
        function merge(xFeed1, y1, xFeed2, y2, xOut) {
            s.line(xFeed1, y1, xOut, y1);
            s.line(xFeed2, y2, xOut, y2);
            s.line(xOut, y1, xOut, y2);
        }

        const rounds = bracket.rounds, numRounds = rounds.length, bracketSize = bracket.bracketSize;

        if (bracketSize <= 2) {
            const fm = rounds[0][0];
            const cy = HEADER_H + (H - HEADER_H - FOOTER_H) / 2;
            s.text(centerX, 82, "Final", { anchor: "middle", bold: true, size: 9 });
            const bx = nameBlock(MARGIN_X, cy, 1, fm.blue, 11, 10, centerX - MARGIN_X - 40);
            const rx = nameBlock(W - MARGIN_X, cy, -1, fm.red, 11, 10, centerX - MARGIN_X - 40);
            s.line(bx, cy, centerX, cy);
            s.line(rx, cy, centerX, cy);
            badge(centerX, cy, fm);
            drawEliminationFooter(s, bracket, centerX, H - FOOTER_H);
            return;
        }

        const halfCount = rounds[0].length / 2;
        const MATCH_H = (H - HEADER_H - FOOTER_H) / halfCount;
        const ROW_H = Math.min(26, MATCH_H * 0.5);
        const nameSize = Math.max(6, Math.min(9, MATCH_H * 0.2));
        const clubSize = Math.max(6.5, nameSize * 0.9);
        const ROUND_W = numRounds > 1 ? (centerX - MARGIN_X - NAME_W - FINAL_GAP) / (numRounds - 1) : 0;
        const xL = r => MARGIN_X + NAME_W + r * ROUND_W;
        const xR = r => W - MARGIN_X - NAME_W - r * ROUND_W;

        const left = [], right = [];
        left[0] = rounds[0].slice(0, halfCount).map((m, i) => ({ match: m, y: HEADER_H + i * MATCH_H + MATCH_H / 2 }));
        right[0] = rounds[0].slice(halfCount).map((m, i) => ({ match: m, y: HEADER_H + i * MATCH_H + MATCH_H / 2 }));
        for (let r = 1; r <= numRounds - 2; r++) {
            const half = rounds[r].length / 2;
            left[r] = rounds[r].slice(0, half).map((m, i) => ({ match: m, y: (left[r - 1][2 * i].y + left[r - 1][2 * i + 1].y) / 2 }));
            right[r] = rounds[r].slice(half).map((m, i) => ({ match: m, y: (right[r - 1][2 * i].y + right[r - 1][2 * i + 1].y) / 2 }));
        }

        // Round 1: names + connectors (a bye shows only the advancing name).
        [
            { side: left[0], nameX: MARGIN_X, boxX: xL(0), dir: 1 },
            { side: right[0], nameX: W - MARGIN_X, boxX: xR(0), dir: -1 },
        ].forEach(({ side, nameX, boxX, dir }) => {
            side.forEach(entry => {
                const { match, y } = entry;
                if (match.status === "walkover") {
                    const feedX = nameBlock(nameX, y, dir, match.winnerCorner, nameSize, clubSize);
                    s.line(feedX, y, boxX, y);
                    entry.exitX = boxX;
                    return;
                }
                const topY = y - ROW_H / 2, botY = y + ROW_H / 2;
                const topFeed = nameBlock(nameX, topY, dir, match.blue, nameSize, clubSize);
                const botFeed = nameBlock(nameX, botY, dir, match.red, nameSize, clubSize);
                merge(topFeed, topY, botFeed, botY, boxX);
                badge(boxX, y, match);
                entry.exitX = boxX + dir * BOX_HALF_W;
            });
        });

        for (let r = 1; r < left.length; r++) {
            [[left, xL, 1], [right, xR, -1]].forEach(([half, xOf, dir]) => {
                half[r].forEach((entry, i) => {
                    const a = half[r - 1][2 * i], b = half[r - 1][2 * i + 1];
                    merge(a.exitX, a.y, b.exitX, b.y, xOf(r));
                    badge(xOf(r), entry.y, entry.match);
                    entry.exitX = xOf(r) + dir * BOX_HALF_W;
                });
            });
        }

        // Final
        const lastL = left[left.length - 1][0], lastR = right[right.length - 1][0];
        const yFinal = (lastL.y + lastR.y) / 2;
        [lastL, lastR].forEach(e => {
            s.line(e.exitX, e.y, centerX, e.y);
            if (e.y !== yFinal) s.line(centerX, e.y, centerX, yFinal);
        });
        badge(centerX, yFinal, rounds[numRounds - 1][0]);

        // Round labels
        for (let r = 0; r < numRounds; r++) {
            const text = BracketLabels.round(bracketSize / Math.pow(2, r));
            if (r === numRounds - 1) s.text(centerX, 82, text, { anchor: "middle", bold: true, size: 9 });
            else {
                s.text(xL(r), 82, text, { anchor: "middle", bold: true, size: 9 });
                s.text(xR(r), 82, text, { anchor: "middle", bold: true, size: 9 });
            }
        }

        drawEliminationFooter(s, bracket, centerX, H - FOOTER_H);
    }

    const BracketLabels = {
        round(playersEntering) {
            if (playersEntering === 2) return "Final";
            if (playersEntering === 4) return "Semifinals";
            if (playersEntering === 8) return "Quarterfinals";
            return `Round of ${playersEntering}`;
        },
    };

    function drawEliminationFooter(s, bracket, centerX, footerTop) {
        const clsX = centerX - 90, clsW = 180;
        s.rect(clsX, footerTop, clsW, 20);
        s.text(centerX, footerTop + 14, "Classification", { anchor: "middle", size: 10, bold: true });
        classificationRows(bracket).forEach((label, i) => {
            const rowY = footerTop + 20 + i * 18;
            s.rect(clsX, rowY, clsW, 18, { fill: "#ffffff" });
            s.text(clsX + 8, rowY + 13, label, { size: fitFontSize(s, label, 9, 6.5, clsW - 16) });
        });

        const legendY = footerTop + 110, margin = 16, rowH = 20, fontSize = 8.5, gap = 30;
        s.rect(margin, legendY, s.width - 2 * margin, rowH);
        let x = margin + 10;
        [
            "RSC: Win by Referee Stops Contest",
            "WDR: Win by Withdrawal",
            "DQB: Disqualification (unsportsmanlike)",
            "PTF: Win by final score",
            "DSQ: Disqualification",
        ].forEach(item => {
            s.text(x, legendY + rowH / 2 + 3, item, { size: fontSize });
            x += s.measure(item, fontSize) + gap;
        });
    }

    // ── Cut-off running sheet (A4 portrait, paginates) ──────────────────
    const CUT_OFF_STAGE_NAMES = { PR: "Preliminary Round", SF: "Semi-Final", F: "Final" };

    function layoutCutOff(pager, bracket, o) {
        const W = CUT_W, H = CUT_H, MARGIN = 32, HEADER_H = 92;
        const STAGE_TITLE_H = 22, TABLE_HEAD_H = 22, ROW_H = 20, STAGE_GAP = 22, BOTTOM = H - MARGIN;
        const cols = [
            { key: "no", label: "No.", w: 26, center: true },
            { key: "matchNo", label: "Match No", w: 55, center: true },
            { key: "competitor", label: "Competitor", w: 165 },
            { key: "org", label: "Organization", w: 175 },
            { key: "p1", label: "Poomsae 1", w: 55 },
            { key: "p2", label: "Poomsae 2", w: 55 },
            { key: "total", label: "Total score", w: 55 },
            { key: "place", label: "Place", w: 45 },
        ];
        const tableW = cols.reduce((a, c) => a + c.w, 0);
        const tableX = (W - tableW) / 2, centerX = W / 2;
        let s, y;

        function newPage() {
            s = pager.page(W, H);
            s.image(assets.left, MARGIN - 16, 4, 56, 48);
            s.image(assets.right, W - MARGIN - 48, 4, 64, 48);
            const title = o.title;
            const splitAt = title.length > 46 ? (() => {
                const mid = Math.floor(title.length / 2);
                let at = title.lastIndexOf(" ", mid);
                if (at < 0) at = title.indexOf(" ", mid);
                return at;
            })() : -1;
            if (splitAt > 0) {
                s.text(centerX, 18, title.slice(0, splitAt), { anchor: "middle", bold: true, size: 13 });
                s.text(centerX, 34, title.slice(splitAt + 1), { anchor: "middle", bold: true, size: 13 });
            } else {
                s.text(centerX, 22, title, { anchor: "middle", bold: true, size: 13 });
            }
            s.text(centerX, 52, [o.location, o.date].filter(Boolean).join(", "), { anchor: "middle", size: 10 });
            s.text(centerX, 68, bracket.categoryLabel, { anchor: "middle", size: 9.5, color: "#334155" });
            y = HEADER_H;
        }
        function stageTitle(text) {
            s.text(centerX, y + STAGE_TITLE_H - 6, text, { anchor: "middle", bold: true, size: 12 });
            y += STAGE_TITLE_H;
            let cx = tableX;
            cols.forEach(c => {
                s.rect(cx, y, c.w, TABLE_HEAD_H, { fill: "#f8fafc", strokeWidth: 0.75 });
                s.text(cx + c.w / 2, y + TABLE_HEAD_H / 2 + 3.5, c.label, { anchor: "middle", bold: true, size: 8.5 });
                cx += c.w;
            });
            y += TABLE_HEAD_H;
        }

        newPage();
        bracket.rounds.forEach((round, ri) => {
            const code = round[0] ? round[0].roundPhase : null;
            const stageName = CUT_OFF_STAGE_NAMES[code] || `Stage ${ri + 1}`;
            if (y + STAGE_TITLE_H + TABLE_HEAD_H + ROW_H > BOTTOM) newPage();
            stageTitle(stageName);

            round.forEach((m, i) => {
                if (y + ROW_H > BOTTOM) { newPage(); stageTitle(`${stageName} (cont.)`); }
                const entry = m.blue && m.blue.entryId ? findEntry(bracket, m.blue.entryId) : null;
                const values = {
                    no: String(i + 1), matchNo: o.formatNumber(m),
                    competitor: entry ? entry.name : "", org: entry && entry.clubName ? entry.clubName : "",
                };
                const tag = entryAssocTag(entry);
                let cx = tableX;
                cols.forEach(c => {
                    s.rect(cx, y, c.w, ROW_H, { strokeWidth: 0.75 });
                    const v = values[c.key];
                    const baseY = y + ROW_H / 2 + 3.5;
                    if (v && c.key === "competitor" && tag) {
                        // Name, then the small association-ID tag right after it.
                        const tagSize = 6;
                        const tagW = s.measure(tag, tagSize) + 3;
                        const size = fitFontSize(s, v, 8, 6, c.w - 10 - tagW);
                        s.text(cx + 6, baseY, v, { size });
                        s.text(cx + 6 + s.measure(v, size) + 3, baseY - 2, tag, { size: tagSize, color: SUBTLE });
                    } else if (v) {
                        const size = fitFontSize(s, v, 8, 6, c.w - 10);
                        s.text(c.center ? cx + c.w / 2 : cx + 6, baseY, v, { anchor: c.center ? "middle" : "start", size });
                    }
                    cx += c.w;
                });
                y += ROW_H;
            });
            y += STAGE_GAP;
        });
    }

    // ── Public API ──────────────────────────────────────────────────────
    function isPrintable(bracket) {
        return !bracket.system || bracket.system === "single_elimination" || bracket.system === "cut_off";
    }
    function layoutFor(bracket) {
        return bracket.system === "cut_off" ? layoutCutOff : layoutElimination;
    }

    // -> [{ svg, width, height }] — one entry per physical page.
    function toSVGPages(bracket, opts) {
        const o = normalizeOpts(opts);
        const pages = [];
        layoutFor(bracket)({ page(w, h) { const s = svgSurface(w, h); pages.push(s); return s; } }, bracket, o);
        return pages.map(s => ({ svg: s.finish(), width: s.width, height: s.height }));
    }

    // All pages of one bracket as a single markup string (for previews).
    function toSVG(bracket, opts) {
        return toSVGPages(bracket, opts).map(p => p.svg).join("\n");
    }

    // Builds ONE searchable vector PDF for any number of brackets.
    async function buildPdf(brackets, opts) {
        if (!global.jspdf || !global.jspdf.jsPDF) throw new Error("PDF library failed to load — check your connection and retry.");
        const list = (brackets || []).filter(isPrintable);
        if (list.length === 0) throw new Error("No printable brackets.");
        await prepareAssets();

        const o = normalizeOpts(opts);
        const doc = new global.jspdf.jsPDF({ unit: "mm", format: "a4", compress: true, putOnlyUsedFonts: true });
        const family = await applyPdfFont(doc);
        doc.setProperties({ title: o.title ? `${o.title} — Brackets` : "Brackets", creator: "TrueVAR" });

        const pager = {
            page(w, h) {
                doc.addPage([w * PX_MM, h * PX_MM], w >= h ? "landscape" : "portrait");
                return pdfSurface(doc, family, w, h);
            },
        };
        list.forEach(b => layoutFor(b)(pager, b, o));
        doc.deletePage(1); // the placeholder page jsPDF always starts with
        return doc;
    }

    async function downloadPdf(brackets, filename, opts) {
        const doc = await buildPdf(brackets, opts);
        doc.save(filename || "brackets.pdf");
        return doc;
    }

    // Prints vector SVG pages through a hidden iframe (no rasterization).
    // Each distinct page size gets its own named @page, so landscape
    // elimination sheets and portrait cut-off sheets can share one job.
    async function print(brackets, opts) {
        const list = (brackets || []).filter(isPrintable);
        if (list.length === 0) throw new Error("No printable brackets.");
        await prepareAssets();
        const pages = [];
        list.forEach(b => pages.push(...toSVGPages(b, opts)));
        return printSvgPages(pages);
    }

    function printSvgPages(pages) {
        const sizes = {};
        const mm = v => Math.floor(v * PX_MM * 10) / 10;
        const pageCss = [], body = [];
        pages.forEach(p => {
            const key = `${p.width}x${p.height}`;
            if (!(key in sizes)) {
                sizes[key] = `pg${Object.keys(sizes).length}`;
                pageCss.push(`@page ${sizes[key]} { size: ${mm(p.width)}mm ${mm(p.height)}mm; margin: 0; }`);
            }
            // A hair shorter than the page so rounding can never spill a
            // sliver onto an extra (blank) page.
            body.push(`<div class="sheet" style="page:${sizes[key]}; width:${mm(p.width)}mm; height:${(mm(p.height) - 0.5).toFixed(1)}mm;">${p.svg}</div>`);
        });

        return new Promise((resolve, reject) => {
            const iframe = document.createElement("iframe");
            Object.assign(iframe.style, { position: "fixed", top: "-10000px", left: "-10000px", width: "1200px", height: "1600px", border: "0" });
            document.body.appendChild(iframe);
            const doc = iframe.contentWindow.document;
            doc.open();
            doc.write(`<!DOCTYPE html><html><head><style>
                html, body { margin: 0; padding: 0; }
                ${pageCss.join("\n")}
                .sheet { overflow: hidden; break-after: page; page-break-after: always; }
                .sheet:last-child { break-after: auto; page-break-after: auto; }
                .sheet svg { display: block; width: 100%; height: 100%; }
            </style></head><body>${body.join("")}</body></html>`);
            doc.close();

            const logoUrls = [assets.left, assets.right].filter(Boolean).map(a => a.dataUrl);
            Promise.all(logoUrls.map(u => new Promise(res => { const i = new Image(); i.onload = i.onerror = res; i.src = u; })))
                .then(() => new Promise(res => setTimeout(res, 150)))
                .then(() => {
                    try { iframe.contentWindow.focus(); iframe.contentWindow.print(); resolve(); }
                    catch (e) { reject(e); }
                    finally { setTimeout(() => iframe.remove(), 1000); }
                });
        });
    }

    // Loaded logos ({dataUrl, width, height, alias} or null per side) —
    // for other PDFs (e.g. the poomsae draw) to reuse the same header art.
    function getLogoAssets() {
        return { left: assets.left, right: assets.right };
    }

    global.BracketSheets = {
        configure, prepareAssets, applyPdfFont, pdfText, getLogoAssets,
        toSVG, toSVGPages, buildPdf, downloadPdf, print,
        isPrintable, matchResultLabel, assocTag,
        PAGE: { ELIMINATION: { width: ELIM_W, height: ELIM_H }, CUT_OFF: { width: CUT_W, height: CUT_H } },
    };
})(typeof window !== "undefined" ? window : globalThis);