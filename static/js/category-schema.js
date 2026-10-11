/* ════════════════════════════════════════════════════════════════════
 * category-schema.js — turns a tournament's category schema into the flat
 * list of leaf categories, with the exact category CODES registrations are
 * stored under. Exposed as window.TrueVARCategories.
 *
 * Used by category_manager.html and the bracket builders. tournament.html
 * (parseCategories) and the API (_para_rules / DEFAULT_PARA_CLASS_OPTIONS
 * in api_router.py) compose the same codes — if the rule changes, change
 * it here and there together, or registrations show up as empty
 * categories.
 *
 * CODE: {entryType}_{age}[_{beltClass}][_{paraClass}]_{gender}[_{weight}]
 *   e.g. individual_poomsae_cadets_class_a_male
 *        para_individual_poomsae_seniors_p72_men
 *        seniors_male_68 (kyorugi, with entry type prefix)
 *
 * PARA RULES (mirror _para_rules in api_router.py):
 *   requires_para: false          → never para
 *   requires_para: true, a code starting with "para_", or a non-empty
 *   para_class_options            → para-only
 *   para_class_options: [...]     → split by those classes ([] = no split)
 *   otherwise, for a para type    → DEFAULT_PARA_CLASS_OPTIONS (P11 … P72)
 * ════════════════════════════════════════════════════════════════════ */
(function (global) {
    "use strict";

    // Same list as PARA_CATEGORIES in api_router.py.
    const PARA_CATEGORIES = [
        "P11", "P12",
        "P21", "P22", "P23",
        "P31", "P32", "P33", "P34", "P35",
        "P41", "P42", "P43", "P44", "P45",
        "P51", "P52", "P53",
        "P60",
        "P72",
    ];
    const DEFAULT_PARA_CLASS_OPTIONS = PARA_CATEGORIES.map(c => ({ code: c.toLowerCase(), label: c, match_value: c }));

    // A dimension that doesn't split this entry type: contributes nothing
    // to the code or label.
    const IMPLICIT = { code: "", label: "", min: null, max: null };

    // -> { requiresPara, classes } for one entry_type option.
    function paraRules(entryOpt) {
        const opt = entryOpt || {};
        if (opt.requires_para === false) return { requiresPara: false, classes: [] };
        const explicit = Array.isArray(opt.para_class_options) ? opt.para_class_options : null;
        const requiresPara = opt.requires_para === true
            || String(opt.code || "").toLowerCase().startsWith("para_")
            || !!(explicit && explicit.length > 0);
        if (!requiresPara) return { requiresPara: false, classes: [] };
        return { requiresPara: true, classes: explicit !== null ? explicit : DEFAULT_PARA_CLASS_OPTIONS };
    }

    // dimensions: the discipline's `dimensions` array from the schema.
    // -> [{ code, label, groupLabel, entryTypeCode, ageCode, beltClassCode,
    //       paraClassCode, genderCode, requiresPara, ageMin, ageMax,
    //       weightIndex, roundTime, breakTime, …Label, …Index }]
    function flatten(dimensions) {
        const schema = dimensions || [];
        const entryDim = schema.find(d => d.key === "entry_type");
        const ageDim = schema.find(d => d.key === "age");
        const genderDim = schema.find(d => d.key === "gender");
        const weightDim = schema.find(d => d.key === "weight");

        const entryOptions = (entryDim && entryDim.options && entryDim.options.length > 0)
            ? entryDim.options : [{ code: "individual", label: "Individual" }];
        const unit = (weightDim && weightDim.unit) || "kg";

        const flat = [];
        entryOptions.forEach((entryOpt, entryIndex) => {
            const ageOptions = entryOpt.age_options || (ageDim && ageDim.options) || [];
            const genderOptions = entryOpt.gender_options || (genderDim && genderDim.options) || [];
            const beltOptions = (entryOpt.belt_class_options && entryOpt.belt_class_options.length > 0)
                ? entryOpt.belt_class_options : [IMPLICIT];
            const para = paraRules(entryOpt);
            const paraOptions = para.classes.length > 0 ? para.classes : [IMPLICIT];

            ageOptions.forEach((ageOpt, ageIndex) => {
                beltOptions.forEach((beltOpt, beltIndex) => {
                    paraOptions.forEach((paraOpt, paraIndex) => {
                        genderOptions.forEach((genderOpt, genderIndex) => {
                            const codeBase = [ageOpt.code, beltOpt.code, paraOpt.code, genderOpt.code].filter(Boolean).join("_");

                            let leaves;
                            if (weightDim) {
                                const thresholds = (weightDim.thresholds_by && weightDim.thresholds_by[`${ageOpt.code}|${genderOpt.code}`]) || [];
                                if (thresholds.length === 0) return;
                                leaves = thresholds.map(w => ({ code: `${codeBase}_${w}`, label: `-${w}${unit}` }));
                                if (weightDim.open_top) {
                                    const top = thresholds[thresholds.length - 1];
                                    leaves.push({ code: `${codeBase}_${top}plus`, label: `+${top}${unit}` });
                                }
                            } else {
                                leaves = [{ code: codeBase, label: "" }];
                            }

                            leaves.forEach((leaf, weightIndex) => {
                                flat.push({
                                    code: `${entryOpt.code}_${leaf.code}`,
                                    entryTypeCode: entryOpt.code,
                                    ageCode: ageOpt.code,
                                    beltClassCode: beltOpt.code || null,
                                    paraClassCode: paraOpt.code || null,
                                    paraMatchValue: paraOpt.code ? (paraOpt.match_value || paraOpt.label || paraOpt.code) : null,
                                    genderCode: genderOpt.code,
                                    requiresPara: para.requiresPara,
                                    ageMin: ageOpt.min, ageMax: ageOpt.max, weightIndex,
                                    // Round/break length varies by age division.
                                    roundTime: ageOpt.roundTime || "02:00",
                                    breakTime: ageOpt.breakTime || "01:00",
                                    groupLabel: entryOpt.label,
                                    label: [ageOpt.label, beltOpt.label, paraOpt.label, genderOpt.label, leaf.label].filter(Boolean).join(" "),
                                    // Per-dimension labels / positions, for rules and ordering.
                                    entryTypeLabel: entryOpt.label || entryOpt.code,
                                    ageLabel: ageOpt.label || ageOpt.code,
                                    beltClassLabel: beltOpt.label || "",
                                    paraClassLabel: paraOpt.label || "",
                                    genderLabel: genderOpt.label || genderOpt.code,
                                    entryIndex, ageIndex, beltIndex, paraIndex, genderIndex,
                                });
                            });
                        });
                    });
                });
            });
        });
        return flat;
    }

    // Picks the discipline's dimensions out of /api/tournaments/{id}/categories
    // — the tournament's own sport/discipline if present, else the first.
    function dimensionsFor(categoriesResponse, sport, discipline) {
        const sportSchemas = (categoriesResponse && categoriesResponse.categories && categoriesResponse.categories.sportSchemas) || {};
        const sportKey = sportSchemas[sport] ? sport : Object.keys(sportSchemas)[0];
        const disciplines = (sportKey && sportSchemas[sportKey].disciplines) || {};
        const disciplineKey = disciplines[discipline] ? discipline : Object.keys(disciplines)[0];
        return disciplineKey ? (disciplines[disciplineKey].dimensions || []) : [];
    }

    global.TrueVARCategories = { flatten, dimensionsFor, paraRules, PARA_CATEGORIES, DEFAULT_PARA_CLASS_OPTIONS };
})(typeof window !== "undefined" ? window : globalThis);