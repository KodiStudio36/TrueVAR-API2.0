/* live-queue-poomsae-duel.js — POOMSAE SIDE BY SIDE (head-to-head bouts:
 * single elimination or round robin). Loaded by
 * templates/dashboard/live_queue_poomsae.html after live-queue-common.js
 * and before live-queue-poomsae.js, which uses PoomsaeDuel (the format
 * module) and RoundRobinResults (the results kind).
 *
 * Both athletes perform at the same time; Firebase Sync writes each
 * corner's finalScore + points[] per poomsae, `win` ("blue"/"red"),
 * `win_score` ("8.533-7.966") and `win_type`:
 *   PTS  higher score
 *   PRS  tie → higher presentation
 *   ALL  tie → higher total of all judges
 * A tie that is still undecided has no `win` and is settled on the floor.
 * Single-elimination draw sheets come from the common file (📄 Bracket
 * PDFs / Print New Results); round robin prints a standings table here. */
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
    detailFieldsHtml: (m) => poomsaeRoundSecondsField(m),
    detailUpdates: () => poomsaeRoundSecondsUpdate(),
    detailReadonlyHtml: (m) => poomsaeDrawnHtml(m),
    openResult: openDuelResultModal,
};

// ═══════════════════════════════════════════════════════════════════
// RESULTS — round robin standings, once every bout of the category is
// decided: wins first, then total score of all bouts, then fewer losses.
// Equal wins + total = equal place. (Single-elimination side-by-side
// categories print as bracket sheets from the common file.)
// ═══════════════════════════════════════════════════════════════════

function buildRoundRobinResult(categoryCode) {
    const matches = [...matchesById.values()].filter(m => m.categoryCode === categoryCode && poomsaeFormatOf(m) === PoomsaeDuel);
    if (matches.length === 0) return null;
    if (!matches.every(m => isDone(m) && (m.winnerEntryId || NOT_PERFORMED.has(m.status)))) return null;

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
    return { categoryCode, rows };
}

function roundRobinResultHtml(result, label) {
    const body = result.rows.map(r => `<tr>
            ${resultCellHtml(escapeHtml(String(r.place)))}
            ${resultCellHtml(`<strong>${escapeHtml(r.name || "—")}</strong>`, "text-align:left;")}
            ${resultCellHtml(escapeHtml(r.club), "text-align:left;")}
            ${resultCellHtml(escapeHtml(r.country))}
            ${resultCellHtml(r.bouts)}
            ${resultCellHtml(`<strong>${r.wins}</strong>`)}
            ${resultCellHtml(r.losses)}
            ${resultCellHtml(poomsaeScoreText(r.total))}
        </tr>`).join("");
    return resultsTablePageHtml(label, [
        { label: "Place" }, { label: "Athlete", left: true }, { label: "Club", left: true }, { label: "NOC" },
        { label: "Bouts" }, { label: "Won" }, { label: "Lost" }, { label: "Total score" },
    ], body, "Round robin — ranked by bouts won, then by total score.");
}

const RoundRobinResults = {
    kind: "round_robin",
    collect: (bracketDocs) => Object.values(bracketDocs)
        .filter(doc => doc.system === "round_robin")
        .map(doc => {
            const result = buildRoundRobinResult(doc.categoryCode);
            if (!result) return null;
            return {
                code: doc.categoryCode, label: doc.categoryLabel || resolveCategoryLabel(doc.categoryCode),
                result, fingerprint: fingerprintOf(result.rows),
            };
        })
        .filter(Boolean),
    print: (items) => printHtmlInFrame(items.map(i => roundRobinResultHtml(i.result, i.label)).join("")),
};