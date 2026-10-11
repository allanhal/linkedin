// Turns model answers + structural checks on the parsed profile into a ranked list
// of concrete optimisation actions. tev1 is a decision model (it can't write text),
// so the advice lives here as rules; the model supplies the judgements.

const PRIORITY = { high: 3, medium: 2, low: 1 };

// helpers over the answer map
const noul = (a, k) => (a[k]?.noul ?? null);
const score = (a, k, levels = 3) => (a[k]?.score != null ? a[k].score / levels : null);
const pct = (x) => `${Math.round(x * 100)}%`;
const lacks = (a, k, t = 0.5) => noul(a, k) != null && noul(a, k) < t;
const low = (a, k, t = 0.6) => score(a, k) != null && score(a, k) < t;

/**
 * Each rule: when(ctx) → truthy fires it; evidence(ctx) explains why; fix is the action.
 * `structural` rules only use the parsed page and are skipped for pasted text.
 */
const RULES = [
  // ── Headline ───────────────────────────────────────────────────
  {
    id: "headline_missing", area: "Headline", priority: "high", structural: true,
    when: ({ p }) => !p.headline,
    evidence: () => "No headline is visible on the public profile.",
    fix: "Add a headline. Use up to 220 characters in the form Role | Specialty | Key skills | Value you deliver.",
  },
  {
    id: "headline_short", area: "Headline", priority: "medium", structural: true,
    when: ({ p }) => p.headline && p.headline.length < 60,
    evidence: ({ p }) => `Headline is ${p.headline.length}/220 characters and leaves space unused.`,
    fix: "Use more of the 220 characters. Add your specialty and 2–3 skills recruiters search for, separated by \" | \".",
  },
  {
    id: "headline_keywords", area: "Headline", priority: "high",
    when: ({ a }) => lacks(a, "opt_headline_keywords"),
    evidence: ({ a }) => `Model: ${pct(noul(a, "opt_headline_keywords"))} likely the headline has searchable keywords.`,
    fix: "Put the exact terms recruiters type into search (e.g. \"React\", \"B2B SaaS\", \"Payments\") in the headline. Headline words weigh heavily in LinkedIn search.",
  },
  {
    id: "headline_value", area: "Headline", priority: "medium",
    when: ({ a }) => lacks(a, "opt_headline_value"),
    evidence: ({ a }) => `Model: ${pct(noul(a, "opt_headline_value"))} likely the headline states value.`,
    fix: "Add the outcome you deliver or who you help, e.g. \"helping fintechs ship faster\" or \"scaled X to 1M users\".",
  },
  {
    id: "headline_quality", area: "Headline", priority: "medium",
    when: ({ a }) => low(a, "headline_quality", 0.55),
    evidence: ({ a }) => `Headline quality ${a.headline_quality.score.toFixed(1)}/3.`,
    fix: "Rewrite the headline as a positioning statement rather than a job title. Test 2–3 versions and keep the one that gets more profile views.",
  },
  {
    id: "niche", area: "Positioning", priority: "high",
    when: ({ a }) => lacks(a, "opt_niche", 0.45),
    evidence: ({ a }) => `Model: ${pct(noul(a, "opt_niche"))} likely the specialty is clear.`,
    fix: "Pick one specialty and repeat it in the headline, the first line of About and your current role title, so people can tell what you're the go-to person for.",
  },

  // ── About ──────────────────────────────────────────────────────
  {
    id: "about_missing", area: "About", priority: "high", structural: true,
    when: ({ p }) => !p.about,
    evidence: () => "No About section is visible.",
    fix: "Write an About section of 3–5 short paragraphs: a hook, what you do and for whom, 2–3 proof points with numbers, your skills/keywords, and a call to action.",
  },
  {
    id: "about_short", area: "About", priority: "medium", structural: true,
    when: ({ p }) => p.about && p.about.length < 400,
    evidence: ({ p }) => `About is only ${p.about.length} characters (up to 2,600 allowed).`,
    fix: "Expand About to roughly 1,000–2,000 characters. Only the first ~300 show before \"see more\", so front-load the hook.",
  },
  {
    id: "about_hook", area: "About", priority: "medium",
    when: ({ a, p }) => (p.about || p.rawText) && lacks(a, "opt_about_hook"),
    evidence: ({ a }) => `Model: ${pct(noul(a, "opt_about_hook"))} likely the About opens with a hook.`,
    fix: "Rewrite the first sentence to say something specific or surprising about your work. Avoid openings like \"I am a passionate…\".",
  },
  {
    id: "about_proof", area: "About", priority: "medium",
    when: ({ a, p }) => (p.about || p.rawText) && lacks(a, "opt_about_proof"),
    evidence: ({ a }) => `Model: ${pct(noul(a, "opt_about_proof"))} likely the About backs claims with proof.`,
    fix: "Replace adjectives with evidence: name 2–3 achievements with numbers, notable clients or shipped projects.",
  },
  {
    id: "about_cta", area: "About", priority: "low",
    when: ({ a, p }) => (p.about || p.rawText) && lacks(a, "opt_about_cta"),
    evidence: ({ a }) => `Model: ${pct(noul(a, "opt_about_cta"))} likely there is a call to action.`,
    fix: "End About with a clear next step: what you're open to and how to reach you (email or \"DM me about…\").",
  },

  // ── Experience ─────────────────────────────────────────────────
  {
    id: "experience_missing", area: "Experience", priority: "high", structural: true,
    when: ({ p }) => !p.sections?.experience?.items?.length,
    evidence: () => "No experience is visible on the public profile.",
    fix: "Add your roles, and check Settings → Visibility → Edit your public profile so that Experience is shown publicly.",
  },
  {
    id: "experience_descriptions", area: "Experience", priority: "high", structural: true,
    when: ({ p }) => {
      const items = p.sections?.experience?.items || [];
      return items.length > 0 && items.filter((i) => i.description).length / items.length < 0.5;
    },
    evidence: ({ p }) => {
      const items = p.sections.experience.items;
      return `${items.filter((i) => !i.description).length} of ${items.length} roles have no description.`;
    },
    fix: "Give at least the last 2–3 roles 3–5 bullets each: what you built or owned, the scale, and the result.",
  },
  {
    id: "quantified", area: "Experience", priority: "high",
    when: ({ a }) => lacks(a, "quantified_impact"),
    evidence: ({ a }) => `Model: ${pct(noul(a, "quantified_impact"))} likely the profile shows measurable results.`,
    fix: "Add numbers to your top achievements: %, $, users, latency, team size, time saved. Use the pattern \"Did X, which resulted in Y, measured by Z\".",
  },
  {
    id: "action_verbs", area: "Experience", priority: "medium",
    when: ({ a }) => lacks(a, "opt_action_verbs"),
    evidence: ({ a }) => `Model: ${pct(noul(a, "opt_action_verbs"))} likely entries describe actions.`,
    fix: "Start each bullet with a strong verb (Led, Built, Cut, Launched, Scaled) and avoid \"Responsible for…\".",
  },
  {
    id: "experience_depth", area: "Experience", priority: "medium",
    when: ({ a }) => low(a, "experience_depth", 0.55),
    evidence: ({ a }) => `Experience detail ${a.experience_depth.score.toFixed(1)}/3.`,
    fix: "Add a skills line to each recent role and link media (repos, case studies, launches) to the strongest roles.",
  },
  {
    id: "short_tenures", area: "Experience", priority: "low",
    when: ({ a }) => noul(a, "short_tenures") != null && noul(a, "short_tenures") > 0.6,
    evidence: ({ a }) => `Model: ${pct(noul(a, "short_tenures"))} likely there are frequent short roles.`,
    fix: "Group contract or freelance gigs under one \"Independent / Consultant\" entry and explain short stints (e.g. acquisition, contract) in a one-line description.",
  },
  {
    id: "consistency", area: "Positioning", priority: "medium",
    when: ({ a }) => lacks(a, "opt_consistent_story", 0.45),
    evidence: ({ a }) => `Model: ${pct(noul(a, "opt_consistent_story"))} likely the profile tells one story.`,
    fix: "Make the headline, About and recent roles point to the same target role and trim or de-emphasise unrelated history.",
  },

  // ── Profile basics ─────────────────────────────────────────────
  {
    id: "photo", area: "Basics", priority: "high", structural: true,
    when: ({ p }) => !p.photo || /ghost|static\.licdn\.com\/aero/.test(p.photo),
    evidence: () => "No public profile photo.",
    fix: "Add a clear, well-lit headshot with your face filling about 60% of the frame, and make it visible to the public.",
  },
  {
    id: "custom_url", area: "Basics", priority: "low", structural: true,
    when: ({ p }) => /\/in\/[^/]*-[0-9a-f]{6,}\/?$/i.test(p.url || "") || /\/in\/[^/]*\d{3,}/.test(p.url || ""),
    evidence: ({ p }) => `Profile URL has an auto-generated suffix: ${p.url}`,
    fix: "Set a custom URL (Edit public profile & URL), e.g. linkedin.com/in/firstname-lastname.",
  },
  {
    id: "location", area: "Basics", priority: "low", structural: true,
    when: ({ p }) => !p.location,
    evidence: () => "No location shown.",
    fix: "Add your location. Recruiters filter by it, and profiles without one drop out of location-filtered searches.",
  },
  {
    id: "education", area: "Basics", priority: "low", structural: true,
    when: ({ p }) => !p.sections?.education?.items?.length,
    evidence: () => "No education is visible.",
    fix: "Add education or certifications (and make them public). They add keywords and alumni search reach.",
  },
  {
    id: "completeness", area: "Basics", priority: "medium",
    when: ({ a }) => low(a, "completeness", 0.6),
    evidence: ({ a }) => `Completeness ${a.completeness.score.toFixed(1)}/3.`,
    fix: "Fill the remaining sections: Skills (pin your top 3), Featured, Certifications, Projects, Languages, and request 2–3 recommendations.",
  },

  // ── Visibility ─────────────────────────────────────────────────
  {
    id: "activity", area: "Visibility", priority: "medium",
    when: ({ a, p }) => lacks(a, "thought_leader", 0.4) || ((p.activity?.posts || 0) + (p.activity?.articles || 0) === 0 && p.source !== "pasted"),
    evidence: ({ p, a }) =>
      p.source === "pasted"
        ? `Model: ${pct(noul(a, "thought_leader"))} likely an active content creator.`
        : `${p.activity?.posts || 0} recent posts, ${p.activity?.articles || 0} articles visible.`,
    fix: "Post once or twice a week about your specialty (lessons, breakdowns, wins), and comment thoughtfully on posts from people in your target field.",
  },
  {
    id: "open_to_work", area: "Visibility", priority: "low",
    when: ({ a }) => noul(a, "open_to_work") != null && noul(a, "open_to_work") > 0.6,
    evidence: ({ a }) => `Model: ${pct(noul(a, "open_to_work"))} likely looking for work.`,
    fix: "Use Open to Work set to \"recruiters only\" (not the public frame) and list exact target titles and locations in it.",
  },
  {
    id: "recruiter_appeal", area: "Positioning", priority: "medium",
    when: ({ a }) => low(a, "recruiter_appeal", 0.55),
    evidence: ({ a }) => `Recruiter appeal ${a.recruiter_appeal.score.toFixed(1)}/3.`,
    fix: "Find 3 job posts you want. Copy their recurring keywords into your headline, About and Skills, and show proof for each one.",
  },
];

/** Returns recommendations sorted most-impactful first, plus the checks that passed. */
export function recommend(profile, answers) {
  const ctx = { p: profile, a: answers };
  const fired = [];
  const passed = [];
  for (const r of RULES) {
    if (r.structural && profile.source === "pasted") continue;
    let hit = false;
    try {
      hit = Boolean(r.when(ctx));
    } catch {
      continue; // answer missing (e.g. analysis stopped) — skip the rule
    }
    const item = { id: r.id, area: r.area, priority: r.priority, fix: r.fix };
    if (hit) fired.push({ ...item, evidence: r.evidence(ctx) });
    else passed.push(item);
  }
  // drop generic score-based advice when a more specific rule in the same area already fired
  const specific = new Set(fired.filter((f) => !["headline_quality", "experience_depth", "completeness", "recruiter_appeal"].includes(f.id)).map((f) => f.area));
  const items = fired
    .filter((f) => !(["headline_quality", "experience_depth"].includes(f.id) && specific.has(f.area)))
    .sort((x, y) => PRIORITY[y.priority] - PRIORITY[x.priority]);
  return { items, passed };
}
