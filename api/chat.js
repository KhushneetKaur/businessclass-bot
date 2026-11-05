const fs = require("fs");
const path = require("path");

// ---- Settings (change in Vercel > Settings > Environment Variables, NOT in code) ----
// FAQ_DOC_ID    : Google Doc ID holding the FAQ (falls back to faq.txt)
// GEMINI_MODELS : optional, comma-separated, tried in order
// GROQ_MODELS   : optional, comma-separated, tried in order
const DOC_ID = process.env.FAQ_DOC_ID;
const GEMINI_MODELS = (process.env.GEMINI_MODELS || "gemini-flash-lite-latest,gemini-flash-latest").split(",").map((s) => s.trim()).filter(Boolean);
const GROQ_MODELS = (process.env.GROQ_MODELS || "openai/gpt-oss-120b,openai/gpt-oss-20b").split(",").map((s) => s.trim()).filter(Boolean);
const TIMEOUT_MS = 8000;
const REFRESH_MS = 2 * 60 * 1000;

const FALLBACK = fs.readFileSync(path.join(process.cwd(), "faq.txt"), "utf8");
let faqText = FALLBACK;
let lastLoad = 0;
const cache = new Map();
const norm = (q) => q.toLowerCase().replace(/[^\p{L}\p{N}\s]/gu, "").replace(/\s+/g, " ").trim();

async function getFaq() {
  if (!DOC_ID || Date.now() - lastLoad < REFRESH_MS) return faqText;
  lastLoad = Date.now();
  try {
    const r = await fetch(`https://docs.google.com/document/d/${DOC_ID}/export?format=txt`, { signal: AbortSignal.timeout(4000) });
    if (r.ok) {
      const t = (await r.text()).replace(/^\uFEFF/, "").trim();
      if (t.length > 200 && !t.includes("<html") && t !== faqText) {
        faqText = t;
        cache.clear();
      }
    }
  } catch (e) {
    /* keep last good copy */
  }
  return faqText;
}

const systemPrompt = (faq) => `You are the friendly help assistant for the "Business Class" (Entrepreneurship Mindset Course) at MRSPTU. Students and faculty ask you questions.

HOW TO ANSWER
- Use the FAQ below as your ONLY source of facts. Never invent dates, links, steps, marks or rules.
- Understand the meaning of the question even if it is worded differently, misspelled, or written in Hindi/Hinglish. Match it to the closest FAQ entries (for example "how do I enroll" relates to the registration entries). If several entries are relevant, combine them into one complete answer.
- Give complete, helpful answers: include every relevant step, link, date and condition from the FAQ. For processes, use short numbered steps. Do not cut useful details.
- If the FAQ marks something as tentative or possibly outdated, say so.
- Reply in the same language and style the person uses (English, Hindi or Hinglish).

GREETINGS AND SMALL TALK
- If the person says hello, hi, thanks or similar, reply warmly in one or two lines and ask what they need help with. Suggest a few examples such as login or OTP problems, locked milestones, registration, marks and results, or the app.
- If the message is very short or unclear, ask ONE short question to understand the problem.

WHEN YOU DON'T KNOW
- If the answer is not in the FAQ, do not guess. Say you are not sure, tell them to raise a ticket in the app or portal, and give the contact details from the FAQ.
- If the question is not about Business Class, politely say you can only help with Business Class questions.
- Never ask for passwords, OTPs or ID numbers.

FAQ:
${faq}`;

async function askGemini(model, system, question) {
  const r = await fetch(
    `https://generativelanguage.googleapis.com/v1beta/models/${model}:generateContent?key=${process.env.GEMINI_API_KEY}`,
    {
      method: "POST",
      signal: AbortSignal.timeout(TIMEOUT_MS),
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        systemInstruction: { parts: [{ text: system }] },
        contents: [{ role: "user", parts: [{ text: question }] }],
        generationConfig: { temperature: 0.2, maxOutputTokens: 1000 },
      }),
    }
  );
  if (!r.ok) throw new Error(`gemini ${model} ${r.status}`);
  const d = await r.json();
  const t = d.candidates?.[0]?.content?.parts?.map((p) => p.text).join("");
  if (!t) throw new Error(`gemini ${model} empty`);
  return t;
}

async function askGroq(model, system, question) {
  const body = {
    model,
    temperature: 0.2,
    max_tokens: 1000,
    messages: [{ role: "system", content: system }, { role: "user", content: question }],
  };
  if (model.includes("gpt-oss")) body.reasoning_effort = "low";
  const r = await fetch("https://api.groq.com/openai/v1/chat/completions", {
    method: "POST",
    signal: AbortSignal.timeout(TIMEOUT_MS),
    headers: { "Content-Type": "application/json", Authorization: `Bearer ${process.env.GROQ_API_KEY}` },
    body: JSON.stringify(body),
  });
  if (!r.ok) throw new Error(`groq ${model} ${r.status}`);
  const d = await r.json();
  const t = d.choices?.[0]?.message?.content;
  if (!t) throw new Error(`groq ${model} empty`);
  return t;
}

// Try every model in order until one works
async function generate(system, question) {
  const attempts = [
    ...GROQ_MODELS.map((m) => () => askGroq(m, system, question)),
    ...GEMINI_MODELS.map((m) => () => askGemini(m, system, question)),
  ];
  const errors = [];
  for (const run of attempts) {
    try {
      return await run();
    } catch (e) {
      errors.push(e.message);
    }
  }
  console.error("All models failed:", errors.join(" | ")); // visible in Vercel Logs
  throw new Error("all failed");
}

module.exports = async (req, res) => {
  if (req.method !== "POST") return res.status(405).json({ error: "POST only" });
  const question = String(req.body?.question || "").trim().slice(0, 300);
  if (!question) return res.status(400).json({ error: "Empty question" });

  const faq = await getFaq();
  const key = norm(question);
  if (cache.has(key)) return res.json({ answer: cache.get(key), cached: true });

  try {
    const answer = await generate(systemPrompt(faq), question);
    if (cache.size > 500) cache.clear();
    cache.set(key, answer);
    res.json({ answer });
  } catch (e) {
    res.status(503).json({ error: "Busy right now. Please try again in a minute or contact the course in-charge." });
  }
};
