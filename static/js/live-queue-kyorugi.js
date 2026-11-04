/* live-queue-kyorugi.js — loaded by templates/dashboard/live_queue_kyorugi.html,
 * after live-queue-common.js (see the contract at the top of that file).
 *
 * Kyorugi only: PSS vest / plexi helmet conflict detection, the TA / KO /
 * Protest / Friendly sheets, the decided-fight result editor (winner,
 * WT decision code, round score, round-by-round PSS breakdown), and the
 * kyorugi fields of bulk edit, insert and the detail editor. */
"use strict";

// pdf.js only RASTERIZES the KO / Protest / Friendly PDF templates before
// printing (renderPdfUrlToPngDataUrls) — its worker must be pointed at.
if (window.pdfjsLib) {
    pdfjsLib.GlobalWorkerOptions.workerSrc = "https://cdnjs.cloudflare.com/ajax/libs/pdf.js/3.11.174/pdf.worker.min.js";
}

// Equipment configuration pushed by the kyorugi bracket builder (courts,
// vest inventory, plexi count, transfer buffer, assumed rounds), from
// tournaments/{id}/meta/equipment — loaded once.
let equipmentMeta = null;

async function loadEquipmentMeta() {
    try {
        const doc = await fsDb.collection("tournaments").doc(TOURNAMENT_ID).collection("meta").doc("equipment").get();
        equipmentMeta = doc.exists ? doc.data() : null;
        renderCourts();
    } catch (err) {
        console.error("Failed to load equipment meta", err);
    }
}

// ═══════════════════════════════════════════════════════════════════
// EQUIPMENT CONFLICT DETECTION — a port of the bracket builder's
// revalidateEquipmentAfterManualEdit(), re-run against LIVE court order.
// Simulates every court in parallel (always advance the court whose clock
// is earliest), checking each match's already-resolved vest generation
// and plexi requirement against the inventory + transfer buffer.
// ═══════════════════════════════════════════════════════════════════

function parseMinSec(str) {
    const m = /^(\d+):(\d{2})$/.exec(str || "");
    return m ? parseInt(m[1]) * 60 + parseInt(m[2]) : 120;
}

function estimateMatchDurationSecondsFromMatch(m) {
    const rounds = (equipmentMeta && equipmentMeta.assumedRoundsPerMatch) || 3;
    const round = parseMinSec(m.roundTime);
    const brk = parseMinSec(m.breakTime);
    return round * rounds + brk * (rounds - 1) + 60;
}

function vestKey(pssSize, gen) { return `${pssSize}-${gen}`; }

function overlapCount(list, start, end, excludeCourtId) {
    return list.filter(iv => start < iv.end && end > iv.start && iv.courtId !== excludeCourtId).length;
}

function checkVestAvailabilityLive(tracker, pssSize, gen, start, end, courtId) {
    const inventory = (equipmentMeta && equipmentMeta.vestInventory) || {};
    const key = vestKey(pssSize, gen);
    const capacity = inventory[key] || 0;
    if (capacity < 2) return { ok: false, reason: `no gen${String(gen).replace("gen", "")} size-${pssSize} VESTS configured` };
    const used = overlapCount(tracker.intervals[key] || [], start, end, courtId);
    if (capacity - used >= 2) return { ok: true };
    return { ok: false, reason: `no gen${String(gen).replace("gen", "")} size-${pssSize} VESTS free` };
}

function checkPlexiAvailabilityLive(tracker, start, end, courtId) {
    const capacity = (equipmentMeta && equipmentMeta.plexiHelmetCount) || 0;
    const used = overlapCount(tracker.plexiIntervals, start, end, courtId);
    return (capacity - used >= 2) ? { ok: true } : { ok: false, reason: "no plexi HELMETS free" };
}

function reserveVestLive(tracker, pssSize, gen, start, end, courtId) {
    const key = vestKey(pssSize, gen);
    (tracker.intervals[key] = tracker.intervals[key] || []).push({ start, end, courtId });
}
function reservePlexiLive(tracker, start, end, courtId) {
    tracker.plexiIntervals.push({ start, end, courtId });
}

