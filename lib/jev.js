// JEV (TypeSafe "System One") rubric for decision models such as tev1, plus the compact
// profile text ("state") the model reads. Inference runs in the browser (public/browser-engine.js).
// tev1 has a hard 2050-token window and never truncates, so the state is kept compact.

const MAX_STATE_CHARS = Number(process.env.JEV_MAX_STATE_CHARS || 5200);

/** The analysis rubric. Grouped so the UI can render sections. */
export const QUESTIONS = {
  // ── classification ─────────────────────────────────────────────
  seniority: {
    group: "Profile",
    label: "Seniority",
    type: "choice",
    instructions: "What is this person's current career seniority level?",
    criteria: {
      student: "student, intern or recent graduate",
      junior: "junior, 0-2 years of professional experience",
      mid: "mid-level, 3-5 years of experience",
      senior: "senior individual contributor, 6+ years",
      staff_principal: "staff, principal or expert-level individual contributor",
      lead: "team lead or manager of a team",
      head_director: "head of a department, director or senior manager",
      executive: "VP, C-level, founder, partner or board member",
    },
  },
  experience_years: {
    group: "Profile",
    label: "Years of experience",
    type: "choice",
    instructions: "Roughly how many years of professional experience does this person have in total?",
    criteria: {
      under_2: "less than 2 years",
      "2_5": "2 to 5 years",
      "6_10": "6 to 10 years",
      "11_15": "11 to 15 years",
      "16_25": "16 to 25 years",
      over_25: "more than 25 years",
    },
    display: { under_2: "<2 yrs", "2_5": "2–5 yrs", "6_10": "6–10 yrs", "11_15": "11–15 yrs", "16_25": "16–25 yrs", over_25: "25+ yrs" },
  },
  function: {
    group: "Profile",
    label: "Primary function",
    type: "choice",
    instructions: "What is this person's primary professional function?",
    criteria: {
      software_engineering: "software development: frontend, backend, full-stack or mobile",
      devops_infra: "DevOps, cloud, infrastructure, SRE or platform engineering",
      data_ai: "data science, data engineering, machine learning, AI or analytics",
      security: "cybersecurity or information security",
      hardware_engineering: "hardware, electrical, mechanical or civil engineering",
      qa_testing: "quality assurance or software testing",
      product_management: "product management or product ownership",
      ux_product_design: "UX, UI, product or interaction design",
      brand_graphic_design: "brand, graphic, visual or motion design, art direction",
      content_creative: "writing, copywriting, video, photography or content creation",
      marketing: "marketing, growth, SEO, social media or communications",
      sales_bizdev: "sales, account management or business development",
      customer_success: "customer success, customer support or account services",
      project_program: "project, program or delivery management, agile coaching",
      operations: "operations, supply chain, logistics or procurement",
      finance_accounting: "finance, accounting, audit or investment",
      hr_people: "HR, recruiting, talent acquisition or people operations",
      legal: "law, legal counsel or compliance",
      consulting: "management, strategy or IT consulting",
      research_science: "research, science or R&D",
      teaching_academia: "teaching, training or academia",
      healthcare_clinical: "medicine, nursing, pharmacy or other clinical work",
      general_management: "general management, entrepreneurship or executive leadership",
      other: "none of the above",
    },
  },
  industry: {
    group: "Profile",
    label: "Industry",
    type: "choice",
    instructions: "Which industry is this person's current work mostly in?",
    criteria: {
      software_saas: "software, SaaS, cloud or internet products",
      it_services: "IT services, outsourcing or software consultancies",
      fintech_banking: "banking, fintech, payments or personal finance apps",
      insurance: "insurance or insurtech",
      investment: "investment, asset management, brokerage or venture capital",
      healthcare: "hospitals, clinics, healthtech or health insurance",
      biotech_pharma: "biotech, pharmaceuticals or medical devices",
      ecommerce_retail: "e-commerce, retail or marketplaces",
      consumer_goods: "consumer goods, food and beverage or fashion",
      education: "education, universities or edtech",
      agency_creative: "advertising, design, branding or creative agencies",
      consulting: "management or professional services consulting",
      government: "government, public sector or military",
      nonprofit: "nonprofit, NGO or philanthropy",
      energy: "energy, oil and gas, utilities or climate tech",
      manufacturing: "manufacturing, industrial or automotive",
      logistics: "logistics, transportation or mobility",
      real_estate: "real estate, construction or proptech",
      media_entertainment: "media, publishing, entertainment or music",
      gaming: "video games or gaming",
      telecom: "telecommunications",
      travel_hospitality: "travel, tourism, hospitality or restaurants",
      agriculture: "agriculture or agritech",
      legal_services: "law firms or legal services",
      other: "other or unclear",
    },
  },
  career_track: {
    group: "Profile",
    label: "Career track",
    type: "choice",
    instructions: "Which career track best describes this person right now?",
    criteria: {
      individual_contributor: "individual contributor doing hands-on work",
      people_manager: "manages a team of people",
      player_coach: "leads a team while still doing hands-on work",
      founder_owner: "founder, co-founder or business owner",
      freelancer_consultant: "freelancer, contractor or independent consultant",
      student_early: "student, intern or trainee",
      academic: "academic researcher or professor",
    },
  },
  company_type: {
    group: "Profile",
    label: "Company type",
    type: "choice",
    instructions: "What kind of organization does this person currently work for?",
    criteria: {
      startup: "early-stage startup",
      scaleup: "fast-growing scale-up or mid-size tech company",
      big_tech: "large technology company",
      enterprise: "large non-tech corporation or bank",
      agency_consultancy: "agency, consultancy or outsourcing firm",
      public_sector: "government or public institution",
      nonprofit: "nonprofit, NGO or foundation",
      academic: "university or research institute",
      self_employed: "self-employed or freelance",
      unclear: "unclear from the profile",
    },
  },
  region: {
    group: "Profile",
    label: "Region",
    type: "choice",
    instructions: "In which region is this person based?",
    criteria: {
      latin_america: "Latin America, including Brazil and Mexico",
      north_america: "United States or Canada",
      europe: "Europe, including the UK",
      middle_east_africa: "Middle East or Africa",
      south_asia: "India, Pakistan, Bangladesh or Sri Lanka",
      east_asia_pacific: "East Asia, Southeast Asia, Australia or New Zealand",
      unclear: "not stated",
    },
  },

  // ── quality scores (0..3) ──────────────────────────────────────
  headline_quality: {
    group: "Quality",
    label: "Headline",
    type: "score",
    instructions: "How strong is the headline at communicating role, specialty and value to a recruiter?",
    criteria: ["weak", "generic", "clear", "compelling"],
  },
  about_quality: {
    group: "Quality",
    label: "About section",
    type: "score",
    instructions: "How strong is the About/summary section (specific achievements, voice, clarity)? Missing counts as weak.",
    criteria: ["weak or missing", "thin", "solid", "excellent"],
  },
  experience_depth: {
    group: "Quality",
    label: "Experience detail",
    type: "score",
    instructions: "How well is the work experience documented with roles, dates and concrete outcomes?",
    criteria: ["missing", "titles only", "some detail", "rich with impact"],
  },
  completeness: {
    group: "Quality",
    label: "Completeness",
    type: "score",
    instructions: "How complete is this profile overall (headline, about, experience, education, skills, activity)?",
    criteria: ["sparse", "partial", "mostly complete", "complete"],
  },
  recruiter_appeal: {
    group: "Quality",
    label: "Recruiter appeal",
    type: "score",
    instructions: "How attractive would this profile look to a recruiter hiring for this person's field?",
    criteria: ["low", "moderate", "high", "outstanding"],
  },

  // ── yes/no signals (0..1) ──────────────────────────────────────
  leadership: { group: "Signals", label: "Leads people", type: "noul", instructions: "Does this person have people-leadership or management experience?" },
  founder: { group: "Signals", label: "Founder", type: "noul", instructions: "Has this person founded or co-founded a company or organization?" },
  technical: { group: "Signals", label: "Hands-on technical", type: "noul", instructions: "Is this person hands-on technical (writes code, builds systems or does quantitative work)?" },
  quantified_impact: { group: "Signals", label: "Quantified impact", type: "noul", instructions: "Does the profile state measurable results (numbers, percentages, scale, revenue)?" },
  open_to_work: { group: "Signals", label: "Looking for work", type: "noul", instructions: "Does the profile suggest the person is currently looking for a new job or open to work?" },
  short_tenures: { group: "Signals", label: "Frequent job changes", type: "noul", instructions: "Does this person change jobs frequently, with several roles shorter than 18 months?" },
  thought_leader: { group: "Signals", label: "Content creator", type: "noul", instructions: "Is this person an active content creator or thought leader (articles, posts, large following)?" },
  international: { group: "Signals", label: "International", type: "noul", instructions: "Has this person worked or studied in more than one country?" },

  // ── optimisation checks (0..1, 1 = already good) — feed lib/optimize.js ──
  opt_headline_keywords: { group: "Optimize", label: "Headline has searchable keywords", type: "noul", instructions: "Does the headline include specific skills, technologies or domain keywords a recruiter would search for, not just a job title?" },
  opt_headline_value: { group: "Optimize", label: "Headline states value", type: "noul", instructions: "Does the headline say what outcome or value the person delivers or who they help, beyond a title and employer?" },
  opt_niche: { group: "Optimize", label: "Clear specialty", type: "noul", instructions: "Is it immediately clear what specific niche or specialty this person focuses on?" },
  opt_about_hook: { group: "Optimize", label: "About opens with a hook", type: "noul", instructions: "Does the About section open with a strong, specific first sentence that makes the reader want to keep reading? Answer no if the About section is missing." },
  opt_about_proof: { group: "Optimize", label: "About shows proof", type: "noul", instructions: "Does the About section back up claims with concrete achievements, projects or results? Answer no if the About section is missing." },
  opt_about_cta: { group: "Optimize", label: "About has call to action", type: "noul", instructions: "Does the About section end with a call to action, such as how to contact the person or what opportunities they want? Answer no if missing." },
  opt_action_verbs: { group: "Optimize", label: "Experience describes actions", type: "noul", instructions: "Do the experience entries describe what the person did and achieved using action verbs, rather than only listing titles?" },
  opt_consistent_story: { group: "Optimize", label: "Consistent story", type: "noul", instructions: "Do the headline, About and experience tell one consistent career story pointing in the same direction?" },
};

