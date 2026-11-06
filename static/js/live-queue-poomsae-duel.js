/* live-queue-poomsae-duel.js — POOMSAE SIDE BY SIDE (head-to-head bouts:
 * single elimination or round robin). Loaded by
 * templates/dashboard/live_queue_poomsae.html after live-queue-common.js
 * and before live-queue-poomsae.js, which uses PoomsaeDuel (the format
 * module), RoundRobinSheets (bracket sheet kind) and RoundRobinResults
 * (results kind).
 *
 * Both athletes perform at the same time; Firebase Sync writes each
 * corner's finalScore + points[] per poomsae, `win` ("blue"/"red"),
 * `win_score` ("8.533-7.966") and `win_type`:
 *   PTS  higher score
 *   PRS  tie → higher presentation
 *   ALL  tie → higher total of all judges
 * A tie that is still undecided has no `win` and is settled on the floor.
 * Single-elimination draw sheets come from the common file (📄 Bracket
 * PDFs / Print New Results); round robin gets its own sheet here (bouts +
 * standings), printed and downloaded through live-queue-poomsae.js. */
"use strict";

const DUEL_WIN_TYPES = [
    ["PTS", "PTS — Higher score"],
    ["PRS", "PRS — Tie, higher presentation"],
    ["ALL", "ALL — Tie, higher total of all judges"],
    ["WDR", "WDR — Withdrawal"],
    ["DSQ", "DSQ — Disqualification"],
];

function duelScore(corner) {
    return corner && typeof corner.finalScore === "number" ? corner.finalScore : null;
}

// ── Row ──────────────────────────────────────────────────────────────
function duelRowExtraHtml(m) {
    const parts = [];
    const b = duelScore(m.blue), r = duelScore(m.red);
    if (b != null || r != null) {
        const chip = (score, side) => `<span class="lq-score${m.win === side ? " lq-score--win" : ""}" title="${side === "blue" ? "Blue" : "Red"}">${score != null ? poomsaeScoreText(score) : "—"}</span>`;
        parts.push(`${chip(b, "blue")} : ${chip(r, "red")}`);
    }
    if (m.win_type) parts.push(`<span class="lq-mini-badge" title="Decided by">${escapeHtml(String(m.win_type).toUpperCase())}</span>`);
    if (m.status === "completed" && !m.win && !m.winnerEntryId) {
        parts.push(`<span class="lq-mini-badge lq-mini-badge--tie" title="Scores are level — settle it on the floor">⚠ tie — undecided</span>`);
    }
    const drawn = poomsaeDrawnHtml(m);
    if (drawn) parts.push(drawn);
    return parts.join(" ");
}

// ── Result view (decided bout) ───────────────────────────────────────
// Winner and decision can be corrected; a changed winner is written
// forward into the next round (propagateWinnerChangeIfNeeded). Scores
// themselves come from the court and are read-only.
function openDuelResultModal(matchId) {
    const m = matchesById.get(matchId);
    if (!m) return;

    const blueName = participantLabel(m.blue);
    const redName = participantLabel(m.red);
    const canPickWinner = !!(m.blue && m.blue.entryId) && !!(m.red && m.red.entryId);
    const currentWin = m.win || (m.winnerEntryId && m.blue && m.winnerEntryId === m.blue.entryId ? "blue"
        : m.winnerEntryId && m.red && m.winnerEntryId === m.red.entryId ? "red" : "");
    const winType = String(m.win_type || "").toUpperCase();
    const video = m.video && m.video.id
        ? `<a href="https://youtu.be/${encodeURIComponent(m.video.id)}?t=${encodeURIComponent(m.video.t || 0)}" target="_blank" rel="noopener">▶ Video</a>` : "";

    openModal(`
        <div class="lq-modal-header">
            <h3>#${escapeHtml(String(m.displayNumber ?? "—"))} · ${escapeHtml(resolveCategoryLabel(m.categoryCode))} · Result</h3>
            <button class="lq-modal-close" onclick="closeModal()">&times;</button>
        </div>
        <div class="lq-modal-body">
            <p class="lq-field-hint" style="margin-bottom:1rem;">
                Side-by-side bout. Scores come from the court and can't be edited here; the winner and the
                decision can be corrected. Changing the winner also updates the next round's bout.
                ${video ? " · " + video : ""}
            </p>

            <div class="lq-detail-corners">
                <div class="lq-detail-corner blue">
                    <label>Blue · ${duelScore(m.blue) != null ? poomsaeScoreText(duelScore(m.blue)) : "—"}</label>
                    <div class="lq-corner-current">${escapeHtml(blueName)}</div>
                    ${poomsaePerformanceTableHtml(m.blue)}
                </div>
                <div class="lq-detail-corner red">
                    <label>Red · ${duelScore(m.red) != null ? poomsaeScoreText(duelScore(m.red)) : "—"}</label>
                    <div class="lq-corner-current">${escapeHtml(redName)}</div>
                    ${poomsaePerformanceTableHtml(m.red)}
                </div>
            </div>

            <div class="lq-detail-grid">
                <label>Winner
                    <select id="duel-winner" ${canPickWinner ? "" : "disabled"}>
                        <option value="" ${currentWin ? "" : "selected"}>— undecided —</option>
                        <option value="blue" ${currentWin === "blue" ? "selected" : ""}>${escapeHtml(blueName)} (Blue)</option>
                        <option value="red" ${currentWin === "red" ? "selected" : ""}>${escapeHtml(redName)} (Red)</option>
                    </select>
                </label>
                <label>Decided by
                    <select id="duel-win-type">
                        <option value="" ${winType ? "" : "selected"}>— none —</option>
                        ${DUEL_WIN_TYPES.map(([code, label]) => `<option value="${code}" ${winType === code ? "selected" : ""}>${escapeHtml(label)}</option>`).join("")}
                        ${winType && !DUEL_WIN_TYPES.some(([code]) => code === winType) ? `<option value="${escapeAttr(winType)}" selected>${escapeHtml(winType)} (current)</option>` : ""}
                    </select>
                </label>
            </div>

            ${canPickWinner ? "" : `<p class="lq-field-hint" style="margin-top:.5rem;">One corner still isn't a resolved athlete yet, so the winner can't be set here.</p>`}

            <div id="result-error" class="lq-alert-error hidden"></div>

            <div class="lq-modal-actions">
                <button class="btn btn-primary" id="duel-save-btn" ${canPickWinner ? "" : "disabled"}>Save Result</button>
                ${categorySheetButtonsHtml(m.categoryCode)}
                <button class="btn btn-ghost" onclick="closeModal()">Close</button>
            </div>
        </div>
    `);

    if (canPickWinner) document.getElementById("duel-save-btn").onclick = () => saveDuelResult(matchId);
}