// -> Map<matchId, conflictReason>
function computeEquipmentConflicts(byCourt) {
    const conflicts = new Map();
    if (!equipmentMeta || !Array.isArray(equipmentMeta.courts) || equipmentMeta.courts.length === 0) return conflicts;

    const tracker = { intervals: {}, plexiIntervals: [] };
    const courtClockSeconds = {};
    const queues = {};
    const pointer = {};
    const courtConfigById = {};
    equipmentMeta.courts.forEach(c => { courtConfigById[c.id] = c; });

    equipmentMeta.courts.forEach(c => {
        courtClockSeconds[c.id] = 0;
        pointer[c.id] = 0;
        queues[c.id] = (byCourt[c.id] || [])
            .filter(m => m.status !== "walkover")
            .slice()
            .sort((a, b) => (a.queuePosition ?? 0) - (b.queuePosition ?? 0));
    });

    let remaining = Object.values(queues).reduce((n, q) => n + q.length, 0);
    while (remaining > 0) {
        let bestCourtId = null;
        equipmentMeta.courts.forEach(c => {
            if (pointer[c.id] >= queues[c.id].length) return;
            if (bestCourtId === null || courtClockSeconds[c.id] < courtClockSeconds[bestCourtId]) bestCourtId = c.id;
        });
        if (bestCourtId === null) break;

        const m = queues[bestCourtId][pointer[bestCourtId]];
        pointer[bestCourtId]++;
        remaining--;

        const start = courtClockSeconds[bestCourtId];
        const duration = estimateMatchDurationSecondsFromMatch(m);
        const buffer = (equipmentMeta.transferBufferSeconds) || 0;
        const end = start + duration + buffer;

        let conflict = null;

        if (m.requiresPlexiHelmet) {
            const plexiCheck = checkPlexiAvailabilityLive(tracker, start, end, bestCourtId);
            if (!plexiCheck.ok) conflict = plexiCheck.reason;
            else reservePlexiLive(tracker, start, end, bestCourtId);
        }

        if (m.pssSize != null && m.resolvedVestGen) {
            // Court gen lock first — a court locked to another generation
            // can never satisfy this match, whatever the inventory.
            const courtConfig = courtConfigById[bestCourtId];
            const lockedGen = courtConfig && courtConfig.allowedVestGen;
            if (lockedGen && lockedGen !== "any" && lockedGen !== m.resolvedVestGen) {
                const lockMsg = `court locked to ${lockedGen}, this match needs ${m.resolvedVestGen} VEST`;
                conflict = conflict ? `${conflict}; ${lockMsg}` : lockMsg;
            } else {
                const vestCheck = checkVestAvailabilityLive(tracker, m.pssSize, m.resolvedVestGen, start, end, bestCourtId);
                if (!vestCheck.ok) {
                    conflict = conflict ? `${conflict}; ${vestCheck.reason}` : vestCheck.reason;
                } else {
                    reserveVestLive(tracker, m.pssSize, m.resolvedVestGen, start, end, bestCourtId);
                }
            }
        }

        if (conflict) conflicts.set(m.id, conflict);
        courtClockSeconds[bestCourtId] = end - buffer;
    }

    return conflicts;
}

// Row badges: vest gen, plexi, "relaxed" (scheduled through the guard-
// limit overflow path) and any live conflict.
function equipmentBadgesHtml(m, conflictReason) {
    const parts = [];
    if (m.resolvedVestGen) parts.push(`<span class="lq-mini-badge">${escapeHtml(m.resolvedVestGen)}</span>`);
    if (m.requiresPlexiHelmet) parts.push(`<span class="lq-mini-badge">plexi</span>`);
    if (m.scheduledWithRelaxedConstraints) parts.push(`<span class="lq-mini-badge lq-mini-badge--relaxed">relaxed</span>`);
    if (conflictReason) {
        const upper = conflictReason.toUpperCase();
        const label = upper.includes("VEST") && upper.includes("HELMET") ? "vest+helmet" : upper.includes("HELMET") ? "helmet" : "vest";
        parts.push(`<span class="lq-mini-badge lq-mini-badge--conflict" title="${escapeAttr(conflictReason)}">⚠ ${label}</span>`);
    }
    return parts.join(" ");
}

// One-off lookup for the detail modal (re-runs the whole simulation).
function equipmentConflictFor(matchId) {
    return computeEquipmentConflicts(groupByCourtSorted()).get(matchId);
}

