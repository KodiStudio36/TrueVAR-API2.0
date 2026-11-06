/* live-queue-poomsae-cutoff.js — POOMSAE CUT-OFF (solo performances).
 * Loaded by templates/dashboard/live_queue_poomsae.html after
 * live-queue-common.js and before live-queue-poomsae.js, which uses
 * PoomsaeCutOff (the format module).
 *
 * A cut-off category is a list of solo performances per round
 * (PR → SF → F). Firebase Sync writes the score (blue.finalScore +
 * blue.points[] per poomsae, status "completed"); processCutOffPerformance
 * (Cloud Function) ranks the round once its last performance is in,
 * writes `rank`, `qualified` and `tieAtCutLine`, and fills the next
 * round's placeholder slots (blue.pendingAdvancement) in performance order.
 *
 * Its bracket sheet is the bracket builder's own cut-off sheet
 * (BracketSheets), rebuilt in live-queue-common.js with every saved score
 * and place written into its columns — printed and downloaded from
 * 📄 Bracket PDFs, the 📄 row button and Print New Results. Placements go
 * onto the rosters through 🏅 Compute Results, like side by side.
 *
 * Shared poomsae helpers (poomsaeScoreText, poomsaePerformanceTableHtml,
 * poomsaeDrawnHtml, poomsaeRoundSecondsField…) live in live-queue-poomsae.js
 * — only called at run time, so load order is fine. */
"use strict";

const CUT_OFF_PHASE_NAMES = { F: "Final", SF: "Semi-Final", PR: "Preliminary" };

// Score of one finished performance, or null.
function cutOffScore(m) {
    const s = m.blue && m.blue.finalScore;
    return typeof s === "number" && m.status === "completed" ? s : null;
}

function cutOffMatchesOf(categoryCode) {
    return [...matchesById.values()].filter(m => m.categoryCode === categoryCode && poomsaeFormatOf(m) === PoomsaeCutOff);
}