/** Compact, model-friendly text representation of a parsed profile. */
export function profileToState(p, maxChars = MAX_STATE_CHARS) {
  if (p.rawText) {
    const head = [p.name && `Name: ${p.name}`, p.headline && `Headline: ${p.headline}`, p.location && `Location: ${p.location}`].filter(Boolean).join("\n");
    const label = p.source === "pdf" ? "LinkedIn profile (from PDF)" : "LinkedIn profile (pasted text)";
    return truncate(`${label}:\n${head ? head + "\n\n" : ""}${p.rawText}`, maxChars);
  }

  const lines = [];
  lines.push(`Name: ${p.name}`);
  lines.push(`Headline: ${p.headline || "(none)"}`);
  if (p.location) lines.push(`Location: ${p.location}`);
  if (p.followers || p.connections) lines.push(`Audience: ${[p.followers && p.followers + " followers", p.connections && p.connections + " connections"].filter(Boolean).join(", ")}`);
  lines.push(`About: ${p.about || "(missing)"}`);
  const act = p.activity || {};
  lines.push(`Public activity: ${act.articles || 0} articles, ${act.posts || 0} recent posts visible`);

  const order = ["experience", "education", ...Object.keys(p.sections || {}).filter((k) => k !== "experience" && k !== "education")];
  for (const key of order) {
    const sec = p.sections?.[key];
    if (!sec) continue;
    lines.push(`\n${sec.title}:`);
    for (const it of sec.items) {
      const head = [it.title, it.subtitle].filter(Boolean).join(" @ ");
      const tail = [it.dates, it.location].filter(Boolean).join(", ");
      lines.push(`- ${head}${tail ? ` (${tail})` : ""}${it.description ? `: ${it.description}` : ""}`);
    }
  }
  if (!p.sections?.experience) lines.push("\nExperience: (not public)");
  return truncate(lines.join("\n"), maxChars);
}

function truncate(s, n) {
  return s.length <= n ? s : s.slice(0, n - 20).replace(/\s+\S*$/, "") + "\n…(truncated)";
}