// ═══════════════════════════════════════════════════════════════════
// PRINTABLE SHEETS — TA (canvas-filled template image) and KO / Protest /
// Friendly (real PDF templates printed as-is, rasterized by pdf.js).
// Templates live in /static/assets/sheets/. Only TA's coordinates were
// measured against the real template.
// ═══════════════════════════════════════════════════════════════════
const SHEET_CONFIGS = {
    ta: {
        title: "TA Sheet",
        templateUrl: "/static/assets/sheets/ta-sheet-template.jpg",
        fillFields: true,
        eventNameBox: { x0: 300, y0: 91, x1: 470, y1: 117 },
        fields: {
            date: [275, 150, 14, "right", 120],
            court_no: [692, 150, 14, "right", 120],
            match_no: [275, 186, 14, "right", 120],
            weight_category: [472, 186, 14, "right", 120],
            hit_level: [588, 186, 14, "right", 120],
            pss_size: [692, 186, 14, "right", 120],
            chung_name: [150, 262, 14, "left", 225],
            chung_noc: [150, 289, 14, "left", 225],
            hong_name: [472, 262, 14, "left", 225],
            hong_noc: [472, 289, 14, "left", 225],
        },
    },
    friendly: {
        title: "Friendly Match Sheet",
        templateUrl: "/static/assets/sheets/friendly-sheet-template.pdf",
        fillFields: false,
    },
    ko: {
        title: "KO Sheet",
        templateUrl: "/static/assets/sheets/ko-sheet-template.pdf",
        fillFields: false,
    },
    protest: {
        title: "Protest Sheet",
        templateUrl: "/static/assets/sheets/protest-sheet-template.pdf",
        fillFields: false,
    },
};

let sheetTemplateImagePromises = {};
function loadSheetTemplateImage(kind) {
    if (!sheetTemplateImagePromises[kind]) {
        sheetTemplateImagePromises[kind] = new Promise((resolve, reject) => {
            const img = new Image();
            img.crossOrigin = "anonymous";
            img.onload = () => resolve(img);
            img.onerror = () => reject(new Error(`Couldn't load the ${SHEET_CONFIGS[kind].title} template image.`));
            img.src = SHEET_CONFIGS[kind].templateUrl;
        });
    }
    return sheetTemplateImagePromises[kind];
}

function taSheetFitFont(ctx, text, startSize, maxWidth, minSize = 6) {
    let size = startSize;
    while (size > minSize) {
        ctx.font = `bold ${size}px Arial, sans-serif`;
        if (ctx.measureText(text).width <= maxWidth) return size;
        size -= 1;
    }
    ctx.font = `bold ${minSize}px Arial, sans-serif`;
    return minSize;
}

// Today's date from the browser clock — day 2's sheets need day 2's date.
function formatTodayForTaSheet() {
    const d = new Date();
    const day = String(d.getDate()).padStart(2, "0");
    const month = d.toLocaleString("en-US", { month: "short" });
    return `${day} ${month} ${d.getFullYear()}`;
}

// Weight is only in the label ("… Male -45kg") or the code's last part.
function taSheetDeriveWeightCategory(categoryCode, categoryLabel) {
    const fromLabel = (categoryLabel || "").match(/[-+]\s?\d+(\.\d+)?/);
    if (fromLabel) return fromLabel[0].replace(/\s/g, "");
    const tail = (categoryCode || "").split("_").pop();
    if (tail && /^\d+(\.\d+)?$/.test(tail)) return tail;
    return categoryLabel || categoryCode || "";
}