// ── Row ──────────────────────────────────────────────────────────────
function cutOffRowExtraHtml(m) {
    const parts = [];
    const score = cutOffScore(m);
    if (score != null) parts.push(`<span class="lq-score" title="Final score">${poomsaeScoreText(score)}</span>`);
    if (m.rank != null) parts.push(`<span class="lq-mini-badge" title="Place in this round">#${escapeHtml(String(m.rank))}</span>`);
    if (m.qualified === true) parts.push(`<span class="lq-mini-badge lq-mini-badge--qualified" title="Goes through to the next round">Q</span>`);
    if (m.tieAtCutLine) parts.push(`<span class="lq-mini-badge lq-mini-badge--tie" title="Tie at the cut line — check before the next round starts">⚠ tie at cut</span>`);
    if (m.blue && m.blue.advancedFrom) {
        const f = m.blue.advancedFrom;
        parts.push(`<span class="lq-mini-badge" title="Qualified from ${escapeAttr(f.roundPhase || "")}">from ${escapeHtml(f.roundPhase || "?")}${f.rank != null ? ` #${escapeHtml(String(f.rank))}` : ""}</span>`);
    }
    const drawn = poomsaeDrawnHtml(m);
    if (drawn) parts.push(drawn);
    return parts.join(" ");
}

// ── Result view (decided performance) ────────────────────────────────
// Scores come from the court, so they're read-only here: a wrong score is
// fixed by rescoring on the court, after which the round is ranked again.
// A performance marked DNS / withdrawn / disqualified can be put back to
// Ready from here.
function openCutOffResultModal(matchId) {
    const m = matchesById.get(matchId);
    if (!m) return;
    const score = cutOffScore(m);
    const notPerformed = NOT_PERFORMED.has(m.status);
    const video = m.video && m.video.id
        ? `<a href="https://youtu.be/${encodeURIComponent(m.video.id)}?t=${encodeURIComponent(m.video.t || 0)}" target="_blank" rel="noopener">▶ Video</a>` : "";

    openModal(`
        <div class="lq-modal-header">
            <h3>#${escapeHtml(String(m.displayNumber ?? "—"))} · ${escapeHtml(resolveCategoryLabel(m.categoryCode))} · ${escapeHtml(CUT_OFF_PHASE_NAMES[m.roundPhase] || m.roundPhase || "")}</h3>
            <button class="lq-modal-close" onclick="closeModal()">&times;</button>
        </div>
        <div class="lq-modal-body">
            <div class="lq-detail-corners">
                <div class="lq-detail-corner blue" style="grid-column: span 2;">
                    <label>Athlete</label>
                    <div class="lq-corner-current">${escapeHtml(participantLabel(m.blue))}
                        ${m.blue && m.blue.clubName ? `<span style="color:var(--lq-muted); font-weight:400;"> · ${escapeHtml(m.blue.clubName)}</span>` : ""}</div>
                </div>
            </div>

            <div class="lq-detail-grid">
                <label>Final score <input type="text" value="${score != null ? poomsaeScoreText(score) : "—"}" disabled></label>
                <label>Status <input type="text" value="${escapeAttr(statusInfo(m)[1])}" disabled></label>
                <label>Place in round <input type="text" value="${m.rank != null ? escapeAttr(String(m.rank)) : "—"}" disabled></label>
                <label>Goes through <input type="text" value="${m.qualified === true ? "Yes" : m.qualified === false ? "No" : "—"}" disabled></label>
            </div>
            ${m.tieAtCutLine ? `<div class="lq-alert-error" style="margin-top:.5rem;">Tie at the cut line — the athletes on the line share a place; check the next round's line-up before it starts.</div>` : ""}

            ${poomsaePerformanceTableHtml(m.blue)}

            <p class="lq-field-hint" style="margin-top:.75rem;">
                ${notPerformed
            ? "This performance didn't happen. Put it back to Ready if the athlete will still perform."
            : "Scores come from the court and can't be edited here — rescore on the court to correct one; the round is ranked again when it saves."}
                ${video ? " · " + video : ""}
            </p>

            <div id="result-error" class="lq-alert-error hidden"></div>

            <div class="lq-modal-actions">
                ${notPerformed ? `<button class="btn btn-primary" id="cutoff-reset-btn">Set back to Ready</button>` : ""}
                ${categorySheetButtonsHtml(m.categoryCode)}
                <button class="btn btn-ghost" onclick="closeModal()">Close</button>
            </div>
        </div>
    `);

    if (notPerformed) document.getElementById("cutoff-reset-btn").onclick = () => resetCutOffPerformance(matchId);
}

async function resetCutOffPerformance(matchId) {
    const btn = document.getElementById("cutoff-reset-btn");
    btn.disabled = true;
    btn.textContent = "Saving…";
    try {
        await matchDocRef(matchId).set({ status: "ready" }, { merge: true });
        closeModal();
    } catch (err) {
        console.error("Reset failed", err);
        const errEl = document.getElementById("result-error");
        errEl.textContent = "Save failed: " + err.message;
        errEl.classList.remove("hidden");
        btn.disabled = false;
        btn.textContent = "Set back to Ready";
    }
}

const PoomsaeCutOff = {
    key: "poomsae_cutoff",
    solo: true,
    roundPhases: ["PR", "SF", "F"],
    statusOptions: [
        ["pending", "Pending"], ["ready", "Ready"],
        ["dns", "DNS — did not start"], ["withdrawn", "Withdrawn"], ["dsq", "Disqualified"],
    ],
    winnerStatuses: [],
    rowExtraHtml: cutOffRowExtraHtml,
    rowButtons: () => [POOMSAE_SHEET_ROW_BUTTON],
    onRowButton: (kind, m, btn) => poomsaeOnRowButton(kind, m, btn),
    detailFieldsHtml: (m) => poomsaeRoundSecondsField(m),
    detailUpdates: () => poomsaeRoundSecondsUpdate(),
    detailReadonlyHtml: (m) => poomsaeDrawnHtml(m),
    detailActionsHtml: (m) => categorySheetButtonsHtml(m.categoryCode),
    openResult: openCutOffResultModal,
};