async function saveDuelResult(matchId) {
    const m = matchesById.get(matchId);
    if (!m) return;
    const errEl = document.getElementById("result-error");
    errEl.classList.add("hidden");

    const side = document.getElementById("duel-winner").value; // "" | "blue" | "red"
    const winType = document.getElementById("duel-win-type").value || null;
    const winnerCorner = side === "blue" ? m.blue : side === "red" ? m.red : null;
    if (side && (!winnerCorner || !winnerCorner.entryId)) {
        errEl.textContent = "That corner has no resolved athlete yet — can't set them as the winner.";
        errEl.classList.remove("hidden");
        return;
    }
    const winnerEntryId = winnerCorner ? winnerCorner.entryId : null;

    const btn = document.getElementById("duel-save-btn");
    btn.disabled = true;
    btn.textContent = "Saving…";
    try {
        const batch = fsDb.batch();
        propagateWinnerChangeIfNeeded(m, winnerEntryId, batch);
        batch.set(matchDocRef(matchId), {
            win: side || null,
            win_type: side ? winType : null,
            winnerEntryId,
        }, { merge: true });
        await batch.commit();
        closeModal();
    } catch (err) {
        console.error("Save result failed", err);
        errEl.textContent = "Save failed: " + err.message;
        errEl.classList.remove("hidden");
        btn.disabled = false;
        btn.textContent = "Save Result";
    }
}

const PoomsaeDuel = {
    key: "poomsae_duel",
    solo: false,
    roundPhases: ["R32", "R16", "QF", "SF", "F"],
    statusOptions: [["pending", "Pending"], ["ready", "Ready"], ["completed", "Completed"], ["walkover", "Walkover"]],
    winnerStatuses: ["completed", "done", "walkover"],
    rowExtraHtml: duelRowExtraHtml,
    rowButtons: () => [POOMSAE_SHEET_ROW_BUTTON],
    onRowButton: (kind, m, btn) => poomsaeOnRowButton(kind, m, btn),
    detailFieldsHtml: (m) => poomsaeRoundSecondsField(m),
    detailUpdates: () => poomsaeRoundSecondsUpdate(),
    detailReadonlyHtml: (m) => poomsaeDrawnHtml(m),
    detailActionsHtml: (m) => categorySheetButtonsHtml(m.categoryCode),
    openResult: openDuelResultModal,
};

// ═══════════════════════════════════════════════════════════════════
// ROUND ROBIN — standings: wins first, then total score of all decided
// bouts, then fewer losses. Equal wins + total = equal place. The sheet
// (bouts + standings) works mid-competition too; the result is ready
// once every bout is decided. (Single-elimination side-by-side
// categories print as bracket sheets from the common file.)
// ═══════════════════════════════════════════════════════════════════

function duelMatchesOf(categoryCode) {
    return [...matchesById.values()].filter(m => m.categoryCode === categoryCode && poomsaeFormatOf(m) === PoomsaeDuel);
}

function roundRobinBoutOver(m) {
    return isDone(m) && (!!m.winnerEntryId || NOT_PERFORMED.has(m.status));
}