async function buildSheetDataUrl(m, kind) {
    const config = SHEET_CONFIGS[kind];
    const img = await loadSheetTemplateImage(kind);
    const canvas = document.createElement("canvas");
    canvas.width = img.naturalWidth;
    canvas.height = img.naturalHeight;
    const ctx = canvas.getContext("2d");
    ctx.drawImage(img, 0, 0);
    ctx.fillStyle = "#000";
    ctx.textBaseline = "top";

    // Whiteout + rewrite the event name.
    const box = config.eventNameBox;
    ctx.fillStyle = "#fff";
    ctx.fillRect(box.x0, box.y0, box.x1 - box.x0, box.y1 - box.y0);
    ctx.fillStyle = "#000";
    const eventName = TOURNAMENT_TITLE || "";
    if (eventName) {
        ctx.textAlign = "center";
        ctx.textBaseline = "middle";
        taSheetFitFont(ctx, eventName, 17, (box.x1 - box.x0) - 8, 9);
        ctx.fillText(eventName, (box.x0 + box.x1) / 2, (box.y0 + box.y1) / 2);
        ctx.textBaseline = "top";
    }

    const data = {
        date: formatTodayForTaSheet(),
        court_no: m.courtId || "",
        match_no: m.displayNumber != null ? String(m.displayNumber) : "",
        weight_category: taSheetDeriveWeightCategory(m.categoryCode, m.categoryLabel || resolveCategoryLabel(m.categoryCode)),
        hit_level: m.hitLevel != null ? String(m.hitLevel) : "",
        pss_size: m.pssSize != null ? String(m.pssSize) : "",
        chung_name: m.blue?.name || "",
        chung_noc: m.blue?.country || "",
        hong_name: m.red?.name || "",
        hong_noc: m.red?.country || "",
    };

    for (const [key, [x, y, startSize, align, maxWidth]] of Object.entries(config.fields)) {
        const text = data[key];
        if (!text) continue;
        ctx.textAlign = align;
        taSheetFitFont(ctx, text, startSize, maxWidth);
        ctx.fillText(text, x, y);
    }

    return canvas.toDataURL("image/jpeg", 0.95);
}

function printImagesSequence(dataUrls) {
    return printHtmlInFrame(dataUrls.map(u => `<img src="${u}">`).join(""));
}

// A real PDF template FILE → one PNG per page (pdf.js), printed through
// the same image path as everything else.
async function renderPdfUrlToPngDataUrls(url, scale) {
    if (!window.pdfjsLib) throw new Error("PDF renderer failed to load — check your connection and retry.");
    scale = scale || 2;
    const pdf = await pdfjsLib.getDocument(url).promise;
    const urls = [];
    for (let i = 1; i <= pdf.numPages; i++) {
        const page = await pdf.getPage(i);
        const viewport = page.getViewport({ scale });
        const canvas = document.createElement("canvas");
        canvas.width = viewport.width;
        canvas.height = viewport.height;
        const ctx = canvas.getContext("2d");
        await page.render({ canvasContext: ctx, viewport }).promise;
        urls.push(canvas.toDataURL("image/png"));
    }
    return urls;
}

async function printPdfUrl(url) {
    return printImagesSequence(await renderPdfUrlToPngDataUrls(url));
}

// One click → print dialog. Takes the match OBJECT (insert's "Create &
// Print Friendly Sheet" prints before the listener delivers the new doc).
async function quickPrintSheetForMatch(m, kind, btnEl) {
    if (!m) return;
    const config = SHEET_CONFIGS[kind];
    const originalText = btnEl ? btnEl.textContent : null;
    if (btnEl) { btnEl.disabled = true; btnEl.textContent = "…"; }

    try {
        if (config.fillFields) await printImageDataUrl(await buildSheetDataUrl(m, kind));
        else await printPdfUrl(config.templateUrl);
        if (btnEl) {
            btnEl.classList.add("done-flash");
            btnEl.textContent = "✓";
            setTimeout(() => {
                btnEl.classList.remove("done-flash");
                btnEl.textContent = originalText;
                btnEl.disabled = false;
            }, 900);
        }
    } catch (e) {
        console.error(e);
        alert(`Couldn't print the ${config.title}: ` + e.message);
        if (btnEl) {
            btnEl.textContent = originalText;
            btnEl.disabled = false;
        }
    }
}

async function quickPrintSheet(matchId, kind, btnEl) {
    const m = matchesById.get(matchId);
    if (!m) return;
    return quickPrintSheetForMatch(m, kind, btnEl);
}

function sheetButtonsHtml(matchId) {
    return `
        <button class="btn btn-ghost" onclick="quickPrintSheet('${escapeAttr(matchId)}', 'ta', this)">🖨 TA Sheet</button>
        <button class="btn btn-ghost" onclick="quickPrintSheet('${escapeAttr(matchId)}', 'ko', this)">🥊 KO</button>
        <button class="btn btn-ghost" onclick="quickPrintSheet('${escapeAttr(matchId)}', 'protest', this)">⚠ Protest</button>`;
}

