/* ════════════════════════════════════════════════════════════════════
 * live-queue-bracket-sync.js — keeps the saved bracket docs
 * (tournaments/{id}/brackets) in step with the live match docs when an
 * athlete is replaced. Loaded by live_queue_base.html right AFTER
 * live-queue-common.js.
 *
 * WHY: replacing a corner in the live queue only rewrote that one match
 * doc. The bracket doc's `entries` kept the old athlete, so bracket
 * sheets, club sheets, standings and anything else reading the bracket
 * doc still showed them. Any later-round match that already held the old
 * athlete kept them too.
 *
 * TWO WAYS IN
 *   - saveMatchEdits() (common file) calls syncBracketForReplacement()
 *     and adds its writes to the SAME batch as the match edit. From now on
 *     every replacement also updates the bracket doc and every other match
 *     of that category that still shows the old athlete.
 *   - 🔧 Sync Brackets (toolbar) → openBracketSyncModal(): a one-off repair
 *     for replacements made before this existed. It lists what it would
 *     change and writes only when you press Apply. From the console:
 *        const plans = await planAllBracketSyncs();
 *        plans.forEach(p => console.log(p.categoryLabel, p.changes, p.notes));
 *        await applyBracketSyncs(plans);
 *
 * HOW A REPLACEMENT IS FOUND
 *   single elimination     the tree is rebuilt exactly as it was pushed
 *                          (BracketCore, saved seed order + placement).
 *                          Each slot's athlete is compared with the live
 *                          match doc in that slot (bracketRound /
 *                          bracketMatchNumber).
 *   cut-off / round robin  there are no slots. An entry that is in no
 *                          match any more is paired with an athlete who is
 *                          in the matches but has no entry. Anything that
 *                          can't be paired is listed and left alone.
 *
 * FREEZING THE TREE: club-spread placement depends on each entry's club
 * and country. Re-running it on edited entries could pair round 1
 * differently from what was pushed. The first sync of an elimination
 * bracket therefore saves `slotOrder` (entryId per slot, null = bye).
 * From then on every rebuild uses that order (eliminationTreeFor).
 *
 * DELETING A MATCH (🗑 in every match modal) also lives here — see the
 * DELETE MATCH section at the end.
 *
 * A replacing entry keeps the old entry's seed and records
 * `replacedEntryIds`, so a placement computed for the old entry carries
 * over to the new one on the sheets.
 * ════════════════════════════════════════════════════════════════════ */
"use strict";

function bracketsCollection() {
    return fsDb.collection("tournaments").doc(TOURNAMENT_ID).collection("brackets");
}

async function loadBracketDocRef(categoryCode) {
    const snap = await bracketsCollection().where("categoryCode", "==", categoryCode).limit(1).get();
    return snap.empty ? null : { ref: snap.docs[0].ref, data: snap.docs[0].data() };
}

function categoryMatchList(categoryCode) {
    return [...matchesById.values()].filter(m => m.categoryCode === categoryCode);
}

function sortedBracketEntries(bracketDoc) {
    return (bracketDoc.entries || []).slice().sort((a, b) => (a.seed ?? 0) - (b.seed ?? 0));
}

// ── The elimination tree, exactly as pushed ─────────────────────────
// slotOrder may be bigger than the entries need: once a match has been
// deleted its slots are byes, but the tree keeps its pushed size so every
// live match still sits where it was.
function hasValidSlotOrder(bracketDoc, entries) {
    const order = bracketDoc.slotOrder;
    if (!Array.isArray(order)) return false;
    const n = order.length;
    if (n < 2 || (n & (n - 1)) !== 0 || n < entries.length) return false;
    const ids = order.filter(Boolean);
    const known = new Set(entries.map(e => e.entryId));
    return ids.length === entries.length && new Set(ids).size === ids.length && ids.every(id => known.has(id));
}

// Used by reconstructBracketFromFirestore() in the common file as well.
function eliminationTreeFor(bracketDoc) {
    const entries = sortedBracketEntries(bracketDoc);
    if (hasValidSlotOrder(bracketDoc, entries)) {
        const byId = new Map(entries.map(e => [e.entryId, e]));
        const order = bracketDoc.slotOrder;
        const frozen = (_entries, size) => Array.from({ length: size }, (_, i) => byId.get(order[i]) || null);
        return BracketCore.generateSingleElimination(bracketDoc.categoryCode, entries, frozen, order.length);
    }
    const placementFn = BracketCore.PLACEMENT_STRATEGIES[bracketDoc.placementStrategy] || BracketCore.PLACEMENT_STRATEGIES.standard;
    return BracketCore.generateSingleElimination(bracketDoc.categoryCode, entries, placementFn);
}

function slotOrderOf(built) {
    const order = new Array(built.bracketSize).fill(null);
    Object.entries(built.entrySlotIndex || {}).forEach(([id, idx]) => { order[idx] = id; });
    return order;
}

// ── Athlete fields shared by corners and entries ────────────────────
function athleteFieldsOf(c) {
    const out = {
        entryId: c.entryId,
        athleteIds: Array.isArray(c.athleteIds) && c.athleteIds.length ? c.athleteIds : [c.entryId],
        name: c.name || "",
        clubId: c.clubId ?? null,
        clubName: c.clubName ?? null,
        country: c.country ?? null,
    };
    const assoc = c.associationIds || (c.associationId ? [c.associationId] : null);
    if (assoc) out.associationIds = assoc;
    return out;
}

function entryReplacing(oldEntry, corner) {
    const fields = athleteFieldsOf(corner);
    return {
        ...fields,
        seed: oldEntry.seed ?? null,
        associationIds: fields.associationIds || [],
        replacedEntryIds: [...(oldEntry.replacedEntryIds || []), oldEntry.entryId],
    };
}