function roundRobinStandings(matches) {
    const table = {}; // entryId -> row
    const rowFor = (c) => table[c.entryId] || (table[c.entryId] = {
        entryId: c.entryId, name: c.name, club: c.clubName || "", country: c.country || "",
        bouts: 0, wins: 0, losses: 0, total: 0,
    });
    matches.forEach(m => {
        ["blue", "red"].forEach(side => {
            const c = m[side];
            if (!c || !c.entryId) return;
            const row = rowFor(c);
            row.name = c.name || row.name;
            if (!isDone(m)) return; // listed, but nothing counted yet
            row.bouts += 1;
            if (m.winnerEntryId === c.entryId) row.wins += 1;
            else if (m.winnerEntryId) row.losses += 1;
            const s = duelScore(c);
            if (s != null) row.total += s;
        });
    });

    const rows = Object.values(table).sort((a, b) => b.wins - a.wins || b.total - a.total || a.losses - b.losses || String(a.name).localeCompare(String(b.name)));
    rows.forEach((r, i) => {
        const prev = rows[i - 1];
        r.place = prev && prev.wins === r.wins && Math.abs(prev.total - r.total) < 1e-9 ? prev.place : i + 1;
        r.total = Math.round(r.total * 1000) / 1000;
    });
    return rows;
}

function buildRoundRobinResult(categoryCode) {
    const matches = duelMatchesOf(categoryCode);
    if (matches.length === 0) return null;
    if (!matches.every(roundRobinBoutOver)) return null;
    return { categoryCode, rows: roundRobinStandings(matches) };
}

function roundRobinWinnerText(m) {
    if (m.winnerEntryId) {
        const c = m.blue && m.blue.entryId === m.winnerEntryId ? m.blue : m.red;
        return participantLabel(c);
    }
    if (m.status === "completed") return "Tie — undecided";
    return statusInfo(m)[1];
}

function buildRoundRobinSheet(categoryCode, label) {
    const matches = duelMatchesOf(categoryCode).sort((a, b) =>
        (a.queuePosition ?? 0) - (b.queuePosition ?? 0) || (a.displayNumber ?? 0) - (b.displayNumber ?? 0));
    if (matches.length === 0) return null;
    const finished = matches.every(roundRobinBoutOver);
    const score = (c) => (duelScore(c) != null ? poomsaeScoreText(duelScore(c)) : "—");

    return {
        label,
        subtitle: finished ? "Round robin — final results" : "Round robin — in progress",
        sections: [
            {
                heading: finished ? "Standings" : "Standings so far",
                columns: [
                    { label: "Place" }, { label: "Athlete", align: "left" }, { label: "Club", align: "left" }, { label: "NOC" },
                    { label: "Bouts" }, { label: "Won" }, { label: "Lost" }, { label: "Total score" },
                ],
                rows: roundRobinStandings(matches).map(r => [
                    String(r.place), { text: r.name || "—", bold: true }, r.club, r.country,
                    String(r.bouts), { text: String(r.wins), bold: true }, String(r.losses), poomsaeScoreText(r.total),
                ]),
                note: "Ranked by bouts won, then by total score.",
            },
            {
                heading: "Bouts",
                columns: [
                    { label: "Match" }, { label: "Blue", align: "left" }, { label: "Score" },
                    { label: "Red", align: "left" }, { label: "Score" }, { label: "Winner", align: "left" }, { label: "Decided by" },
                ],
                rows: matches.map(m => [
                    m.displayNumber != null ? String(m.displayNumber) : "—",
                    { text: participantLabel(m.blue), bold: m.win === "blue" },
                    score(m.blue),
                    { text: participantLabel(m.red), bold: m.win === "red" },
                    score(m.red),
                    roundRobinWinnerText(m),
                    m.win_type ? String(m.win_type).toUpperCase() : "",
                ]),
            },
        ],
    };
}

function roundRobinDocs(bracketDocs) {
    return Object.values(bracketDocs).filter(doc => doc.system === "round_robin");
}

// 📄 Bracket PDFs / row button — every round-robin category.
const RoundRobinSheets = {
    kind: "round_robin_sheet",
    title: "Round robin",
    fileSuffix: "round_robin",
    collect: (bracketDocs) => roundRobinDocs(bracketDocs).map(doc => {
        const label = doc.categoryLabel || resolveCategoryLabel(doc.categoryCode);
        const page = buildRoundRobinSheet(doc.categoryCode, label);
        return page ? { code: doc.categoryCode, label, page } : null;
    }).filter(Boolean),
    print: (items) => printPoomsaeSheets(items.map(i => i.page)),
    download: (items, filename) => downloadPoomsaeSheetsPdf(items.map(i => i.page), filename),
};

// 🖨 Print New Results — finished round-robin categories.
const RoundRobinResults = {
    kind: "round_robin",
    title: "Round robin",
    fileSuffix: "round_robin_results",
    collect: (bracketDocs) => roundRobinDocs(bracketDocs).map(doc => {
        const result = buildRoundRobinResult(doc.categoryCode);
        if (!result) return null;
        const label = doc.categoryLabel || resolveCategoryLabel(doc.categoryCode);
        return { code: doc.categoryCode, label, result, page: buildRoundRobinSheet(doc.categoryCode, label), fingerprint: fingerprintOf(result.rows) };
    }).filter(Boolean),
    print: (items) => printPoomsaeSheets(items.map(i => i.page)),
    download: (items, filename) => downloadPoomsaeSheetsPdf(items.map(i => i.page), filename),
};