/* live-queue-poomsae.js — loaded LAST by templates/dashboard/live_queue_poomsae.html,
 * after live-queue-common.js, live-queue-poomsae-cutoff.js and
 * live-queue-poomsae-duel.js (see the contract in live-queue-common.js).
 *
 * Poomsae runs two ways, each in its own file:
 *   cut-off       solo performances, PR → SF → F    live-queue-poomsae-cutoff.js
 *   side by side  head-to-head bouts (single         live-queue-poomsae-duel.js
 *                 elimination / round robin)
 * This file holds what both share (score formatting, the per-poomsae
 * score table, drawn poomsae, round time, the printable / PDF sheet
 * renderer for round-robin categories) and the discipline
 * object that picks the format of every match, then starts the page.
 * No PSS vests, helmets or TA sheets in poomsae.
 *
 * Round-robin PDF download needs jspdf-autotable (loaded by
 * live_queue_base.html). */
"use strict";

// ── Shared poomsae helpers ───────────────────────────────────────────
function poomsaeScoreText(v) {
    return typeof v === "number" && Number.isFinite(v) ? v.toFixed(3) : "—";
}

// Drawn poomsae for this match (pushed by the bracket builder from the
// Poomsae Draw page): [{key, name}] → "Koryo + Taebaek".
function poomsaeNamesOf(m) {
    const list = m && Array.isArray(m.poomsae) ? m.poomsae : [];
    return list.map(p => (p && (p.name || p.key)) || "").filter(Boolean).join(" + ");
}

function poomsaeDrawnHtml(m) {
    const names = poomsaeNamesOf(m);
    return names ? `<span class="lq-mini-badge" title="Drawn poomsae">${escapeHtml(names)}</span>` : "";
}

// One corner's score per poomsae (blue.points[] / red.points[] written by
// Firebase Sync): poomsae, accuracy, presentation, penalties, score.
function poomsaePerformanceTableHtml(corner) {
    const points = (corner && Array.isArray(corner.points)) ? corner.points : [];
    if (points.length === 0) return "";
    const num = (v) => (typeof v === "number" ? poomsaeScoreText(v) : v != null && v !== "" ? escapeHtml(String(v)) : "—");
    const rows = points.map((p, i) => `
        <tr>
            <td>${escapeHtml((p.poomsae && (p.poomsae.name || p.poomsae.key)) || `Poomsae ${p.round || i + 1}`)}</td>
            <td>${num(p.accuracy)}</td>
            <td>${num(p.presentation)}</td>
            <td>${p.penalties ? num(typeof p.penalties === "number" ? -Math.abs(p.penalties) : p.penalties) : "—"}</td>
            <td><strong>${num(p.points ?? p.total)}</strong></td>
        </tr>`).join("");
    return `
        <table class="lq-poomsae-table" style="margin-top:.5rem;">
            <thead><tr><th>Poomsae</th><th>Accuracy</th><th>Presentation</th><th>Penalty</th><th>Score</th></tr></thead>
            <tbody>${rows}</tbody>
        </table>`;
}

// Round time of this match (seconds) — the court's round timer starts
// from it (bracket builder writes it per type: poomsae / para / freestyle).
function poomsaeRoundSecondsField(m) {
    return `<label>Round Seconds <input type="number" min="10" id="edit-roundSeconds" value="${m.roundSeconds ?? ""}" placeholder="court default"></label>
            <label>&nbsp;</label>`;
}

function poomsaeRoundSecondsUpdate() {
    const raw = document.getElementById("edit-roundSeconds").value.trim();
    const n = Number(raw);
    return raw !== "" && Number.isFinite(n) && n > 0 ? { roundSeconds: Math.round(n) } : {};
}

// The 📄 row button and the 🖨 / ⬇ Bracket buttons in match modals —
// same one-click idea as kyorugi's TA sheet button.
const POOMSAE_SHEET_ROW_BUTTON = { kind: "bracket", title: "Download this category's bracket (PDF)", label: "📄" };
function poomsaeOnRowButton(kind, m, btn) {
    if (kind === "bracket") downloadCategorySheet(m.categoryCode, btn);
}

// ═══════════════════════════════════════════════════════════════════
// SHEET PAGES — the round-robin sheet (BracketSheets has no round-robin
// layout), both
// printed (HTML) and downloaded (PDF), so the printout and the file
// always match.
//
//   page    { label, subtitle, sections: [section] }
//   section { heading, columns: [{label, align: "left"|"center"}],
//             rows: [[cell]], note }
//   cell    string | { text, bold, muted }
// ═══════════════════════════════════════════════════════════════════