// ═══════════════════════════════════════════════════════════════════
// MATCH RESULT (decided fights) — only winner, win score and WT decision
// code can be corrected; the round-by-round PSS breakdown is shown. A
// changed winner is written forward into the next round (see
// propagateWinnerChangeIfNeeded in the common file).
// ═══════════════════════════════════════════════════════════════════

// WT decision codes, stored lowercase like TkStrike's sync ("ptf").
const WIN_TYPE_OPTIONS = [
    ["rsc", "RSC — Referee Stops Contest"],
    ["ptf", "PTF — Final score"],
    ["ptg", "PTG — Point gap"],
    ["gdp", "GDP — Golden Point"],
    ["sup", "SUP — Superiority"],
    ["wdr", "WDR — Withdrawal"],
    ["dsq", "DSQ — Disqualification"],
    ["dqb", "DQB — Win by disqualification for unsportsmanlike behavior"],
    ["pun", "PUN — Referee's punitive declaration"],
];

// Round-score results a best-of-3 can end on; an unusual saved value is
// kept selectable as "(current)".
const WIN_SCORE_OPTIONS = ["0-0", "1-0", "0-1", "1-1", "2-0", "0-2", "2-1", "1-2"];

const ROUND_POINT_COMPONENTS = [
    ["trunk", "trunk"], ["head", "head"], ["punch", "punch"],
    ["rotation_trunk", "rot.trunk"], ["rotation_head", "rot.head"],
    ["penalties", "pen"], ["hits", "hits"],
];

function roundBreakdownLine(round) {
    if (!round) return "";
    const parts = ROUND_POINT_COMPONENTS
        .map(([key, label]) => [label, Number(round[key]) || 0])
        .filter(([, val]) => val > 0)
        .map(([label, val]) => `${label} ${val}`);
    return parts.length ? parts.join(", ") : "no scoring events";
}

function buildRoundBreakdownHtml(m) {
    const blueRounds = (m.blue && m.blue.points) || [];
    const redRounds = (m.red && m.red.points) || [];
    const roundCount = Math.max(blueRounds.length, redRounds.length);
    if (roundCount === 0) return "";

    const rowsHtml = Array.from({ length: roundCount }, (_, i) => {
        const b = blueRounds[i], r = redRounds[i];
        return `
            <div style="display:grid; grid-template-columns: 42px 1fr 1fr; gap:.5rem; padding:.45rem 0; border-bottom:1px solid var(--lq-border); font-size:.78rem;">
                <div style="font-weight:700; color:var(--lq-muted);">R${i + 1}</div>
                <div>
                    <div style="font-weight:700; color:var(--lq-blue);">${b ? escapeHtml(String(b.points ?? "0")) : "—"} pts</div>
                    <div style="color:var(--lq-muted);">${escapeHtml(roundBreakdownLine(b))}</div>
                </div>
                <div>
                    <div style="font-weight:700; color:var(--lq-red);">${r ? escapeHtml(String(r.points ?? "0")) : "—"} pts</div>
                    <div style="color:var(--lq-muted);">${escapeHtml(roundBreakdownLine(r))}</div>
                </div>
            </div>
        `;
    }).join("");

    return `
        <div class="lq-detail-readonly" style="margin-top:1rem;">
            <div style="font-size:.72rem; font-weight:700; text-transform:uppercase; letter-spacing:.04em; color:var(--lq-muted); margin-bottom:.4rem;">Round-by-Round</div>
            <div style="display:grid; grid-template-columns: 42px 1fr 1fr; font-size:.66rem; font-weight:700; text-transform:uppercase; color:var(--lq-muted); padding-bottom:.3rem;">
                <div></div><div>Blue</div><div>Red</div>
            </div>
            ${rowsHtml}
        </div>
    `;
}

