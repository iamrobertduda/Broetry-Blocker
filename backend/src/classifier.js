import { choice, noul, TypeSafeClient } from "@typesafe-ai/sdk";

/** Labels the extension knows how to roast. Keep in sync with extension/src/roasts.js. */
export const FLAVORS = {
  broetry:
    "Broetry: one short sentence per line, dramatic line breaks, building up to a trite business lesson.",
  ai_generated:
    "Reads like unedited chatbot output: generic phrasing, em-dashes everywhere, 'Here's the thing', 'Let that sink in', 'game-changer', neat lists of three, emoji bullet points.",
  humblebrag:
    "Humblebrag: 'I'm humbled/thrilled to announce', bragging about a promotion, award or funding round dressed up as gratitude.",
  engagement_bait:
    "Engagement bait: 'Agree?', 'Thoughts?', 'Comment YES', 'Repost if you agree', 'Follow me for more', polls with no point.",
  fake_story:
    "An implausible parable: a janitor, taxi driver, intern, child or stranger taught the author a profound business lesson.",
  hustle_guru:
    "Hustle or thought-leadership platitudes: 5am routines, 'leaders eat last', hot takes about AI replacing everyone, with no concrete substance.",
  genuine:
    "None of the above: a specific, substantive post written by a real person (news, a concrete project, a job posting, a real question).",
};

const SLOP_QUESTION = noul(
  {
    task: "Decide whether this LinkedIn post is slop.",
    slop_means: [
      "text that looks mass-produced by an AI writing assistant with little human editing",
      "formulaic 'broetry' with one sentence per line to fake depth",
      "engagement bait written to game the feed algorithm",
      "empty motivational or thought-leadership content with no concrete information",
      "made-up inspirational stories and humblebrags",
    ],
    not_slop_means: [
      "specific news, results, links or data",
      "a concrete job posting, event or product announcement written plainly",
      "a genuine question, opinion or experience with real details",
    ],
  },
  {
    true: "The post is slop.",
    false: "The post is a genuine, substantive post.",
  },
);

const FLAVOR_QUESTION = choice("Which cliché describes this LinkedIn post best?", FLAVORS);

/** Uses TypeSafe's System One API (the Jev model). */
export function createJevClassifier({ apiKey, baseURL, model, timeoutMs, fetch }) {
  const client = new TypeSafeClient({
    apiKey,
    fetch,
    baseURL,
    defaultModel: model,
    timeout: timeoutMs,
    retry: { maxRetries: 1 },
  });

  return {
    name: "jev",
    async classify(text) {
      const { answers } = await client.systemOne({
        state: { platform: "LinkedIn", post: text },
        questions: { slop: SLOP_QUESTION, flavor: FLAVOR_QUESTION },
      });
      return {
        slop: answers.slop.noul,
        flavor: answers.flavor.choice,
        flavorConfidence: answers.flavor.confidence,
      };
    },
  };
}

const BAIT_PATTERNS = [
  /\bagree\s*\?/i,
  /\bthoughts\s*\?/i,
  /\bcomment\s+["“']?\w+["”']?\s+(below|if)\b/i,
  /\brepost\b/i,
  /\bfollow me\b/i,
  /♻️/u,
  /\bstimmst du zu\b/i,
  /\bwas meint ihr\b/i,
];
const HUMBLEBRAG_PATTERNS = [
  /\b(humbled|thrilled|honou?red|excited) to (announce|share)\b/i,
  /\bfreue mich(,)? (euch|ihnen)? ?(mitzuteilen|bekannt)/i,
  /\bstolz\b/i,
];
const AI_PATTERNS = [
  /here'?s the thing/i,
  /let that sink in/i,
  /game[- ]changer/i,
  /\bdelve\b/i,
  /\bunlock(ing)? (your|the) (potential|power)\b/i,
  /in today'?s (fast-paced|ever-changing|rapidly)/i,
  /\bnot just\b.{0,40}\bit'?s\b/i,
  /—/u,
];
const STORY_PATTERNS = [
  /\b(janitor|taxi driver|uber driver|cleaning lady|my (son|daughter|kid)|an intern|a stranger|homeless)\b.{0,120}\b(taught|told|asked) me\b/is,
  /\bputzfrau|taxifahrer|praktikant\b.{0,120}\b(hat mir|fragte mich)\b/is,
];
const HUSTLE_PATTERNS = [
  /\b(4|5)\s?(am|a\.m\.|uhr)\b/i,
  /\bleaders?\b.{0,40}\b(eat last|don'?t|never|always)\b/i,
  /\bhustle\b/i,
  /\bmindset\b/i,
];

function hits(text, patterns) {
  return patterns.reduce((n, re) => n + (re.test(text) ? 1 : 0), 0);
}

/**
 * Cheap stand-in used when no TypeSafe key is configured (local development,
 * tests, or as an emergency fallback). Not meant to be good, just plausible.
 */
export function createHeuristicClassifier() {
  return {
    name: "heuristic",
    async classify(text) {
      const lines = text.split(/\n+/).map((l) => l.trim()).filter(Boolean);
      const shortLines = lines.filter((l) => l.length < 70).length;
      const broetryRatio = lines.length >= 5 ? shortLines / lines.length : 0;
      const emojiBullets = (text.match(/^\s*(\p{Extended_Pictographic}|[✅👉➡️🔹•→])/gmu) ?? []).length;
      const hashtags = (text.match(/#\w+/g) ?? []).length;

      const scores = {
        broetry: broetryRatio > 0.7 ? 2 + broetryRatio : 0,
        engagement_bait: hits(text, BAIT_PATTERNS) * 1.5,
        humblebrag: hits(text, HUMBLEBRAG_PATTERNS) * 1.5,
        ai_generated: hits(text, AI_PATTERNS) + (emojiBullets >= 3 ? 1.5 : 0),
        fake_story: hits(text, STORY_PATTERNS) * 2.5,
        hustle_guru: hits(text, HUSTLE_PATTERNS),
      };
      let flavor = "genuine";
      let best = 0;
      for (const [label, s] of Object.entries(scores)) {
        if (s > best) {
          best = s;
          flavor = label;
        }
      }
      const total = Object.values(scores).reduce((a, b) => a + b, 0) + (hashtags > 5 ? 0.5 : 0);
      const slop = 1 / (1 + Math.exp(-(total - 2)));
      return {
        slop: Math.round(slop * 1000) / 1000,
        flavor: slop >= 0.5 ? flavor : "genuine",
        flavorConfidence: best > 0 ? Math.min(1, best / 4) : 0.5,
      };
    },
  };
}

export function createClassifier(config) {
  if (config.classifier === "jev") {
    return createJevClassifier({
      apiKey: config.typesafeApiKey,
      baseURL: config.typesafeBaseURL,
      model: config.typesafeModel,
      timeoutMs: config.typesafeTimeoutMs,
    });
  }
  return createHeuristicClassifier();
}