// ── The plan for one category ───────────────────────────────────────
// matches: this category's match docs, as they are (repair) or as they
//          are about to be saved (corner replacement)
// known:   { oldEntryId: newCorner } — replacements picked right now
// -> { categoryCode, categoryLabel, changes: [{oldId, oldName, newName}],
//      matchFixes: [{id, label, updates}], bracketUpdate | null, notes }
function planBracketSync(bracketDoc, matches, known) {
    const entries = bracketDoc.entries || [];
    const entryById = new Map(entries.map(e => [e.entryId, e]));
    const nameOf = id => (entryById.get(id) || {}).name || id;
    const replacements = {}; // old entryId -> new corner
    const notes = [];

    Object.entries(known || {}).forEach(([oldId, c]) => {
        if (entryById.has(oldId) && c && c.entryId && c.entryId !== oldId) replacements[oldId] = c;
    });

    const elimination = !bracketDoc.system || bracketDoc.system === "single_elimination";
    let slotOrder = null;

    if (elimination) {
        if (entries.length >= 2) {
            const built = eliminationTreeFor(bracketDoc);
            const live = {};
            matches.forEach(m => {
                if (m.bracketRound != null && m.bracketMatchNumber != null) live[`${m.bracketRound}_${m.bracketMatchNumber}`] = m;
            });
            built.rounds.forEach(round => round.forEach(bm => {
                if (bm.status === "walkover") return;
                const lm = live[`${bm.round}_${bm.matchNumber}`];
                if (!lm) return;
                ["blue", "red"].forEach(side => {
                    const was = bm[side], now = lm[side];
                    if (!was || !was.entryId || !now || !now.entryId || was.entryId === now.entryId) return;
                    if (!replacements[was.entryId]) replacements[was.entryId] = now;
                });
            }));
            slotOrder = hasValidSlotOrder(bracketDoc, sortedBracketEntries(bracketDoc)) ? bracketDoc.slotOrder : slotOrderOf(built);
        }
    } else {
        // Cut-off / round robin: compare who is in the matches with who is in the bracket.
        const inMatches = new Map();
        matches.forEach(m => ["blue", "red"].forEach(side => {
            const c = m[side];
            if (c && c.entryId) inMatches.set(c.entryId, c);
        }));
        const takenNew = new Set(Object.values(replacements).map(c => c.entryId));
        const missing = entries.filter(e => !replacements[e.entryId] && !inMatches.has(e.entryId));
        const added = [...inMatches.values()].filter(c => !entryById.has(c.entryId) && !takenNew.has(c.entryId));
        const n = Math.min(missing.length, added.length);
        for (let i = 0; i < n; i++) replacements[missing[i].entryId] = added[i];
        if (missing.length > n) {
            notes.push(`In the bracket but in no match (left as they are): ${missing.slice(n).map(e => e.name || e.entryId).join(", ")}`);
        }
        if (added.length > n) {
            notes.push(`In a match but not in the bracket, nobody to replace (left as they are): ${added.slice(n).map(c => c.name || c.entryId).join(", ")}`);
        }
    }

    // Don't create a second entry for an athlete who already has one, or
    // let two old entries turn into the same athlete.
    //
    // MOVED: the new athlete is already an entry whose own slot is also
    // changing (two athletes swapped places, e.g. István ↔ Jozef). The
    // live matches are right; only the bracket's slot order changes —
    // entries and match docs are left alone. (Treating a swap as two
    // replacements rewrote the matches too, and every Apply flipped them.)
    const oldIds = new Set(Object.keys(replacements));
    const usedNew = new Set();
    const moved = {}; // old slot owner -> athlete now in that slot (both already entries)
    Object.entries(replacements).forEach(([oldId, c]) => {
        if ((entryById.has(c.entryId) && !oldIds.has(c.entryId)) || usedNew.has(c.entryId)) {
            notes.push(`${nameOf(oldId)} → ${c.name || c.entryId}: ${c.name || c.entryId} is already in this bracket — not changed, check this category by hand.`);
            delete replacements[oldId];
            return;
        }
        usedNew.add(c.entryId);
        if (entryById.has(c.entryId)) { moved[oldId] = c; delete replacements[oldId]; }
    });
    const slotChange = { ...replacements, ...moved };

    const changes = [
        ...Object.entries(replacements).map(([oldId, c]) => ({ oldId, oldName: nameOf(oldId), newName: c.name || c.entryId, kind: "replaced" })),
        ...Object.entries(moved).map(([oldId, c]) => ({ oldId, oldName: nameOf(oldId), newName: c.name || c.entryId, kind: "moved" })),
    ];

    // Every match of the category that still shows a replaced athlete
    // (never for moved ones — they're still in the bracket).
    const matchFixes = [];
    matches.forEach(m => {
        const updates = {};
        ["blue", "red"].forEach(side => {
            const c = m[side];
            const r = c && c.entryId && replacements[c.entryId];
            if (r) updates[side] = athleteFieldsOf(r);
        });
        if (m.winnerEntryId && replacements[m.winnerEntryId]) updates.winnerEntryId = replacements[m.winnerEntryId].entryId;
        if (Object.keys(updates).length) {
            matchFixes.push({ id: m.id, label: `#${m.displayNumber ?? "?"} ${m.roundPhase || ""}`.trim(), updates });
        }
    });

    let bracketUpdate = null;
    if (changes.length) {
        bracketUpdate = {
            entries: entries.map(e => (replacements[e.entryId] ? entryReplacing(e, replacements[e.entryId]) : e)),
            entriesSyncedAt: firebase.firestore.FieldValue.serverTimestamp(),
        };
        if (slotOrder) bracketUpdate.slotOrder = slotOrder.map(id => (id && slotChange[id] ? slotChange[id].entryId : id));
    }

    return {
        categoryCode: bracketDoc.categoryCode,
        categoryLabel: bracketDoc.categoryLabel || bracketDoc.categoryCode,
        changes, matchFixes, bracketUpdate, notes,
    };
}

// ── Hook: saving a corner replacement (saveMatchEdits) ──────────────
// Adds the bracket doc update and the other matches' fixes to `batch`.
// May set updates.winnerEntryId when the edited match's winner was the
// replaced athlete. -> notes to show the operator ([] when all is fine).
async function syncBracketForReplacement(m, updates, known, batch) {
    if (!m.categoryCode) return [];
    const found = await loadBracketDocRef(m.categoryCode);
    if (!found) return []; // inserted / exhibition match — no bracket to update

    const merged = {
        ...m, ...updates,
        blue: updates.blue ? { ...(m.blue || {}), ...updates.blue } : m.blue,
        red: updates.red ? { ...(m.red || {}), ...updates.red } : m.red,
    };
    const matches = categoryMatchList(m.categoryCode).map(x => (x.id === m.id ? merged : x));
    const plan = planBracketSync(found.data, matches, known);

    plan.matchFixes.forEach(f => {
        if (f.id === m.id) {
            if ("winnerEntryId" in f.updates) updates.winnerEntryId = f.updates.winnerEntryId;
            return;
        }
        batch.set(matchDocRef(f.id), f.updates, { merge: true });
    });
    if (plan.bracketUpdate) batch.set(found.ref, plan.bracketUpdate, { merge: true });
    return plan.notes;
}

