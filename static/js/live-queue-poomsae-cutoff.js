/* live-queue-poomsae-cutoff.js — POOMSAE CUT-OFF (solo performances).
 * Loaded by templates/dashboard/live_queue_poomsae.html after
 * live-queue-common.js and before live-queue-poomsae.js, which uses
 * PoomsaeCutOff (the format module) and CutOffResults (the results kind).
 *
 * A cut-off category is a list of solo performances per round
 * (PR → SF → F). Firebase Sync writes the score (blue.finalScore +
 * blue.points[] per poomsae, status "completed"); processCutOffPerformance
 * (Cloud Function) ranks the round once its last performance is in,
 * writes `rank`, `qualified` and `tieAtCutLine`, and fills the next
 * round's placeholder slots (blue.pendingAdvancement) in performance order.
 * Shared poomsae helpers (poomsaeScoreText, poomsaePerformanceTableHtml,
 * poomsaeDrawnHtml, poomsaeRoundSecondsField…) live in live-queue-poomsae.js. */
"use strict";

const CUT_OFF_PHASES = ["F", "SF", "PR"]; // results print order: Final first
const CUT_OFF_PHASE_NAMES = { F: "Final", SF: "Semi-Final", PR: "Preliminary" };

// Score of one finished performance, or null.
function cutOffScore(m) {
    const s = m.blue && m.blue.finalScore;
    return typeof s === "number" && m.status === "completed" ? s : null;
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
    detailFieldsHtml: (m) => poomsaeRoundSecondsField(m),
    detailUpdates: () => poomsaeRoundSecondsUpdate(),
    detailReadonlyHtml: (m) => poomsaeDrawnHtml(m),
    openResult: openCutOffResultModal,
};

// ═══════════════════════════════════════════════════════════════════
// RESULTS — one "Print New Results" item per cut-off category, ready once
// every Final performance is in: Final ranking first, then the
// Semi-Final and Preliminary athletes who didn't go through, each with
// their score per round. Equal rank = equal place.
// ═══════════════════════════════════════════════════════════════════

function buildCutOffResult(categoryCode) {
    const matches = [...matchesById.values()].filter(m => m.categoryCode === categoryCode && poomsaeFormatOf(m) === PoomsaeCutOff);
    const byPhase = {};
    matches.forEach(m => { (byPhase[m.roundPhase] = byPhase[m.roundPhase] || []).push(m); });
    const final = byPhase.F || [];
    if (final.length === 0) return null;
    const finalOver = final.every(m => m.status === "completed" || NOT_PERFORMED.has(m.status) || (m.blue && m.blue.empty));
    if (!finalOver) return null;

    // entryId -> { name, club, country, scores: {phase: score} }
    const athletes = {};
    matches.forEach(m => {
        const b = m.blue || {};
        if (!b.entryId) return;
        const a = athletes[b.entryId] || (athletes[b.entryId] = { entryId: b.entryId, name: b.name, club: b.clubName || "", country: b.country || "", scores: {} });
        a.name = b.name || a.name;
        a.scores[m.roundPhase] = cutOffScore(m);
    });

    const rows = [];
    const placed = new Set();
    let offset = 0;
    CUT_OFF_PHASES.forEach(phase => {
        const group = (byPhase[phase] || [])
            .filter(m => m.blue && m.blue.entryId && !placed.has(m.blue.entryId))
            .map(m => ({ m, score: cutOffScore(m) }))
            .sort((x, y) => (x.m.rank ?? Infinity) - (y.m.rank ?? Infinity)
                || (y.score ?? -1) - (x.score ?? -1)
                || (x.m.matchNumber ?? 0) - (y.m.matchNumber ?? 0));
        group.forEach((g, i) => {
            const prev = group[i - 1];
            const same = prev && prev.score != null && g.score != null
                && (g.m.rank != null ? g.m.rank === prev.m.rank : g.score === prev.score);
            const place = g.score == null ? null : (same ? rows[rows.length - 1].place : offset + i + 1);
            rows.push({ ...athletes[g.m.blue.entryId], place, phase });
            placed.add(g.m.blue.entryId);
        });
        offset += group.length;
    });
    const phases = CUT_OFF_PHASES.filter(p => byPhase[p] && byPhase[p].length);
    return { categoryCode, rows, phases };
}

function cutOffResultHtml(result, label) {
    const fmt = v => (typeof v === "number" ? poomsaeScoreText(v) : "—");
    const body = result.rows.map(r => `<tr>
            ${resultCellHtml(r.place == null ? "—" : escapeHtml(String(r.place)))}
            ${resultCellHtml(`<strong>${escapeHtml(r.name || "—")}</strong>`, "text-align:left;")}
            ${resultCellHtml(escapeHtml(r.club || ""), "text-align:left;")}
            ${resultCellHtml(escapeHtml(r.country || ""))}
            ${result.phases.map(p => resultCellHtml(fmt(r.scores[p]), p === r.phase ? "text-align:center; font-weight:700;" : "text-align:center; color:#555;")).join("")}
        </tr>`).join("");
    const headers = [
        { label: "Place" }, { label: "Athlete", left: true }, { label: "Club", left: true }, { label: "NOC" },
        ...result.phases.map(p => ({ label: CUT_OFF_PHASE_NAMES[p] || p })),
    ];
    return resultsTablePageHtml(label, headers, body);
}

// Cut-off categories: from the bracket docs (system "cut_off"), plus any
// category whose matches are solo performances without a bracket doc.
function cutOffCategoryCodes(bracketDocs) {
    const codes = new Set(Object.values(bracketDocs).filter(d => d.system === "cut_off").map(d => d.categoryCode));
    matchesById.forEach(m => {
        if (m.categoryCode && !bracketDocs[m.categoryCode] && poomsaeFormatOf(m) === PoomsaeCutOff) codes.add(m.categoryCode);
    });
    return [...codes];
}

const CutOffResults = {
    kind: "cutoff",
    collect: (bracketDocs) => cutOffCategoryCodes(bracketDocs).map(code => {
        const result = buildCutOffResult(code);
        if (!result) return null;
        const doc = bracketDocs[code];
        return {
            code, label: (doc && doc.categoryLabel) || resolveCategoryLabel(code),
            result, fingerprint: fingerprintOf(result.rows),
        };
    }).filter(Boolean),
    print: (items) => printHtmlInFrame(items.map(i => cutOffResultHtml(i.result, i.label)).join("")),
};