function openMatchResultModal(matchId) {
    const m = matchesById.get(matchId);
    if (!m) return;

    const blueName = participantLabel(m.blue);
    const redName = participantLabel(m.red);
    const canPickWinner = !!(m.blue && m.blue.entryId) && !!(m.red && m.red.entryId);

    openModal(`
        <div class="lq-modal-header">
            <h3>#${escapeHtml(String(m.displayNumber ?? "—"))} · ${escapeHtml(resolveCategoryLabel(m.categoryCode))} · Result</h3>
            <button class="lq-modal-close" onclick="closeModal()">&times;</button>
        </div>
        <div class="lq-modal-body">
            <p class="lq-field-hint" style="margin-bottom:1rem;">
                This fight is already decided — only the recorded winner, score, and win type can be
                corrected here. Court, timing, category, and corners are locked; use Bulk Edit or fix it
                before the fight if those are wrong. Changing the winner also updates any later match that
                already has this fighter slotted in from this result.
            </p>

            <div class="lq-detail-corners">
                <div class="lq-detail-corner blue">
                    <label>Blue Corner</label>
                    <div class="lq-corner-current">${escapeHtml(blueName)}</div>
                </div>
                <div class="lq-detail-corner red">
                    <label>Red Corner</label>
                    <div class="lq-corner-current">${escapeHtml(redName)}</div>
                </div>
            </div>

            <div class="lq-detail-grid">
                <label class="lq-span-2">Winner
                    <select id="result-winner" ${canPickWinner ? "" : "disabled"}>
                        <option value="blue" ${m.win === "blue" ? "selected" : ""}>${escapeHtml(blueName)} (Blue)</option>
                        <option value="red" ${m.win === "red" ? "selected" : ""}>${escapeHtml(redName)} (Red)</option>
                    </select>
                </label>
                <label>Win Type
                    <select id="result-win-type">
                        <option value="" ${m.win_type ? "" : "selected"}>— none —</option>
                        ${WIN_TYPE_OPTIONS.map(([code, label]) => `<option value="${code}" ${(m.win_type || "").toLowerCase() === code ? "selected" : ""}>${escapeHtml(label)}</option>`).join("")}
                        ${m.win_type && !WIN_TYPE_OPTIONS.some(([code]) => code === (m.win_type || "").toLowerCase())
            ? `<option value="${escapeAttr(m.win_type)}" selected>${escapeHtml(m.win_type)} (current)</option>` : ""}
                    </select>
                </label>
                <label>Score
                    <select id="result-win-score">
                        <option value="" ${m.win_score ? "" : "selected"}>— none —</option>
                        ${WIN_SCORE_OPTIONS.map(score => `<option value="${score}" ${m.win_score === score ? "selected" : ""}>${score}</option>`).join("")}
                        ${m.win_score && !WIN_SCORE_OPTIONS.includes(m.win_score)
            ? `<option value="${escapeAttr(m.win_score)}" selected>${escapeHtml(m.win_score)} (current)</option>` : ""}
                    </select>
                </label>
            </div>

            ${canPickWinner ? "" : `<p class="lq-field-hint" style="margin-top:.5rem;">One corner still isn't a resolved athlete yet, so the winner can't be reassigned here.</p>`}

            ${buildRoundBreakdownHtml(m)}

            <div id="result-error" class="lq-alert-error hidden"></div>

            <div class="lq-modal-actions">
                <button class="btn btn-primary" id="result-save-btn" ${canPickWinner ? "" : "disabled"}>Save Result</button>
                ${sheetButtonsHtml(matchId)}
                <button class="btn btn-ghost" onclick="closeModal()">Close</button>
            </div>
        </div>
    `);

    if (canPickWinner) document.getElementById("result-save-btn").onclick = () => saveMatchResult(matchId);
}

async function saveMatchResult(matchId) {
    const m = matchesById.get(matchId);
    if (!m) return;

    const errEl = document.getElementById("result-error");
    errEl.classList.add("hidden");

    const winnerSide = document.getElementById("result-winner").value;
    const winType = document.getElementById("result-win-type").value.trim();
    const winScore = document.getElementById("result-win-score").value.trim();
    const winnerCorner = winnerSide === "blue" ? m.blue : m.red;

    if (!winnerCorner || !winnerCorner.entryId) {
        errEl.textContent = "That corner has no resolved athlete yet — can't set them as the winner.";
        errEl.classList.remove("hidden");
        return;
    }

    const saveBtn = document.getElementById("result-save-btn");
    saveBtn.disabled = true;
    saveBtn.textContent = "Saving…";

    try {
        const batch = fsDb.batch();
        propagateWinnerChangeIfNeeded(m, winnerCorner.entryId, batch);
        batch.set(matchDocRef(matchId), {
            win: winnerSide,
            win_score: winScore || null,
            win_type: winType || null,
            winnerEntryId: winnerCorner.entryId,
        }, { merge: true });
        await batch.commit();
        closeModal();
    } catch (err) {
        console.error("Save result failed", err);
        errEl.textContent = "Save failed: " + err.message;
        errEl.classList.remove("hidden");
        saveBtn.disabled = false;
        saveBtn.textContent = "Save Result";
    }
}