// ── Repair: every category at once ──────────────────────────────────
async function planAllBracketSyncs() {
    const snap = await bracketsCollection().get();
    const plans = [];
    snap.forEach(doc => {
        const data = doc.data();
        if (!data.categoryCode) return;
        const plan = planBracketSync(data, categoryMatchList(data.categoryCode), {});
        plan.ref = doc.ref;
        if (plan.changes.length || plan.matchFixes.length || plan.notes.length) plans.push(plan);
    });
    return plans.sort((a, b) => String(a.categoryLabel).localeCompare(String(b.categoryLabel)));
}

async function applyBracketSyncs(plans) {
    const writes = [];
    plans.forEach(p => {
        if (p.bracketUpdate) writes.push([p.ref, p.bracketUpdate]);
        p.matchFixes.forEach(f => writes.push([matchDocRef(f.id), f.updates]));
    });
    const CHUNK = 400; // Firestore batches cap at 500 writes
    for (let i = 0; i < writes.length; i += CHUNK) {
        const batch = fsDb.batch();
        writes.slice(i, i + CHUNK).forEach(([ref, data]) => batch.set(ref, data, { merge: true }));
        await batch.commit();
    }
    return writes.length;
}

let bracketSyncPlans = [];

async function openBracketSyncModal() {
    openModal(`
        <div class="lq-modal-header">
            <h3>Sync Brackets with Matches</h3>
            <button class="lq-modal-close" onclick="closeModal()">&times;</button>
        </div>
        <div class="lq-modal-body">
            <p class="lq-field-hint" style="margin-bottom:1rem;">
                Finds athletes replaced in the live queue who are still in the saved bracket, and matches of
                the same category that still show the old athlete. Nothing is written until you press Apply.
            </p>
            <div id="bracket-sync-list"><p class="lq-field-hint">Comparing brackets with matches…</p></div>
            <div id="bracket-sync-error" class="lq-alert-error hidden"></div>
            <div class="lq-modal-actions">
                <button class="btn btn-primary" id="bracket-sync-apply-btn" disabled onclick="applyBracketSyncFromModal()">Apply</button>
                <button class="btn btn-ghost" onclick="closeModal()">Close</button>
            </div>
        </div>
    `);

    const listEl = () => document.getElementById("bracket-sync-list");
    try {
        bracketSyncPlans = await planAllBracketSyncs();
    } catch (err) {
        console.error("Bracket sync check failed", err);
        if (listEl()) listEl().innerHTML = `<div class="lq-alert-error">Couldn't compare: ${escapeHtml(err.message)}</div>`;
        return;
    }
    if (!listEl()) return; // closed while loading

    if (bracketSyncPlans.length === 0) {
        listEl().innerHTML = `<p class="lq-field-hint">Every bracket matches its live matches — nothing to fix.</p>`;
        return;
    }

    const fixable = bracketSyncPlans.filter(p => p.changes.length || p.matchFixes.length);
    listEl().innerHTML = bracketSyncPlans.map(p => `
        <div style="padding:.5rem 0; border-bottom:1px solid var(--lq-border); font-size:.85rem;">
            <strong>${escapeHtml(p.categoryLabel)}</strong>
            ${p.changes.map(c => c.kind === "moved"
        ? `<div><strong>${escapeHtml(c.newName)}</strong> <span style="color:var(--lq-muted);">now in ${escapeHtml(c.oldName)}'s bracket slot (moved — matches stay as they are)</span></div>`
        : `<div>${escapeHtml(c.oldName)} → <strong>${escapeHtml(c.newName)}</strong></div>`).join("")}
            ${p.matchFixes.length ? `<div style="color:var(--lq-muted); font-size:.78rem;">${p.matchFixes.length} match(es) still show the old athlete: ${escapeHtml(p.matchFixes.map(f => f.label).join(", "))}</div>` : ""}
            ${p.notes.map(n => `<div style="color:var(--lq-amber); font-size:.78rem;">⚠ ${escapeHtml(n)}</div>`).join("")}
        </div>
    `).join("");
    document.getElementById("bracket-sync-apply-btn").disabled = fixable.length === 0;
}

async function applyBracketSyncFromModal() {
    const btn = document.getElementById("bracket-sync-apply-btn");
    const errEl = document.getElementById("bracket-sync-error");
    errEl.classList.add("hidden");
    btn.disabled = true;
    btn.textContent = "Applying…";
    try {
        const count = await applyBracketSyncs(bracketSyncPlans);
        closeModal();
        alert(`Done — ${count} document(s) updated.`);
    } catch (err) {
        console.error("Bracket sync failed", err);
        errEl.textContent = `Failed: ${err.message}`;
        errEl.classList.remove("hidden");
        btn.disabled = false;
        btn.textContent = "Apply";
    }
}

// ═══════════════════════════════════════════════════════════════════
// DELETE MATCH — 🗑 in every match modal. Deletes the match doc and
// takes its athletes out of the bracket doc, all in one batch.
//
//   not in a pushed bracket   (inserted / exhibition) only the doc goes
//   cut-off / round robin     the doc goes; an athlete leaves the
//                             bracket's entries unless they're still in
//                             another match of the category
//   single elimination        only a match nobody was fed into (round 1,
//                             or a bout of two bye-holders) — a later
//                             round's match would strand its winners, so
//                             use a walkover / winner there instead.
//                             Both athletes leave the bracket and their
//                             slots become byes (slotOrder). The next
//                             match's side becomes a BYE:
//                               other side known   → walkover, they go on
//                               other side to come → whoever wins it goes
//                                                    on (applyCornerUpdate-
//                                                    Downstream in the
//                                                    common file)
//                               other side empty   → that match goes too,
//                                                    and so on up the tree
//   Refused when the next match is already decided — correct it first.
//   Registrations (division_rosters) are never touched.
// ═══════════════════════════════════════════════════════════════════

const BYE_CORNER = { entryId: null, source: null, bye: true };

// Nobody is in this corner and nobody ever will be.
function isEmptyCorner(c) {
    return !c || (!c.entryId && !(c.source && c.source.matchId) && !c.pendingAdvancement);
}

function downstreamOf(matchId) {
    for (const x of matchesById.values()) {
        for (const side of ["blue", "red"]) {
            const c = x[side];
            if (c && c.source && c.source.matchId === matchId) return { match: x, side };
        }
    }
    return null;
}

function matchNumberText(m) {
    return `#${m.displayNumber ?? "?"}`;
}

