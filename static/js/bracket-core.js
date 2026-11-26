/* ════════════════════════════════════════════════════════════════════
 * bracket-core.js — shared single-elimination bracket builder.
 *
 * Pure functions, no DOM, no Firestore. Exposed as window.BracketCore.
 *
 * Used by:
 *   - bracket_builder.html  → generates brackets before push
 *   - live_queue.html       → rebuilds the SAME tree from the saved bracket
 *                             doc (entries + seed + placementStrategy, or
 *                             the frozen slotOrder once the live queue has
 *                             replaced or removed athletes)
 *
 * Both pages MUST run this exact code. The live queue reconstructs the
 * tree by re-running placement on the saved seed order.
 *
 * New brackets use placementStrategy "wt": the WT seed → line table
 * (wtSeedSlotOrder) and nothing else. All the club-spreading happens in
 * the SEEDING (clubSpreadSeeding), whose result is saved as entries[].seed
 * — so rebuilding a pushed bracket is a pure table lookup. The older
 * "standard" / "club_country_spread" placements are kept only so brackets
 * pushed before the WT draw still rebuild the way they were pushed.
 * ════════════════════════════════════════════════════════════════════ */
(function (global) {
    "use strict";

    // ── Small helpers ───────────────────────────────────────────────────
    function nextPowerOfTwo(n) {
        let p = 1;
        while (p < n) p *= 2;
        return p;
    }

    function sameClub(a, b) {
        return !!(a && b && a.clubId && b.clubId && a.clubId === b.clubId);
    }

    function sameCountry(a, b) {
        return !!(a && b && a.country && b.country && a.country === b.country);
    }

    // Short phase code stored on every match as `roundPhase`.
    function roundPhaseCode(playersEntering) {
        if (playersEntering === 2) return "F";
        if (playersEntering === 4) return "SF";
        if (playersEntering === 8) return "QF";
        return `R${playersEntering}`;
    }

    // Long label printed across the top of the draw sheet.
    function roundLabelText(playersEntering) {
        if (playersEntering === 2) return "Final";
        if (playersEntering === 4) return "Semifinals";
        if (playersEntering === 8) return "Quarterfinals";
        return `Round of ${playersEntering}`;
    }

    // Corner written onto a match doc. clubName travels with clubId so
    // court-side apps can show the club without another lookup.
    function cornerFromEntry(e) {
        return e
            ? { entryId: e.entryId, athleteIds: e.athleteIds, name: e.name, country: e.country, clubId: e.clubId, clubName: e.clubName || null }
            : { entryId: null, source: null };
    }

    // ── Seeding table ───────────────────────────────────────────────────
    // Recursive halving: seeds 1 & 2 in opposite halves, 1-4 in different
    // quarters, etc.
    function standardSeedSlotOrder(bracketSize) {
        let order = [1];
        while (order.length < bracketSize) {
            const n = order.length * 2;
            const next = [];
            order.forEach(s => { next.push(s); next.push(n + 1 - s); });
            order = next;
        }
        return order;
    }

    function placeStandard(seededEntries, bracketSize) {
        const slotOrder = standardSeedSlotOrder(bracketSize);
        const slots = new Array(bracketSize).fill(null);
        slotOrder.forEach((seed, i) => { slots[i] = seededEntries[seed - 1] || null; }); // null = bye
        return slots;
    }

    // ── Round-1 club clash solver (HARD LOCK #2) ────────────────────────
    // Exact branch-and-bound over perfect matchings:
    //   primary cost   = same-club pairs (weight 1000)
    //   secondary cost = same-country pairs (weight 1, tie-break only)
    // Phase 1 keeps byes on top seeds; phase 2 lets byes move only if that
    // removes a same-club pair. Deterministic for a given input order,
    // which is what lets live_queue.html reproduce the builder's tree.
    const CLUB_CLASH_COST = 1000;
    const COUNTRY_CLASH_COST = 1;
    const SEEDING_NODE_LIMIT = 40000;

    function solveMinClashPairing(items, nodeLimit) {
        const n = items.length;
        if (n === 0) return { cost: 0, pairs: [], proven: true };

        const C = [];
        for (let i = 0; i < n; i++) {
            const row = new Array(n);
            for (let j = 0; j < n; j++) {
                const a = items[i], b = items[j];
                if (i === j || (a.bye && b.bye)) row[j] = Infinity;
                else if (a.bye) row[j] = b.byeCost || 0;
                else if (b.bye) row[j] = a.byeCost || 0;
                else row[j] = (sameClub(a.entry, b.entry) ? CLUB_CLASH_COST : 0)
                    + (sameCountry(a.entry, b.entry) ? COUNTRY_CLASH_COST : 0);
            }
            C.push(row);
        }

        const used = new Array(n).fill(false);
        let freeByes = items.filter(x => x.bye).length;
        let freeReals = n - freeByes;
        const cur = [];
        let best = Infinity, bestPairs = null, nodes = 0, exhausted = true;

        function dfs(acc) {
            if (++nodes > nodeLimit) { exhausted = false; return; }

            let pick = -1, pickMin = -1, pickCount = Infinity, lbSum = 0;
            for (let i = 0; i < n; i++) {
                if (used[i]) continue;
                let min = Infinity, count = 0;
                for (let j = 0; j < n; j++) {
                    if (used[j] || j === i) continue;
                    const c = C[i][j];
                    if (c < min) { min = c; count = 1; } else if (c === min) count++;
                }
                if (min === Infinity) return;
                lbSum += min;
                if (min > pickMin || (min === pickMin && count < pickCount)) { pick = i; pickMin = min; pickCount = count; }
            }
            if (pick === -1) {
                if (acc < best) { best = acc; bestPairs = cur.slice(); }
                return;
            }
            if (acc + lbSum / 2 >= best) return;

            const partners = [];
            for (let j = 0; j < n; j++) if (!used[j] && j !== pick && C[pick][j] !== Infinity) partners.push(j);
            partners.sort((x, y) => C[pick][x] - C[pick][y]);

            used[pick] = true;
            for (const j of partners) {
                if (acc + C[pick][j] >= best) break;
                const bothReal = !items[pick].bye && !items[j].bye;
                if (bothReal && freeByes > freeReals - 2) continue;
                used[j] = true; cur.push([pick, j]);
                if (bothReal) freeReals -= 2; else { freeReals -= 1; freeByes -= 1; }
                dfs(acc + C[pick][j]);
                if (bothReal) freeReals += 2; else { freeReals += 1; freeByes += 1; }
                cur.pop(); used[j] = false;
                if (!exhausted) break;
            }
            used[pick] = false;
        }
        dfs(0);

        return {
            cost: best,
            pairs: bestPairs ? bestPairs.map(([i, j]) => [items[i], items[j]]) : null,
            proven: exhausted && bestPairs !== null,
        };
    }

    // -> { pairs: [[entry, entry|null]], clubClashes, proven, byesMoved }
    function bestRound1Pairing(seededEntries, bracketSize) {
        const byeCount = bracketSize - seededEntries.length;
        const clubCount = cost => Math.floor((cost + 1e-6) / CLUB_CLASH_COST);

        const byeHolders = seededEntries.slice(0, byeCount);
        const phase1 = solveMinClashPairing(seededEntries.slice(byeCount).map(e => ({ entry: e })), SEEDING_NODE_LIMIT);
        let best = {
            pairs: [...byeHolders.map(e => [e, null]), ...(phase1.pairs || []).map(([a, b]) => [a.entry, b.entry])],
            clubClashes: clubCount(phase1.cost),
            proven: clubCount(phase1.cost) === 0 || (byeCount === 0 && phase1.proven),
            byesMoved: false,
        };

        if (byeCount > 0 && best.clubClashes > 0) {
            const items = seededEntries.map((e, idx) => ({ entry: e, byeCost: idx * 1e-4 }));
            for (let k = 0; k < byeCount; k++) items.push({ bye: true });
            const phase2 = solveMinClashPairing(items, SEEDING_NODE_LIMIT);
            if (phase2.pairs && clubCount(phase2.cost) < best.clubClashes) {
                best = {
                    pairs: phase2.pairs.map(([a, b]) => a.bye ? [b.entry, null] : b.bye ? [a.entry, null] : [a.entry, b.entry]),
                    clubClashes: clubCount(phase2.cost),
                    proven: phase2.proven,
                    byesMoved: true,
                };
            } else {
                best.proven = phase2.proven;
            }
        }

        // Counting lower bound: a club with k entrants needs k outside
        // partners, so ceil((k - others - byes) / 2) clashes are forced.
        if (!best.proven) {
            const perClub = {};
            seededEntries.forEach(e => { if (e.clubId) perClub[e.clubId] = (perClub[e.clubId] || 0) + 1; });
            const forced = Object.values(perClub).reduce((mx, k) =>
                Math.max(mx, Math.ceil(Math.max(0, k - (seededEntries.length - k) - byeCount) / 2)), 0);
            if (best.clubClashes <= forced) best.proven = true;
        }
        return best;
    }

    function placePairsIntoBracket(pairs, bracketSize) {
        const order = standardSeedSlotOrder(bracketSize);
        const positions = [];
        for (let p = 0; p < bracketSize / 2; p++) positions.push({ p, key: Math.min(order[2 * p], order[2 * p + 1]) });
        positions.sort((a, b) => a.key - b.key);

        const seedOf = e => (e ? e.seed : Infinity);
        const normalized = pairs
            .map(([a, b]) => (seedOf(a) <= seedOf(b) ? [a, b] : [b, a]))
            .sort((x, y) => seedOf(x[0]) - seedOf(y[0]));

        const slots = new Array(bracketSize).fill(null);
        normalized.forEach((pair, k) => {
            const p = positions[k].p;
            slots[2 * p] = pair[0];
            slots[2 * p + 1] = pair[1];
        });
        return slots;
    }

    function annotateRound1(slots, pairing) {
        let club = 0, country = 0;
        for (let i = 0; i < slots.length; i += 2) {
            if (sameClub(slots[i], slots[i + 1])) club++;
            if (sameCountry(slots[i], slots[i + 1])) country++;
        }
        slots.conflictCount = club;
        slots.countryConflictCount = country;
        slots.minClubClashes = pairing.clubClashes;
        slots.minClashProven = pairing.proven;
        slots.byesMoved = pairing.byesMoved;
        return slots;
    }

    // "Standard": seed order only, but still computes the true minimum so
    // the hard-lock checker can flag avoidable same-club pairs.
    function placeStandardChecked(seededEntries, bracketSize) {
        return annotateRound1(placeStandard(seededEntries, bracketSize), bestRound1Pairing(seededEntries, bracketSize));
    }

    function placeClubSpread(seededEntries, bracketSize) {
        const pairing = bestRound1Pairing(seededEntries, bracketSize);
        return annotateRound1(placePairsIntoBracket(pairing.pairs, bracketSize), pairing);
    }

    // ════════════════════════════════════════════════════════════════════
    // WT DRAW — the ONE placement every new bracket uses.
    //
    // Seeds → lines on the draw sheet. Only the SEEDING (who is seed 1, 2,
    // 3 …) changes between strategies (club spread now, a ranking later);
    // the seed → line table is always this one. So a saved bracket is
    // rebuilt exactly from `entries[].seed` alone — no solver has to be
    // re-run, nothing can drift between the builder and the live queue.
    //
    // WT rules publish the principle, not a table: seeds 1 & 2 in opposite
    // halves, 1–4 in different quarters, 1–8 in different eighths, byes to
    // the top seeds. This is the usual draw-sheet layout of it:
    //   seed 1 on the top line, seed 2 on the bottom line,
    //   every seed s meets seed (B + 1 − s) in round 1,
    //   1 meets 4 and 2 meets 3 in the semi-finals,
    //   with N < B entrants the missing seeds N+1 … B are the byes, so
    //   seeds 1 … B−N get them.
    // e.g. B = 8 → lines 1,8,5,4 | 3,6,7,2
    // ════════════════════════════════════════════════════════════════════
    function wtSeedSlotOrder(bracketSize) {
        let order = [1];
        while (order.length < bracketSize) {
            const n = order.length * 2;
            const next = [];
            order.forEach((s, i) => {
                if (i % 2 === 0) next.push(s, n + 1 - s);
                else next.push(n + 1 - s, s);
            });
            order = next;
        }
        return order;
    }

    // seedEntries[k] = entry with seed k + 1 (shorter than bracketSize → byes).
    function placeWTSlots(seedEntries, bracketSize) {
        return wtSeedSlotOrder(bracketSize).map(seed => seedEntries[seed - 1] || null);
    }

    // Same-club / same-country meetings a draw allows in its first two
    // rounds. Round 2 counts only when it isn't already the final (B ≥ 8):
    // two club-mates meeting in a final is fine.
    //   r1Club     same-club round-1 pairs
    //   r2Club     same-club pairs that meet in round 2 if both win
    function drawClashStats(slots) {
        let r1Club = 0, r2Club = 0, r1Country = 0, r2Country = 0;
        for (let i = 0; i < slots.length; i += 2) {
            if (sameClub(slots[i], slots[i + 1])) r1Club++;
            if (sameCountry(slots[i], slots[i + 1])) r1Country++;
        }
        if (slots.length >= 8) {
            for (let i = 0; i < slots.length; i += 4) {
                for (const a of [slots[i], slots[i + 1]]) {
                    for (const b of [slots[i + 2], slots[i + 3]]) {
                        if (sameClub(a, b)) r2Club++;
                        if (sameCountry(a, b)) r2Country++;
                    }
                }
            }
        }
        return { r1Club, r2Club, r1Country, r2Country };
    }

    // One number to minimise: round-1 club pairs ≫ round-2 club pairs ≫
    // round-1 country pairs ≫ round-2 country pairs.
    function drawCost(st) {
        return st.r1Club * 1e6 + st.r2Club * 1e3 + st.r1Country * 10 + st.r2Country;
    }

    function seedClashStats(seedEntries, bracketSize) {
        return drawClashStats(placeWTSlots(seedEntries, bracketSize));
    }

    // ── CLUB-SPREAD SEEDING ─────────────────────────────────────────────
    // Step 1 — sort: country, club name, athlete name → index 1 … N. Every
    //   club (and every country) is now one contiguous run.
    // Step 2 — deal the indices onto seeds so that, through the WT table,
    //   index k and index k + B/2 share a round-1 match. With seeds that is:
    //     first  the round-1 matches that have two athletes — one athlete
    //            each (the lower seed of the match),
    //     then   the matches with a bye (the top seeds),
    //     then   the second athlete of each two-athlete match, same order.
    //   A run shorter than B/2 can therefore never meet itself in round 1,
    //   which is also the mathematical best (a club with more than half the
    //   draw MUST meet itself). The matches are taken in an order that
    //   puts the two matches of each round-2 group far apart, so short runs
    //   don't meet in round 2 either.
    // Step 3 — check: any same-club pair in round 1, or in round 2 (when
    //   that isn't the final)? Then search — exact branch-and-bound for
    //   round 1, then for round 2, then swap polishing — and keep whichever
    //   draw is better.
    function clubSortKey(e) {
        return [
            String(e.country || "").toUpperCase(),
            String(e.clubName || "").toLocaleLowerCase(),
            String(e.clubId || ""),
            String(e.name || "").toLocaleLowerCase(),
            String(e.entryId || ""),
        ];
    }

    function sortByClub(entries) {
        return entries.slice().sort((a, b) => {
            const ka = clubSortKey(a), kb = clubSortKey(b);
            for (let i = 0; i < ka.length; i++) {
                const c = ka[i].localeCompare(kb[i]);
                if (c !== 0) return c;
            }
            return 0;
        });
    }

    // Match ids are the lower seed of each round-1 match (1 … B/2). Round-2
    // group of match j is {j, B/2 + 1 − j}. Order: one match of every
    // round-2 group first, then the other one, group by group — so the two
    // matches of a group are as far apart in the deal as possible.
    function spreadMatchOrder(ids, half) {
        const lows = ids.filter(j => j <= half / 2).sort((a, b) => a - b);
        const highs = ids.filter(j => j > half / 2).sort((a, b) => b - a);
        return lows.concat(highs);
    }

    function dealSeeds(sorted, bracketSize) {
        const n = sorted.length, half = bracketSize / 2, byes = bracketSize - n;
        const allIds = [];
        for (let j = 1; j <= half; j++) allIds.push(j);
        const full = spreadMatchOrder(allIds.filter(j => j > byes), half);
        const solo = spreadMatchOrder(allIds.filter(j => j <= byes), half);
        const seats = [...full, ...solo, ...full.map(j => bracketSize + 1 - j)];
        const seedEntries = new Array(n).fill(null);
        seats.forEach((seed, i) => { seedEntries[seed - 1] = sorted[i]; });
        return seedEntries;
    }

    // Min-cost perfect matching, branch-and-bound. Items have a `kind`
    // (0/1). Two items of the same kind may only be paired while that
    // keeps the most possible mixed pairs — in the WT draw a bye always
    // faces an athlete, and a round-2 group only holds two bye-matches
    // when there are more bye-matches than groups.
    function solveKindMatching(items, C, nodeLimit) {
        const n = items.length;
        if (n === 0) return { cost: 0, pairs: [], proven: true };
        const used = new Array(n).fill(false);
        const free = [0, 0];
        items.forEach(x => free[x.kind]++);
        const cur = [];
        let best = Infinity, bestPairs = null, nodes = 0, exhausted = true;

        function dfs(acc) {
            if (++nodes > nodeLimit) { exhausted = false; return; }
            let pick = -1, pickMin = -1, pickCount = Infinity, lbSum = 0;
            for (let i = 0; i < n; i++) {
                if (used[i]) continue;
                let min = Infinity, count = 0;
                for (let j = 0; j < n; j++) {
                    if (used[j] || j === i) continue;
                    const c = C[i][j];
                    if (c < min) { min = c; count = 1; } else if (c === min) count++;
                }
                if (min === Infinity) return;
                lbSum += min;
                if (min > pickMin || (min === pickMin && count < pickCount)) { pick = i; pickMin = min; pickCount = count; }
            }
            if (pick === -1) {
                if (acc < best) { best = acc; bestPairs = cur.slice(); }
                return;
            }
            if (acc + lbSum / 2 >= best) return;

            const partners = [];
            for (let j = 0; j < n; j++) if (!used[j] && j !== pick && C[pick][j] !== Infinity) partners.push(j);
            partners.sort((x, y) => C[pick][x] - C[pick][y]);

            used[pick] = true;
            for (const j of partners) {
                if (acc + C[pick][j] >= best) break;
                const k = items[pick].kind;
                const same = items[j].kind === k;
                if (same && free[k] - 2 < free[1 - k]) continue;
                used[j] = true; cur.push([pick, j]);
                free[k]--; free[items[j].kind]--;
                dfs(acc + C[pick][j]);
                free[k]++; free[items[j].kind]++;
                cur.pop(); used[j] = false;
                if (!exhausted) break;
            }
            used[pick] = false;
        }
        dfs(0);
        return {
            cost: best,
            pairs: bestPairs ? bestPairs.map(([i, j]) => [items[i], items[j]]) : null,
            proven: exhausted && bestPairs !== null,
        };
    }

    function pairCost(a, b, clubW, countryW) {
        return (sameClub(a, b) ? clubW : 0) + (sameCountry(a, b) ? countryW : 0);
    }

    function costMatrix(items, fn) {
        return items.map((a, i) => items.map((b, j) => (i === j ? Infinity : fn(a, b))));
    }

    // The "brute force": exact round-1 pairing (byes may go to anyone),
    // then exact grouping of those matches into round-2 groups, then
    // mapped onto WT seeds. -> { seedEntries, r1Proven } | null
    function searchSeeds(entries, bracketSize, nodeLimit, round2NodeLimit) {
        const n = entries.length, half = bracketSize / 2, byes = bracketSize - n;

        // Round 1: athletes (kind 0) + bye tokens (kind 1).
        const r1Items = entries.map(e => ({ kind: 0, entry: e }));
        for (let k = 0; k < byes; k++) r1Items.push({ kind: 1, bye: true });
        const r1 = solveKindMatching(r1Items, costMatrix(r1Items, (a, b) => {
            if (a.bye && b.bye) return Infinity;
            if (a.bye || b.bye) return 0;
            return pairCost(a.entry, b.entry, 1000, 1);
        }), nodeLimit);
        if (!r1.pairs) return null;
        const matches = r1.pairs.map(([a, b]) => {
            const members = [a, b].filter(x => !x.bye).map(x => x.entry);
            return { kind: members.length === 1 ? 1 : 0, members };
        });

        // Round 2: matches (kind 0 = two athletes, kind 1 = bye-match).
        let groups;
        if (half >= 2) {
            const r2 = solveKindMatching(matches, costMatrix(matches, (a, b) => {
                let c = 0;
                a.members.forEach(x => b.members.forEach(y => { c += pairCost(x, y, 1000, 1); }));
                return c;
            }), round2NodeLimit);
            if (!r2.pairs) return null;
            groups = r2.pairs;
        } else {
            groups = [[matches[0]]];
        }

        // WT round-2 group g holds match ids g and half + 1 − g; id j ≤ byes
        // is a bye-match. Hand each found group to a WT group of its shape.
        const wtGroups = [];
        if (half >= 2) for (let g = 1; g <= half / 2; g++) wtGroups.push([g, half + 1 - g]);
        else wtGroups.push([1]);
        const byeCount = ids => ids.filter(j => j <= byes).length;
        const pool = {};
        groups.forEach(grp => {
            const key = grp.filter(m => m.kind === 1).length;
            (pool[key] = pool[key] || []).push(grp);
        });

        const seedEntries = new Array(n).fill(null);
        for (const ids of wtGroups) {
            const grp = (pool[byeCount(ids)] || []).shift();
            if (!grp) return null;
            // bye-match → bye id, two-athlete match → the other id
            const sorted = grp.slice().sort((a, b) => b.kind - a.kind);
            const idOrder = ids.slice().sort((a, b) => (b <= byes) - (a <= byes));
            sorted.forEach((m, i) => {
                const j = idOrder[i];
                seedEntries[j - 1] = m.members[0];
                if (m.members[1]) seedEntries[bracketSize - j] = m.members[1];
            });
        }
        if (seedEntries.some(e => !e)) return null;
        return { seedEntries, r1Proven: r1.proven };
    }

    // Swap any two athletes' seeds while the draw cost drops. Seeds above
    // N stay byes, so the WT layout is never broken.
    function polishSeeds(seedEntries, bracketSize, timeBudgetMs) {
        const s = seedEntries.slice();
        let cost = drawCost(seedClashStats(s, bracketSize));
        const deadline = Date.now() + timeBudgetMs;
        let improved = true;
        while (improved && cost > 0 && Date.now() < deadline) {
            improved = false;
            for (let i = 0; i < s.length && cost > 0; i++) {
                for (let j = i + 1; j < s.length; j++) {
                    [s[i], s[j]] = [s[j], s[i]];
                    const c = drawCost(seedClashStats(s, bracketSize));
                    if (c < cost) { cost = c; improved = true; }
                    else[s[i], s[j]] = [s[j], s[i]];
                }
            }
        }
        return s;
    }

    // Forced same-club round-1 pairs: a club with k of the N entrants needs
    // k outside partners (another athlete or a bye).
    function round1LowerBound(entries, bracketSize) {
        const byes = bracketSize - entries.length;
        const perClub = {};
        entries.forEach(e => { if (e.clubId) perClub[e.clubId] = (perClub[e.clubId] || 0) + 1; });
        return Object.values(perClub).reduce((sum, k) =>
            sum + Math.ceil(Math.max(0, k - (entries.length - k) - byes) / 2), 0);
    }

    // -> { seeded: entries in seed order (seed 1 first), stats,
    //      minClubClashes, minClashProven, minRound2Clashes, searched }
    function clubSpreadSeeding(entries, opts) {
        opts = opts || {};
        const n = entries.length;
        const bracketSize = nextPowerOfTwo(Math.max(n, 1));
        const sorted = sortByClub(entries);
        if (n <= 2) {
            const stats = seedClashStats(sorted, bracketSize);
            return { seeded: sorted, stats, minClubClashes: stats.r1Club, minClashProven: true, minRound2Clashes: 0, searched: false };
        }

        let best = dealSeeds(sorted, bracketSize);
        let stats = seedClashStats(best, bracketSize);
        let searched = false, r1Proven = stats.r1Club <= round1LowerBound(entries, bracketSize);

        if (stats.r1Club > 0 || stats.r2Club > 0) {
            searched = true;
            const found = searchSeeds(sorted, bracketSize, opts.nodeLimit || SEEDING_NODE_LIMIT, opts.round2NodeLimit || 5000);
            const candidates = [best];
            if (found) {
                candidates.push(found.seedEntries);
                if (found.r1Proven) r1Proven = true;
            }
            const polished = candidates.map(c => polishSeeds(c, bracketSize, opts.polishMs || 50));
            polished.forEach(c => candidates.push(c));
            candidates.forEach(c => {
                const st = seedClashStats(c, bracketSize);
                if (drawCost(st) < drawCost(stats)) { best = c; stats = st; }
            });
        }
        const result = {
            seeded: best,
            stats,
            minClubClashes: stats.r1Club,
            minClashProven: r1Proven || stats.r1Club <= round1LowerBound(entries, bracketSize),
            minRound2Clashes: stats.r2Club,
            searched,
        };
        rememberSpread(entries, result);
        return result;
    }

    // placeWT needs the best club-spread result for the same athletes the
    // seeding step just solved — remember it instead of searching twice.
    const spreadCache = new Map();
    function spreadKey(entries) {
        return entries.map(e => `${e.entryId}|${e.clubId || ""}|${e.country || ""}`).sort().join(",");
    }
    function rememberSpread(entries, result) {
        if (spreadCache.size > 500) spreadCache.clear();
        spreadCache.set(spreadKey(entries), result);
    }
    function bestSpreadFor(entries) {
        return spreadCache.get(spreadKey(entries)) || clubSpreadSeeding(entries);
    }

    // Placement for every new bracket: entries arrive in seed order (seed 1
    // first) from whatever seeding strategy ran; they go on the WT lines.
    // When the draw has same-club meetings, the best club-spread draw is
    // worked out too, so the hard-lock checker can tell avoidable from
    // unavoidable (e.g. with registration-order seeding).
    function placeWT(seededEntries, bracketSize) {
        const slots = placeWTSlots(seededEntries, bracketSize);
        const st = drawClashStats(slots);
        let minR1 = st.r1Club, minR2 = st.r2Club, proven = true;
        if (st.r1Club > 0 || st.r2Club > 0) {
            const ref = bestSpreadFor(seededEntries);
            // Lexicographic: round 1 first, round 2 only among equal round 1.
            minR1 = Math.min(st.r1Club, ref.minClubClashes);
            minR2 = ref.minClubClashes < st.r1Club ? ref.minRound2Clashes : Math.min(st.r2Club, ref.minRound2Clashes);
            proven = ref.minClashProven || minR1 <= round1LowerBound(seededEntries, bracketSize);
        }
        slots.conflictCount = st.r1Club;
        slots.countryConflictCount = st.r1Country;
        slots.round2ConflictCount = st.r2Club;
        slots.minClubClashes = minR1;
        slots.minClashProven = proven;
        slots.minRound2Clashes = minR2;
        slots.byesMoved = false;
        return slots;
    }

    // Registry — keys are what gets saved as `placementStrategy` on the
    // bracket doc, so never rename an existing key. New brackets are all
    // "wt"; the other two stay only so brackets pushed before the WT draw
    // still rebuild exactly as they were pushed.
    const PLACEMENT_STRATEGIES = {
        wt: placeWT,
        standard: placeStandardChecked,           // legacy
        club_country_spread: placeClubSpread,     // legacy
    };

    // ── Single elimination tree ─────────────────────────────────────────
    // Match ids follow "{categoryCode}_r{round}_m{matchNumber}" — depends
    // only on structure, never on who sits in a slot, which is why a saved
    // `source.matchId` resolves against a freshly rebuilt tree.
    //
    // fixedBracketSize (optional, a power of two ≥ entries.length): keeps
    // the tree at that size instead of the smallest that fits. The live
    // queue passes it once athletes have been removed from a pushed
    // bracket, so the tree keeps the shape it was pushed with. The bracket
    // builder never passes it.
    function generateSingleElimination(categoryCode, entries, placementFn, fixedBracketSize) {
        placementFn = placementFn || PLACEMENT_STRATEGIES.standard;
        const fits = fixedBracketSize >= entries.length && fixedBracketSize >= 2 && (fixedBracketSize & (fixedBracketSize - 1)) === 0;
        const bracketSize = fits ? fixedBracketSize : nextPowerOfTwo(entries.length);
        const slots = placementFn(entries, bracketSize);

        const entrySlotIndex = {};
        slots.forEach((entry, idx) => { if (entry) entrySlotIndex[entry.entryId] = idx; });

        const rounds = [];
        let prevRoundMatches = null;
        let roundNum = 1;

        for (; ;) {
            const numMatches = roundNum === 1 ? bracketSize / 2 : prevRoundMatches.length / 2;
            if (numMatches < 1) break;

            const roundMatches = [];
            for (let i = 0; i < numMatches; i++) {
                const matchId = `${categoryCode}_r${roundNum}_m${i + 1}`;
                let blue, red, status, winnerCorner = null;

                if (roundNum === 1) {
                    const p1 = slots[i * 2], p2 = slots[i * 2 + 1];
                    blue = cornerFromEntry(p1);
                    red = cornerFromEntry(p2);
                    if (p1 && !p2) { status = "walkover"; winnerCorner = cornerFromEntry(p1); }
                    else if (p2 && !p1) { status = "walkover"; winnerCorner = cornerFromEntry(p2); }
                    else if (p1 && p2) status = "ready";
                    else status = "walkover";
                } else {
                    const m1 = prevRoundMatches[i * 2], m2 = prevRoundMatches[i * 2 + 1];
                    blue = m1.status === "walkover" ? m1.winnerCorner : { entryId: null, source: { matchId: m1.matchId, slot: "winner" } };
                    red = m2.status === "walkover" ? m2.winnerCorner : { entryId: null, source: { matchId: m2.matchId, slot: "winner" } };
                    status = (blue && blue.entryId && red && red.entryId) ? "ready" : "pending";
                }

                const playersEnteringRound = bracketSize / Math.pow(2, roundNum - 1);
                roundMatches.push({
                    matchId, categoryCode, round: roundNum, matchNumber: i + 1,
                    roundPhase: roundPhaseCode(playersEnteringRound),
                    blue, red, status, winnerEntryId: null,
                    winnerCorner, // internal only — walkovers are never pushed
                    courtId: null, queuePosition: null,
                });
            }

            rounds.push(roundMatches);
            if (roundMatches.length === 1) break;
            prevRoundMatches = roundMatches;
            roundNum++;
        }

        return {
            rounds, bracketSize, entrySlotIndex,
            conflictCount: slots.conflictCount || 0,
            minClubClashes: slots.minClubClashes ?? null,
            minClashProven: slots.minClashProven ?? null,
            round2ConflictCount: slots.round2ConflictCount ?? null,
            minRound2Clashes: slots.minRound2Clashes ?? null,
            byesMoved: !!slots.byesMoved,
        };
    }

    global.BracketCore = {
        nextPowerOfTwo, sameClub, sameCountry,
        roundPhaseCode, roundLabelText, cornerFromEntry,
        standardSeedSlotOrder, placeStandard, placeStandardChecked, placeClubSpread,
        bestRound1Pairing, PLACEMENT_STRATEGIES,
        wtSeedSlotOrder, placeWT, drawClashStats, clubSpreadSeeding, sortByClub,
        generateSingleElimination,
    };
})(typeof window !== "undefined" ? window : globalThis);