function sheetCellText(c) {
    return c && typeof c === "object" ? String(c.text ?? "") : String(c ?? "");
}

function poomsaeSheetPageHtml(page) {
    const align = (col) => (col && col.align === "left" ? "left" : "center");
    const th = (col) => `<th style="border:1px solid #111; padding:4px 6px; font-weight:700; text-align:${align(col)}; background:#f1f5f9;">${escapeHtml(col.label)}</th>`;
    const td = (c, col) => {
        const o = c && typeof c === "object" ? c : {};
        return `<td style="border:1px solid #111; padding:4px 6px; text-align:${align(col)};${o.bold ? " font-weight:700;" : ""}${o.muted ? " color:#666;" : ""}">${escapeHtml(sheetCellText(c))}</td>`;
    };
    const sections = page.sections.map(s => `
        <div style="margin-top:14px;">
            <div style="font-size:14px; font-weight:700; margin-bottom:4px;">${escapeHtml(s.heading)}</div>
            <table style="width:100%; border-collapse:collapse; font-size:12px;">
                <thead><tr>${s.columns.map(th).join("")}</tr></thead>
                <tbody>${s.rows.length
            ? s.rows.map(r => `<tr>${r.map((c, i) => td(c, s.columns[i])).join("")}</tr>`).join("")
            : `<tr><td colspan="${s.columns.length}" style="border:1px solid #111; padding:4px 6px; text-align:center;">—</td></tr>`}</tbody>
            </table>
            ${s.note ? `<div style="font-size:11px; color:#333; margin-top:4px;">${escapeHtml(s.note)}</div>` : ""}
        </div>`).join("");
    return `
        <div class="pq-page" style="font-family: Arial, Helvetica, sans-serif; padding: 24px; box-sizing: border-box; color: #111;">
            <div style="font-size:20px; font-weight:700;">${escapeHtml(TOURNAMENT_TITLE || "Tournament")}</div>
            <div style="font-size:16px; font-weight:700; margin-top:4px;">${escapeHtml(page.label)}</div>
            ${page.subtitle ? `<div style="font-size:12px; color:#444; margin-top:2px;">${escapeHtml(page.subtitle)}</div>` : ""}
            ${sections}
            <div style="font-size:10px; color:#555; margin-top:10px;">Printed ${escapeHtml(new Date().toLocaleString())}</div>
        </div>`;
}

function printPoomsaeSheets(pages) {
    return printHtmlInFrame(`<style>.pq-page { page-break-after: always; } .pq-page:last-child { page-break-after: auto; }</style>`
        + pages.map(poomsaeSheetPageHtml).join(""));
}