// Adds to plan what happens to the match the removed one fed into.
function planDownstreamAfterRemoval(removed, plan, visited) {
    const down = downstreamOf(removed.id);
    if (!down) return; // it was the final
    const d = down.match, side = down.side;
    const other = d[side === "blue" ? "red" : "blue"];
    if (d.winnerEntryId || (isDone(d) && d.status !== "walkover")) {
        throw new Error(`The next match ${matchNumberText(d)} is already decided — correct its result first, then delete.`);
    }
    visited.add(d.id);

    if (isEmptyCorner(other)) {
        plan.ops.push(b => b.delete(matchDocRef(d.id)));
        plan.summary.push(`Match ${matchNumberText(d)} has nobody left in it — deleted too.`);
        planDownstreamAfterRemoval(d, plan, visited);
        return;
    }
    if (other.entryId) {
        plan.ops.push(b => {
            // update() replaces the whole corner map (a merge would keep the old name).
            b.update(matchDocRef(d.id), {
                [side]: BYE_CORNER, status: "walkover", winnerEntryId: other.entryId,
                win: null, win_score: null, win_type: null,
            });
            applyCornerUpdateDownstream(d.id, { ...other, source: { matchId: d.id, slot: "winner" } }, b, visited);
        });
        plan.summary.push(`${other.name || other.entryId} goes through ${matchNumberText(d)} on a walkover.`);
        return;
    }
    plan.ops.push(b => b.update(matchDocRef(d.id), { [side]: BYE_CORNER }));
    plan.summary.push(`${matchNumberText(d)}: that side becomes a BYE — whoever wins the other side goes through.`);
}

// -> { summary: [text], ops: [(batch) => void], bracketRef, bracketUpdate }
// Throws (with the reason) when the match can't be deleted.
async function planMatchDeletion(matchId) {
    const m = matchesById.get(matchId);
    if (!m) throw new Error("This match is gone already.");
    const found = m.categoryCode ? await loadBracketDocRef(m.categoryCode) : null;
    const plan = { summary: [`Match ${matchNumberText(m)} (${cornersText(m)}) is deleted.`], ops: [b => b.delete(matchDocRef(matchId))], bracketRef: found && found.ref, bracketUpdate: null };

    if (!found) {
        plan.summary.push("It isn't part of a pushed bracket — nothing else changes.");
        return plan;
    }
    const doc = found.data;
    const elimination = !doc.system || doc.system === "single_elimination";
    const treeMatch = elimination && m.bracketRound != null && m.bracketMatchNumber != null;
    if (elimination && !treeMatch) {
        plan.summary.push("It isn't part of the bracket tree (inserted match) — the bracket doesn't change.");
        return plan;
    }

    const athletes = ["blue", "red"].map(s => m[s]).filter(c => c && c.entryId);
    let removeIds;
    if (treeMatch) {
        const fed = ["blue", "red"].filter(s => m[s] && m[s].source && m[s].source.matchId);
        if (fed.length) {
            throw new Error("This match is fed by an earlier round — deleting it would leave that winner with nowhere to go. Give the match a walkover or a winner instead.");
        }
        removeIds = athletes.map(c => c.entryId);
        planDownstreamAfterRemoval(m, plan, new Set([m.id]));
        // By position too: whoever the saved bracket has in this match's
        // slots goes, even when their id no longer matches the live corner
        // (an athlete replaced before brackets were synced).
        const order = hasValidSlotOrder(doc, sortedBracketEntries(doc)) ? doc.slotOrder : slotOrderOf(eliminationTreeFor(doc));
        const span = Math.pow(2, Number(m.bracketRound));
        const from = (Number(m.bracketMatchNumber) - 1) * span;
        for (let i = from; i < from + span && i < order.length; i++) if (order[i]) removeIds.push(order[i]);
        plan.slotRange = [from, from + span];
    } else {
        const stillIn = new Set();
        categoryMatchList(m.categoryCode).filter(x => x.id !== m.id).forEach(x => ["blue", "red"].forEach(s => {
            if (x[s] && x[s].entryId) stillIn.add(x[s].entryId);
        }));
        removeIds = athletes.map(c => c.entryId).filter(id => !stillIn.has(id));
        athletes.filter(c => stillIn.has(c.entryId)).forEach(c => {
            plan.summary.push(`${c.name || c.entryId} stays in the bracket — they're in another match of this category.`);
        });
    }

    const entries = doc.entries || [];
    const gone = new Set(removeIds.filter(id => entries.some(e => e.entryId === id)));
    if (gone.size) {
        plan.bracketUpdate = {
            entries: entries.filter(e => !gone.has(e.entryId)),
            entriesSyncedAt: firebase.firestore.FieldValue.serverTimestamp(),
        };
        if (treeMatch) {
            const order = hasValidSlotOrder(doc, sortedBracketEntries(doc)) ? doc.slotOrder : slotOrderOf(eliminationTreeFor(doc));
            const [from, to] = plan.slotRange;
            plan.bracketUpdate.slotOrder = order.map((id, i) => (i >= from && i < to) || (id && gone.has(id)) ? null : id);
        }
        delete plan.slotRange;
        const names = entries.filter(e => gone.has(e.entryId)).map(e => e.name || e.entryId);
        plan.summary.push(`Removed from the ${doc.categoryLabel || doc.categoryCode} bracket: ${names.join(", ")}.`);
    }
    return plan;
}