// ═══════════════════════════════════════════════════════════════════
// FORMAT + DISCIPLINE (see the contract in live-queue-common.js)
// ═══════════════════════════════════════════════════════════════════

const KyorugiFormat = {
    key: "kyorugi",
    solo: false,
    roundPhases: ["R32", "R16", "QF", "SF", "F"],
    rowExtraHtml: (m, conflictReason) => equipmentBadgesHtml(m, conflictReason),
    rowButtons: () => [{ kind: "ta", title: "Instant print TA sheet", label: "🖨" }],
    onRowButton: (kind, m, btn) => quickPrintSheet(m.id, kind, btn),
    detailFieldsHtml: (m) => `
        <label>Round Time <input type="text" id="edit-roundTime" value="${escapeAttr(m.roundTime || "")}"></label>
        <label>Break Time <input type="text" id="edit-breakTime" value="${escapeAttr(m.breakTime || "")}"></label>
        <label>PSS Size <input type="number" id="edit-pssSize" value="${m.pssSize ?? ""}"></label>
        <label>Hit Level <input type="number" id="edit-hitLevel" value="${m.hitLevel ?? ""}"></label>`,
    detailUpdates: () => {
        const num = (id) => {
            const raw = document.getElementById(id).value;
            const n = Number(raw);
            return raw === "" || Number.isNaN(n) ? undefined : n;
        };
        const updates = {
            roundTime: document.getElementById("edit-roundTime").value.trim(),
            breakTime: document.getElementById("edit-breakTime").value.trim(),
        };
        const ps = num("edit-pssSize"); if (ps !== undefined) updates.pssSize = ps;
        const hl = num("edit-hitLevel"); if (hl !== undefined) updates.hitLevel = hl;
        return updates;
    },
    detailReadonlyHtml: (m) => equipmentBadgesHtml(m, equipmentConflictFor(m.id)),
    detailActionsHtml: (m) => sheetButtonsHtml(m.id),
    openResult: openMatchResultModal,
};

const KyorugiDiscipline = {
    init: loadEquipmentMeta,
    conflicts: computeEquipmentConflicts,
    formatOf: () => KyorugiFormat,
    bulkFields: [
        { key: "roundTime", label: "Round Time", type: "text", placeholder: "unchanged, e.g. 02:00" },
        { key: "breakTime", label: "Break Time", type: "text", placeholder: "unchanged, e.g. 01:00" },
        { key: "pssSize", label: "PSS Size", type: "number" },
        { key: "hitLevel", label: "Hit Level", type: "number" },
    ],
    insert: {
        requiresRed: true,
        roundPhases: KyorugiFormat.roundPhases,
        fieldsHtml: () => `
            <label>Round Time <input type="text" id="insert-roundTime" value="01:00" placeholder="e.g. 01:00"></label>
            <label>Break Time <input type="text" id="insert-breakTime" value="00:30" placeholder="e.g. 00:30"></label>
            <label>PSS Size <input type="number" id="insert-pssSize" placeholder="optional"></label>
            <label>Hit Level <input type="number" id="insert-hitLevel" value="20" placeholder="optional"></label>`,
        read: () => {
            const pss = document.getElementById("insert-pssSize").value.trim();
            const hit = document.getElementById("insert-hitLevel").value.trim();
            return {
                roundTime: document.getElementById("insert-roundTime").value.trim() || null,
                breakTime: document.getElementById("insert-breakTime").value.trim() || null,
                pssSize: pss !== "" ? Number(pss) : null,
                hitLevel: hit !== "" ? Number(hit) : null,
            };
        },
        format: () => null,
        actions: [{ id: "friendly", label: "🤝 Create &amp; Print Friendly Sheet", after: (newMatch) => quickPrintSheetForMatch(newMatch, "friendly", null) }],
    },
    resultKinds: [], // single-elimination bracket sheets are built into the common file
};

startLiveQueue(KyorugiDiscipline);