async function downloadPoomsaeSheetsPdf(pages, filename) {
    if (!window.jspdf || !window.jspdf.jsPDF) throw new Error("PDF library failed to load — check your connection and retry.");
    await BracketSheets.prepareAssets();
    const { jsPDF } = window.jspdf;
    const doc = new jsPDF({ unit: "mm", format: "a4", compress: true });
    if (typeof doc.autoTable !== "function") throw new Error("PDF table plugin failed to load — check your connection and retry.");

    const font = await BracketSheets.applyPdfFont(doc);
    const t = (s) => BracketSheets.pdfText(doc, String(s ?? ""));
    const logos = BracketSheets.getLogoAssets() || {};
    const pageW = doc.internal.pageSize.getWidth();
    const pageH = doc.internal.pageSize.getHeight();
    const margin = 14;
    const top = 33;
    const ink = [17, 17, 17];

    const fit = (asset, size) => {
        const s = size / Math.max(asset.width, asset.height);
        return [asset.width * s, asset.height * s];
    };
    const headed = new Set();
    const drawHeader = (page) => {
        const n = doc.getCurrentPageInfo().pageNumber;
        if (headed.has(n)) return;
        headed.add(n);
        if (logos.left) {
            const [w, h] = fit(logos.left, 18);
            doc.addImage(logos.left.dataUrl, "PNG", margin, 8, w, h, logos.left.alias, "FAST");
        }
        if (logos.right) {
            const [w, h] = fit(logos.right, 20);
            doc.addImage(logos.right.dataUrl, "PNG", pageW - margin - w, 8, w, h, logos.right.alias, "FAST");
        }
        doc.setTextColor(...ink);
        doc.setFont(font, "bold");
        doc.setFontSize(14);
        doc.text(t(TOURNAMENT_TITLE || "Tournament"), pageW / 2, 14, { align: "center" });
        doc.setFontSize(12);
        doc.text(t(page.label), pageW / 2, 21, { align: "center" });
        if (page.subtitle) {
            doc.setFont(font, "normal");
            doc.setFontSize(9);
            doc.text(t(page.subtitle), pageW / 2, 27, { align: "center" });
        }
    };
    const pdfCell = (c) => {
        if (!c || typeof c !== "object") return t(c);
        return { content: t(c.text), styles: { fontStyle: c.bold ? "bold" : "normal", textColor: c.muted ? [100, 100, 100] : ink } };
    };

    pages.forEach((page, pi) => {
        if (pi > 0) doc.addPage();
        drawHeader(page);
        let y = top;
        page.sections.forEach(sec => {
            if (y > pageH - 35) { doc.addPage(); drawHeader(page); y = top; }
            doc.setTextColor(...ink);
            doc.setFont(font, "bold");
            doc.setFontSize(10.5);
            doc.text(t(sec.heading), margin, y + 3);

            const columnStyles = {};
            sec.columns.forEach((c, i) => { columnStyles[i] = { halign: c.align === "left" ? "left" : "center" }; });
            doc.autoTable({
                startY: y + 5,
                margin: { left: margin, right: margin, top },
                head: [sec.columns.map(c => t(c.label))],
                body: sec.rows.length
                    ? sec.rows.map(r => r.map(pdfCell))
                    : [[{ content: t("—"), colSpan: sec.columns.length, styles: { halign: "center" } }]],
                theme: "grid",
                styles: { font, fontSize: 8.5, cellPadding: 1.3, lineColor: ink, lineWidth: 0.2, textColor: ink, valign: "middle" },
                headStyles: { font, fontStyle: "bold", fillColor: [241, 245, 249], textColor: ink, halign: "center" },
                columnStyles,
                didDrawPage: () => drawHeader(page),
            });
            y = doc.lastAutoTable.finalY + 4;
            if (sec.note) {
                doc.setFont(font, "normal");
                doc.setFontSize(8);
                const lines = doc.splitTextToSize(t(sec.note), pageW - 2 * margin);
                doc.text(lines, margin, y + 2);
                y += 4 * lines.length;
            }
            y += 4;
        });
    });

    const pageCount = doc.getNumberOfPages();
    for (let i = 1; i <= pageCount; i++) {
        doc.setPage(i);
        doc.setFont(font, "normal");
        doc.setFontSize(7.5);
        doc.setTextColor(100, 116, 139);
        doc.text(t(`Generated ${new Date().toLocaleString()}`), margin, pageH - 8);
        doc.text(`${i} / ${pageCount}`, pageW - margin, pageH - 8, { align: "right" });
    }
    doc.save(filename);
}

// ── Which format runs this match ─────────────────────────────────────
// `format` is written by the bracket builder ("solo" / "duel") and by
// inserted matches; older docs fall back on the red corner: a cut-off
// performance has none.
function poomsaeFormatOf(m) {
    if (m.format === "solo") return PoomsaeCutOff;
    if (m.format === "duel") return PoomsaeDuel;
    return m.red ? PoomsaeDuel : PoomsaeCutOff;
}

const PoomsaeDiscipline = {
    formatOf: poomsaeFormatOf,
    conflicts: () => new Map(), // no equipment in poomsae
    bulkFields: [
        { key: "roundSeconds", label: "Round Seconds", type: "number", placeholder: "unchanged, e.g. 90" },
    ],
    insert: {
        requiresRed: false, // no red → solo performance
        roundPhases: ["PR", "R32", "R16", "QF", "SF", "F"],
        fieldsHtml: () => `
            <label>Round Seconds <input type="number" min="10" id="insert-roundSeconds" value="90"></label>
            <label>&nbsp;</label>`,
        read: () => {
            const n = Number(document.getElementById("insert-roundSeconds").value);
            return Number.isFinite(n) && n > 0 ? { roundSeconds: Math.round(n) } : {};
        },
        format: (hasRed) => (hasRed ? "duel" : "solo"),
        actions: [],
    },
    // Single elimination and cut-off sheets are built into the common file
    // (the bracket builder's own BracketSheets layouts); round robin has none there.
    sheetKinds: [RoundRobinSheets],
    resultKinds: [RoundRobinResults],
};

startLiveQueue(PoomsaeDiscipline);