async function applyMatchDeletion(plan) {
    const batch = fsDb.batch();
    plan.ops.forEach(op => op(batch));
    if (plan.bracketUpdate) batch.set(plan.bracketRef, plan.bracketUpdate, { merge: true });
    await batch.commit();
}

function deleteMatchButtonHtml(matchId) {
    return `<button type="button" class="btn btn-ghost" style="color:var(--lq-red); border-color:#fca5a5;" onclick="openDeleteMatchModal('${escapeAttr(matchId)}')">🗑 Delete Match</button>`;
}

// Result views come from the discipline files — the buttons are added to
// whatever modal is open rather than to each of them.
function appendDeleteMatchButton(matchId) {
    const actions = document.querySelector("#modal-panel .lq-modal-actions");
    if (!actions || actions.querySelector("[data-delete-match]")) return;
    // Fill / reopen go first — on a walkover they're what you came for.
    actions.insertAdjacentHTML("afterbegin", fillByeButtonsHtml(matchId) + reopenMatchButtonHtml(matchId));
    actions.insertAdjacentHTML("beforeend", deleteMatchButtonHtml(matchId).replace("<button", "<button data-delete-match"));
}

// ── Reopen a walkover ────────────────────────────────────────────────
// Clears the walkover (winner, status) and takes the athlete it sent on
// back out of the next match. Refused when the next match is decided.
function reopenMatchButtonHtml(matchId) {
    const m = matchesById.get(matchId);
    if (!m || m.status !== "walkover") return "";
    return `<button type="button" class="btn btn-ghost" onclick="reopenMatch('${escapeAttr(matchId)}', this)">↩ Reopen match</button>`;
}

async function reopenMatch(matchId, btn) {
    const m = matchesById.get(matchId);
    if (!m) return;
    const down = downstreamOf(m.id);
    if (m.winnerEntryId && down && (down.match.winnerEntryId || (isDone(down.match) && down.match.status !== "walkover"))) {
        alert(`The next match ${matchNumberText(down.match)} is already decided — correct it first.`);
        return;
    }
    const known = s => !!(m[s] && m[s].entryId);
    const byeSide = ["blue", "red"].find(s => m[s] && m[s].bye);
    const note = byeSide ? `\n\nThe ${byeSide} side is still a BYE — use "＋ Add fighter" to put someone there, or the match stays pending.` : "";
    if (!confirm(`Reopen ${matchNumberText(m)}? The walkover and its winner are cleared${down && m.winnerEntryId ? ` and ${matchNumberText(down.match)} goes back to waiting for this result` : ""}.${note}`)) return;

    if (btn) { btn.disabled = true; btn.textContent = "Saving…"; }
    try {
        const batch = fsDb.batch();
        propagateWinnerChangeIfNeeded(m, null, batch);
        batch.update(matchDocRef(m.id), {
            status: known("blue") && known("red") ? "ready" : "pending",
            winnerEntryId: null, win: null, win_score: null, win_type: null,
        });
        await batch.commit();
        closeModal();
    } catch (err) {
        console.error("Reopen failed", err);
        alert("Reopen failed: " + err.message);
        if (btn) { btn.disabled = false; btn.textContent = "↩ Reopen match"; }
    }
}

let pendingMatchDeletion = null;

async function openDeleteMatchModal(matchId) {
    const m = matchesById.get(matchId);
    pendingMatchDeletion = null;
    openModal(`
        <div class="lq-modal-header">
            <h3>Delete ${m ? escapeHtml(matchNumberText(m)) : "match"}${m ? " · " + escapeHtml(resolveCategoryLabel(m.categoryCode)) : ""}</h3>
            <button class="lq-modal-close" onclick="closeModal()">&times;</button>
        </div>
        <div class="lq-modal-body">
            <div id="delete-match-body"><p class="lq-field-hint">Checking what this affects…</p></div>
            <div id="delete-match-error" class="lq-alert-error hidden"></div>
            <div class="lq-modal-actions">
                <button class="btn btn-primary" id="delete-match-btn" style="background:var(--lq-red);" disabled onclick="confirmDeleteMatch()">Delete permanently</button>
                <button class="btn btn-ghost" onclick="closeModal()">Cancel</button>
            </div>
        </div>
    `);

    const body = () => document.getElementById("delete-match-body");
    let plan;
    try {
        plan = await planMatchDeletion(matchId);
    } catch (err) {
        if (body()) body().innerHTML = `<div class="lq-alert-error">Can't delete this match: ${escapeHtml(err.message)}</div>`;
        return;
    }
    if (!body()) return; // closed while checking
    pendingMatchDeletion = plan;
    body().innerHTML = `
        <ul style="margin:0 0 .75rem 1.1rem; padding:0; font-size:.88rem; line-height:1.6;">
            ${plan.summary.map(s => `<li>${escapeHtml(s)}</li>`).join("")}
        </ul>
        <p class="lq-field-hint">This can't be undone. Registrations aren't touched — only the match and the bracket.</p>`;
    document.getElementById("delete-match-btn").disabled = false;
}

async function confirmDeleteMatch() {
    if (!pendingMatchDeletion) return;
    const btn = document.getElementById("delete-match-btn");
    const errEl = document.getElementById("delete-match-error");
    errEl.classList.add("hidden");
    btn.disabled = true;
    btn.textContent = "Deleting…";
    try {
        await applyMatchDeletion(pendingMatchDeletion);
        pendingMatchDeletion = null;
        closeModal(); // the listener removes the row
    } catch (err) {
        console.error("Delete match failed", err);
        errEl.textContent = `Delete failed: ${err.message}`;
        errEl.classList.remove("hidden");
        btn.disabled = false;
        btn.textContent = "Delete permanently";
    }
}

