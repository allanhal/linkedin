// Fetches a LinkedIn public (guest) profile page and parses it into plain JSON.
// Only the logged-out public view is read — no cookies, no login, no private data.
import * as cheerio from "cheerio";

const UA =
  "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/129.0 Safari/537.36";

export class FetchError extends Error {
  constructor(message, status = 502, code = "fetch_failed") {
    super(message);
    this.status = status;
    this.code = code;
  }
}

/** Accepts a full URL, a "linkedin.com/in/x" fragment or a bare slug. */
export function normaliseProfileUrl(input) {
  const raw = String(input || "").trim();
  if (!raw) throw new FetchError("Enter a LinkedIn profile URL or handle", 400, "bad_input");
  if (/^[\w\-%.]+$/.test(raw) && !raw.includes(".")) return `https://www.linkedin.com/in/${raw}/`;
  let u;
  try {
    u = new URL(/^https?:\/\//i.test(raw) ? raw : `https://${raw}`);
  } catch {
    throw new FetchError("That doesn't look like a URL", 400, "bad_input");
  }
  if (!/(^|\.)linkedin\.com$/i.test(u.hostname)) throw new FetchError("Only linkedin.com profile URLs are supported", 400, "bad_input");
  const m = u.pathname.match(/^\/in\/([^/?#]+)/i);
  if (!m) throw new FetchError("Use a personal profile URL like linkedin.com/in/<handle>", 400, "bad_input");
  return `https://www.linkedin.com/in/${m[1]}/`;
}

export async function fetchProfile(input) {
  const url = normaliseProfileUrl(input);
  let res;
  try {
    res = await fetch(url, {
      redirect: "follow",
      signal: AbortSignal.timeout(20_000),
      headers: {
        "user-agent": UA,
        accept: "text/html,application/xhtml+xml",
        "accept-language": "en-US,en;q=0.9",
      },
    });
  } catch (e) {
    throw new FetchError(`Could not reach LinkedIn: ${e.message}`);
  }
  if (res.status === 999 || res.status === 429)
    throw new FetchError("LinkedIn rate-limited this request (HTTP " + res.status + "). Wait a bit or paste the profile text instead.", 429, "rate_limited");
  if (res.status === 404) throw new FetchError("Profile not found or not public", 404, "not_found");
  if (!res.ok) throw new FetchError(`LinkedIn returned HTTP ${res.status}`, 502);
  if (/authwall|\/login|checkpoint/.test(res.url))
    throw new FetchError("LinkedIn showed a login wall for this profile. Paste the profile text instead.", 403, "authwall");

  const html = await res.text();
  const profile = parseProfile(html, url);
  if (!profile.name) throw new FetchError("Could not find a public profile on that page (login wall or private profile). Paste the text instead.", 422, "unparseable");
  return profile;
}

const clean = (s) => (s || "").replace(/\s+/g, " ").trim();

export function parseProfile(html, url) {
  const $ = cheerio.load(html);
  const meta = (k) => $(`meta[property="${k}"], meta[name="${k}"]`).attr("content") || "";

  const name = clean($(".top-card-layout__title").first().text()) || clean(meta("og:title").split(" - ")[0]);
  const headline = clean($(".top-card-layout__headline").first().text());
  const location = clean($(".top-card-layout__first-subline span").first().text());
  const photo =
    $(".top-card__profile-image").attr("data-delayed-url") || $(".top-card__profile-image").attr("src") || meta("og:image") || "";

  const subline = clean($(".top-card-layout__first-subline").text() + " " + $(".top-card-layout__second-subline").text());
  const followers = (subline.match(/([\d.,]+[KM]?\+?) followers/i) || clean($('[data-section="posts"] h3').first().text()).match(/([\d.,]+[KM]?\+?) followers/i) || [])[1] || "";
  const connections = (subline.match(/([\d.,]+\+?) connections/i) || meta("og:description").match(/([\d.,]+\+?) connections/i) || [])[1] || "";

  const about = clean($('[data-section="summary"] .core-section-container__content').first().text()) ||
    clean($('[data-section="summary"] p').first().text());

  // Generic list sections (experience, education, certifications, projects, languages, volunteering, …)
  const sections = {};
  $("section.core-section-container[data-section]").each((_, el) => {
    const sec = $(el);
    const key = sec.attr("data-section");
    if (["summary", "posts", "articles", "recommendations", "websites"].includes(key)) return;
    const title = clean(sec.find(".core-section-container__title").first().text()) || key;
    const items = [];
    sec.find(".core-section-container__content > ul > li, .core-section-container__content li.profile-section-card").each((_, li) => {
      const $li = $(li);
      const item = {
        title: clean($li.find("h3").first().text()),
        subtitle: clean($li.find("h4").first().text()).replace(/^[-–·\s]+$/, ""),
        dates: clean($li.find(".date-range").first().text()).replace(/(\S)\s+(\d+ (?:yrs?|years?|mos?|months?)\b)/, "$1 · $2"),
        location: clean($li.find(".experience-item__location, .experience-group-position__location").first().text()),
        description: clean($li.find(".show-more-less-text__text--less, .show-more-less-text__text--more, [class*='description']").first().text()),
      };
      if (item.title || item.subtitle) items.push(item);
    });
    // de-dupe (nested li selectors can match the same card twice)
    const seen = new Set();
    const unique = items.filter((i) => {
      const k = i.title + "|" + i.subtitle + "|" + i.dates;
      return seen.has(k) ? false : seen.add(k);
    });
    const k = normaliseKey(key, title);
    if (unique.length) sections[k] = { title: TITLES[k] || title, items: unique };
  });

  const articles = $('[data-section="articles"] li, [data-section="summary"] .base-card').length;
  const posts = $('[data-section="posts"] li.base-card, [data-section="posts"] .base-main-card').length;

  return {
    url,
    name,
    headline,
    location,
    photo,
    followers,
    connections,
    about,
    sections,
    activity: { articles, posts },
    fetchedAt: new Date().toISOString(),
    source: "linkedin-public",
  };
}

const TITLES = { experience: "Experience", education: "Education" };

function normaliseKey(key, title) {
  const t = title.toLowerCase();
  if (key === "experience" || t.startsWith("experience")) return "experience";
  if (key === "education" || key === "educationsDetails" || t.startsWith("education")) return "education";
  return t.replace(/[^a-z0-9]+/g, "_").replace(/^_|_$/g, "") || key;
}

/** Plain-text fallback: the user pasted their profile (or a PDF export's text). */
export function profileFromText(text) {
  const body = String(text || "").trim();
  if (body.length < 40) throw new FetchError("Paste at least a few lines of profile text", 400, "bad_input");
  const lines = body.split(/\n+/).map(clean).filter(Boolean);
  return {
    url: "",
    name: lines[0]?.slice(0, 80) || "Pasted profile",
    headline: lines[1]?.slice(0, 200) || "",
    location: "",
    photo: "",
    followers: "",
    connections: "",
    about: "",
    sections: {},
    rawText: body,
    activity: { articles: 0, posts: 0 },
    fetchedAt: new Date().toISOString(),
    source: "pasted",
  };
}
