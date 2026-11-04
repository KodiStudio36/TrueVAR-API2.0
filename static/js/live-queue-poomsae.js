/* live-queue-poomsae.js — loaded LAST by templates/dashboard/live_queue_poomsae.html,
 * after live-queue-common.js, live-queue-poomsae-cutoff.js and
 * live-queue-poomsae-duel.js (see the contract in live-queue-common.js).
 *
 * Poomsae runs two ways, each in its own file:
 *   cut-off       solo performances, PR → SF → F    live-queue-poomsae-cutoff.js
 *   side by side  head-to-head bouts (single         live-queue-poomsae-duel.js
 *                 elimination / round robin)
 * This file holds what both share (score formatting, the per-poomsae
 * score table, drawn poomsae, round time) and the discipline object that
 * picks the format of every match, then starts the page. No PSS vests,
 * helmets or TA sheets in poomsae. */
"use strict";

// ── Shared poomsae helpers ───────────────────────────────────────────
function poomsaeScoreText(v) {
    return typeof v === "number" && Number.isFinite(v) ? v.toFixed(3) : "—";
}

// Drawn poomsae for this match (pushed by the bracket builder from the
// Poomsae Draw page): [{key, name}] → "Koryo + Taebaek".
function poomsaeDrawnHtml(m) {
    const list = Array.isArray(m.poomsae) ? m.poomsae : [];
    const names = list.map(p => (p && (p.name || p.key)) || "").filter(Boolean);
    return names.length ? `<span class="lq-mini-badge" title="Drawn poomsae">${escapeHtml(names.join(" + "))}</span>` : "";
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
    resultKinds: [CutOffResults, RoundRobinResults],
};

startLiveQueue(PoomsaeDiscipline);