// ═══════════════════════════════════════════════════════════════════
// FILL A BYE — ＋ Add fighter, in the modal of a single-elimination
// round-2 match that has a bye in it. Writes the match docs and the
// bracket doc (entries + slotOrder) in one batch.
//
//   bye-holder   a corner with an athlete nobody fought (their round-1
//                opponent was a bye — never pushed as a match). A new
//                round-1 match "holder vs new fighter" is created right
//                before this one on the same court; this corner then
//                waits for its winner ("#x Winner").
//   BYE corner   left by 🗑 Delete Match. The new fighter goes straight
//                into this corner (their round-1 pair is them + a bye).
//
// The new fighter joins the bracket's entries (last seed) in the empty
// slot of that round-1 pair, so every rebuilt sheet and club sheet shows
// them. If this match was a walkover, it's reopened and the athlete it
// had sent on is taken back out of the next match.
//
// Only round 2: deeper byes (a whole deleted sub-tree) can't be
// refilled one fighter at a time without breaking the tree's shape.
// Refused when this match or the next one is already decided.
// ═══════════════════════════════════════════════════════════════════

function isTreeMatch(m) {
    return m && m.bracketRound != null && m.bracketMatchNumber != null;
}

// -> [{ side, kind: "holder" | "bye", corner }]
function byeSlotsOf(m) {
    if (!isTreeMatch(m) || Number(m.bracketRound) !== 2) return [];
    const out = [];
    ["blue", "red"].forEach(side => {
        const c = m[side];
        if (c && c.bye) out.push({ side, kind: "bye", corner: c });
        else if (c && c.entryId && !(c.source && c.source.matchId)) out.push({ side, kind: "holder", corner: c });
    });
    return out;
}

function fillByeButtonsHtml(matchId) {
    const m = matchesById.get(matchId);
    if (!m || m.winnerEntryId && m.status !== "walkover") return "";
    // "Damien vs BYE": fill the BYE. Giving Damien a round-1 opponent too
    // would still leave this match against nobody, so it isn't offered.
    const slots = byeSlotsOf(m);
    const shown = slots.some(s => s.kind === "bye") ? slots.filter(s => s.kind === "bye") : slots;
    return shown.map(s => {
        const label = s.kind === "bye"
            ? `＋ Add fighter (${s.side} BYE)`
            : `＋ Add opponent for ${s.corner.name || "bye-holder"}`;
        return `<button type="button" class="btn btn-ghost" data-fill-bye onclick="openFillByeModal('${escapeAttr(matchId)}', '${s.side}')">${escapeHtml(label)}</button>`;
    }).join("");
}

function copyDefined(src, keys) {
    const out = {};
    keys.forEach(k => { if (src[k] !== undefined) out[k] = src[k]; });
    return out;
}

// Doc id of a tree match next to this one: same prefix as this match's
// own id, if it uses one, then "{categoryCode}_r{round}_m{n}".
function treeMatchDocId(d, round, number) {
    const own = `${d.categoryCode}_r${d.bracketRound}_m${d.bracketMatchNumber}`;
    const prefix = d.id.endsWith(own) ? d.id.slice(0, d.id.length - own.length) : "";
    return `${prefix}${d.categoryCode}_r${round}_m${number}`;
}

// -> { summary: [text], ops: [(batch) => void], bracketRef, bracketUpdate }
async function planFillBye(matchId, side, athlete) {
    const d = matchesById.get(matchId);
    if (!d) throw new Error("This match is gone.");
    const slot = byeSlotsOf(d).find(s => s.side === side);
    if (!slot) throw new Error("That side has no bye to fill any more.");
    if (d.winnerEntryId && d.status !== "walkover") throw new Error("This match is already decided — correct its result first.");

    const found = await loadBracketDocRef(d.categoryCode);
    if (!found) throw new Error("No pushed bracket for this category.");
    const doc = found.data;
    if (doc.system && doc.system !== "single_elimination") throw new Error("Only single-elimination brackets have byes.");

    const entries = sortedBracketEntries(doc);
    if (entries.some(e => e.entryId === athlete.id || (e.athleteIds || []).includes(athlete.id))) {
        throw new Error(`${athlete.displayName} is already in this bracket.`);
    }
    if (categoryMatchList(d.categoryCode).some(x => ["blue", "red"].some(s => x[s] && x[s].entryId === athlete.id))) {
        throw new Error(`${athlete.displayName} is already in a match of this category.`);
    }

    const built = eliminationTreeFor(doc);
    const order = (hasValidSlotOrder(doc, entries) ? doc.slotOrder : slotOrderOf(built)).slice();
    const pair = 2 * (Number(d.bracketMatchNumber) - 1) + (side === "blue" ? 0 : 1); // round-1 match index
    const s0 = 2 * pair, s1 = 2 * pair + 1;
    if (s1 >= order.length) throw new Error("This match doesn't line up with the saved bracket — run 🔧 Sync Brackets first.");

    const newCorner = cornerFromAthlete(athlete);
    const plan = { summary: [], ops: [], bracketRef: found.ref, bracketUpdate: null };

    // A walkover that sent someone on gets reopened — take them back out.
    if (d.winnerEntryId) {
        const down = downstreamOf(d.id);
        if (down && (down.match.winnerEntryId || (isDone(down.match) && down.match.status !== "walkover"))) {
            throw new Error(`The next match ${matchNumberText(down.match)} is already decided — correct it first.`);
        }
        if (down) plan.summary.push(`${matchNumberText(down.match)} goes back to waiting for the winner of ${matchNumberText(d)}.`);
    }
    const reopen = b => { if (d.winnerEntryId) propagateWinnerChangeIfNeeded(d, null, b); };
    const other = d[side === "blue" ? "red" : "blue"];

    // Athletes the saved bracket still has in these slots who are in no
    // live match any more (left over from an older replace / delete) are
    // taken out of the bracket here.
    const inLive = new Set();
    categoryMatchList(d.categoryCode).forEach(x => ["blue", "red"].forEach(s => { if (x[s] && x[s].entryId) inLive.add(x[s].entryId); }));
    const stale = new Set();
    const clearStale = i => { const id = order[i]; if (id && !inLive.has(id)) { stale.add(id); order[i] = null; } };
    const addEntries = [];

    if (slot.kind === "bye") {
        clearStale(s0); clearStale(s1);
        if (order[s0] || order[s1]) {
            const who = [order[s0], order[s1]].filter(Boolean).map(id => (entries.find(e => e.entryId === id) || {}).name || id).join(", ");
            throw new Error(`The saved bracket still has ${who} in that slot and they're in another match — check this category.`);
        }
        order[s0] = athlete.id;
        plan.ops.push(b => {
            b.update(matchDocRef(d.id), {
                [side]: newCorner,
                status: other && other.entryId ? "ready" : "pending",
                winnerEntryId: null, win: null, win_score: null, win_type: null,
            });
            reopen(b);
        });
        plan.summary.unshift(`${athlete.displayName} goes into ${matchNumberText(d)} on the ${side} side (they get the bye).`);
    } else {
        const holderId = slot.corner.entryId;
        // The holder's slot: theirs by id, else the one holding their old
        // (replaced) id, else the first.
        let hs = order[s0] === holderId ? s0 : order[s1] === holderId ? s1 : -1;
        if (hs < 0) {
            hs = order[s0] && !inLive.has(order[s0]) ? s0 : order[s1] && !inLive.has(order[s1]) ? s1 : order[s0] ? s1 : s0;
            clearStale(hs);
            order[hs] = holderId;
            if (!entries.some(e => e.entryId === holderId)) addEntries.push(athleteFieldsOf(slot.corner));
        }
        const free = hs === s0 ? s1 : s0;
        clearStale(free);
        if (order[free]) throw new Error("No free slot next to that athlete in the saved bracket — check this category.");
        order[free] = athlete.id;

        const newId = treeMatchDocId(d, 1, pair + 1);
        if (matchesById.has(newId)) throw new Error("That round-1 match already exists.");

        // Same court, right before this match.
        const court = groupByCourtSorted()[d.courtId || "unassigned"] || [];
        const at = court.findIndex(x => x.id === d.id);
        const prev = at > 0 ? court[at - 1] : null;
        const round1 = categoryMatchList(d.categoryCode).find(x => Number(x.bracketRound) === 1 && x.poomsae);

        const holderCorner = slot.corner;
        const newMatch = {
            ...copyDefined(d, ["tournamentId", "tournamentName", "categoryCode", "categoryLabel", "courtId", "format", "isRanked",
                "roundTime", "breakTime", "pssSize", "hitLevel", "requiresPlexiHelmet", "resolvedVestGen", "roundSeconds"]),
            ...(round1 ? { poomsae: round1.poomsae } : {}),
            matchId: newId,
            bracketRound: 1,
            bracketMatchNumber: pair + 1,
            roundPhase: built.rounds[0][0].roundPhase,
            blue: free === s1 ? holderCorner : newCorner,
            red: free === s1 ? newCorner : holderCorner,
            status: "ready",
            winnerEntryId: null,
            queuePosition: computeInsertQueuePosition(prev, d),
            displayNumber: computeInsertDisplayNumber(prev, d),
            source: "tournament_system_bye_fill",
            createdAt: firebase.firestore.FieldValue.serverTimestamp(),
        };
        plan.ops.push(b => {
            b.set(matchDocRef(newId), newMatch);
            b.update(matchDocRef(d.id), {
                [side]: { entryId: null, source: { matchId: newId, slot: "winner" } },
                status: "pending",
                winnerEntryId: null, win: null, win_score: null, win_type: null,
            });
            reopen(b);
        });
        plan.summary.unshift(
            `New match #${newMatch.displayNumber} (${holderCorner.name} vs ${athlete.displayName}) on ${d.courtId || "the same court"}, right before ${matchNumberText(d)}.`,
            `${matchNumberText(d)} waits for its winner instead of ${holderCorner.name}.`);
    }

    let seed = entries.reduce((mx, e) => Math.max(mx, Number(e.seed) || 0), 0);
    if (stale.size) {
        const names = entries.filter(e => stale.has(e.entryId)).map(e => e.name || e.entryId);
        plan.summary.push(`Taken out of the bracket (no longer in any match): ${names.join(", ")}.`);
    }
    plan.bracketUpdate = {
        entries: [
            ...(doc.entries || []).filter(e => !stale.has(e.entryId)),
            ...addEntries.map(e => ({ ...e, seed: ++seed, associationIds: e.associationIds || [] })),
            { ...athleteFieldsOf(newCorner), seed: ++seed, associationIds: [] },
        ],
        slotOrder: order,
        entriesSyncedAt: firebase.firestore.FieldValue.serverTimestamp(),
    };
    plan.summary.push(`${athlete.displayName} is added to the ${doc.categoryLabel || doc.categoryCode} bracket.`);
    return plan;
}

let fillByeState = null; // { matchId, side, results, plan }

function openFillByeModal(matchId, side) {
    const d = matchesById.get(matchId);
    const slot = d && byeSlotsOf(d).find(s => s.side === side);
    if (!slot) return;
    fillByeState = { matchId, side, results: [], plan: null };
    const what = slot.kind === "bye"
        ? `The fighter goes straight into the ${side} side of ${matchNumberText(d)}.`
        : `${escapeHtml(slot.corner.name)} had a bye. A round-1 match against the fighter you pick is created right before ${matchNumberText(d)}.`;

    openModal(`
        <div class="lq-modal-header">
            <h3>Add fighter · ${escapeHtml(matchNumberText(d))} · ${escapeHtml(resolveCategoryLabel(d.categoryCode))}</h3>
            <button class="lq-modal-close" onclick="closeModal()">&times;</button>
        </div>
        <div class="lq-modal-body">
            <p class="lq-field-hint" style="margin-bottom:1rem;">${what} The bracket is updated too.</p>
            <input type="search" id="fill-bye-search" class="lq-text-input" placeholder="Search athlete…" autocomplete="off">
            <div id="fill-bye-results" class="lq-athlete-results"></div>
            <div id="fill-bye-plan" style="margin-top:1rem;"></div>
            <div id="fill-bye-error" class="lq-alert-error hidden"></div>
            <div class="lq-modal-actions">
                <button class="btn btn-primary" id="fill-bye-btn" disabled onclick="confirmFillBye()">Add fighter</button>
                <button class="btn btn-ghost" onclick="closeModal()">Cancel</button>
            </div>
        </div>
    `);

    let timer = null;
    const input = document.getElementById("fill-bye-search");
    input.oninput = () => {
        clearTimeout(timer);
        const q = input.value.trim();
        const el = document.getElementById("fill-bye-results");
        if (q.length < 2) { el.innerHTML = ""; return; }
        timer = setTimeout(async () => {
            try {
                const res = await fetch(`/api/athletes/search-admin?q=${encodeURIComponent(q)}&sport=${encodeURIComponent(SPORT)}&limit=8`);
                const athletes = (await res.json()).athletes || [];
                fillByeState.results = athletes;
                el.innerHTML = athletes.length ? athletes.map((a, i) => `
                    <div class="lq-athlete-result-item" data-idx="${i}">
                        <strong>${escapeHtml(a.displayName)}</strong><br>
                        <span style="color:var(--lq-muted); font-size:.75rem;">${escapeHtml(a.club || "No club")}${a.birthYear != null ? " · " + a.birthYear : ""}</span>
                    </div>`).join("") : `<div class="lq-athlete-result-item">No matching athletes.</div>`;
                el.querySelectorAll("[data-idx]").forEach(item => {
                    item.onclick = () => pickFillByeAthlete(parseInt(item.dataset.idx, 10));
                });
            } catch (err) {
                el.innerHTML = `<div class="lq-athlete-result-item">Search failed — try again.</div>`;
            }
        }, 250);
    };
    input.focus();
}

async function pickFillByeAthlete(idx) {
    const athlete = fillByeState && fillByeState.results[idx];
    if (!athlete) return;
    const planEl = document.getElementById("fill-bye-plan");
    const errEl = document.getElementById("fill-bye-error");
    const btn = document.getElementById("fill-bye-btn");
    errEl.classList.add("hidden");
    btn.disabled = true;
    fillByeState.plan = null;
    document.getElementById("fill-bye-results").innerHTML = "";
    document.getElementById("fill-bye-search").value = athlete.displayName;
    planEl.innerHTML = `<p class="lq-field-hint">Checking…</p>`;
    try {
        const plan = await planFillBye(fillByeState.matchId, fillByeState.side, athlete);
        if (!document.getElementById("fill-bye-plan")) return; // closed meanwhile
        fillByeState.plan = plan;
        planEl.innerHTML = `<ul style="margin:0 0 0 1.1rem; padding:0; font-size:.88rem; line-height:1.6;">${plan.summary.map(s => `<li>${escapeHtml(s)}</li>`).join("")}</ul>`;
        btn.disabled = false;
    } catch (err) {
        planEl.innerHTML = "";
        errEl.textContent = err.message;
        errEl.classList.remove("hidden");
    }
}

async function confirmFillBye() {
    const plan = fillByeState && fillByeState.plan;
    if (!plan) return;
    const btn = document.getElementById("fill-bye-btn");
    const errEl = document.getElementById("fill-bye-error");
    btn.disabled = true;
    btn.textContent = "Saving…";
    try {
        await applyMatchDeletion(plan); // same shape: ops + bracket update, one batch
        fillByeState = null;
        closeModal();
    } catch (err) {
        console.error("Fill bye failed", err);
        errEl.textContent = `Save failed: ${err.message}`;
        errEl.classList.remove("hidden");
        btn.disabled = false;
        btn.textContent = "Add fighter";
    }
}
// ═══════════════════════════════════════════════════════════════════
// CUT-OFF: RANKED PERFORMANCE ↔ BRACKET ENTRY
// A solo performance in a cut-off category that is (or becomes) ranked
// puts its athlete into the bracket doc's entries; one that becomes
// unranked takes them out again, unless they have another ranked
// performance in that category. Called from submitInsertMatch (new
// performance, before = null) and saveMatchEdits (Ranked ticked / unticked),
// in the same batch as the match write.
//
// A new performance also gets the round fields of its round
// (bracketRound, next bracketMatchNumber) so it's ranked with the rest.
// -> notes for the operator ([] when nothing to say)
// ═══════════════════════════════════════════════════════════════════
async function syncCutOffEntryForRanked(before, after, batch) {
    const wasRanked = before ? before.isRanked !== false : false;
    const nowRanked = after.isRanked !== false;
    if (before && wasRanked === nowRanked && !(nowRanked && after.bracketRound == null)) return [];
    const corner = after.blue;
    if (after.red || !corner || !corner.entryId || !after.categoryCode) return [];

    const found = await loadBracketDocRef(after.categoryCode);
    if (!found || found.data.system !== "cut_off") return [];
    const doc = found.data;
    const entries = doc.entries || [];
    const others = categoryMatchList(after.categoryCode).filter(x => !before || x.id !== before.id);
    const notes = [];

    if (nowRanked) {
        // Round fields, like the performances pushed with the bracket.
        if (after.bracketRound == null) {
            const sameRound = others.filter(x => (x.roundPhase || "") === (after.roundPhase || ""));
            const withRound = sameRound.find(x => x.bracketRound != null);
            if (withRound) {
                after.bracketRound = withRound.bracketRound;
                const nums = sameRound.map(x => Number(x.bracketMatchNumber)).filter(Number.isFinite);
                after.bracketMatchNumber = (nums.length ? Math.max(...nums) : 0) + 1;
            }
        }
        if (!entries.some(e => e.entryId === corner.entryId)) {
            const seed = entries.reduce((mx, e) => Math.max(mx, Number(e.seed) || 0), 0) + 1;
            batch.set(found.ref, {
                entries: [...entries, { ...athleteFieldsOf(corner), seed, associationIds: [] }],
                entriesSyncedAt: firebase.firestore.FieldValue.serverTimestamp(),
            }, { merge: true });
            notes.push(`${corner.name || corner.entryId} added to the ${doc.categoryLabel || doc.categoryCode} bracket.`);
        }
    } else if (before) {
        const stillRanked = others.some(x => x.isRanked !== false && x.blue && x.blue.entryId === corner.entryId);
        if (!stillRanked && entries.some(e => e.entryId === corner.entryId)) {
            batch.set(found.ref, {
                entries: entries.filter(e => e.entryId !== corner.entryId),
                entriesSyncedAt: firebase.firestore.FieldValue.serverTimestamp(),
            }, { merge: true });
            notes.push(`${corner.name || corner.entryId} taken out of the ${doc.categoryLabel || doc.categoryCode} bracket (unranked).`);
        }
    }
    return notes;
}