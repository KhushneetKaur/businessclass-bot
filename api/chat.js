const fs = require("fs");
const path = require("path");

// FAQ comes from Sir's Google Doc (set FAQ_DOC_ID in Vercel). 
const DOC_ID = process.env.FAQ_DOC_ID;
const FALLBACK = fs.readFileSync(path.join(process.cwd(), "faq.txt"), "utf8");
const REFRESH_MS = 2 * 60 * 1000; // re-read the doc every 2 minutes

let faqText = FALLBACK;
let lastLoad = 0;
const cache = new Map();
const norm = (q) => q.toLowerCase().replace(/[^\p{L}\p{N}\s]/gu, "").replace(/\s+/g, " ").trim();

async function getFaq() {
  if (!DOC_ID || Date.now() - lastLoad < REFRESH_MS) return faqText;
  lastLoad = Date.now();
  try {
    const r = await fetch(`https://docs.google.com/document/d/${DOC_ID}/export?format=txt`, { signal : AbortSignal.timeout (4000) });
    if (r.ok) {
      const t = (await r.text()).replace(/^\uFEFF/, "").trim();
      if (t.length > 200 &&  !t.includes ("<html") && t!== faqText) {
        faqText = t;
        cache.clear(); // FAQ changed, so old cached answers may be stale
      }
    }
  } catch (e) {
    
  }
  return faqText;
}

const systemPrompt = (faq) => `You are the helpful assistant for the "Business Class" app course at MRSPTU.
Answer ONLY using the FAQ below. Keep answers short, clear and friendly. Reply in the language the student writes in (English, Hindi or Hinglish).
If the answer is not in the FAQ, do not guess. Say: "I'm not sure about this. Please raise a ticket in the app or portal, or contact the course in-charge:" and give the contact details from the FAQ.
Never ask for or store personal data like passwords or ID numbers.

FAQ:
${faq}`;

async function askGemini(system, question) {
  const r = await fetch(
    `https://generativelanguage.googleapis.com/v1beta/models/gemini-3.5-flash-lite:generateContent?key=${process.env.GEMINI_API_KEY}`,
    {
      method: "POST",
      signal: AbortSignal.timeout (8000),
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        systemInstruction: { parts: [{ text: system }] },
        contents: [{ role: "user", parts: [{ text: question }] }],
        generationConfig: { temperature: 0.2, maxOutputTokens: 1000 },
      }),
    }
  );
  if (!r.ok) throw new Error("gemini " + r.status);
  const d = await r.json();
  const t = d.candidates?.[0]?.content?.parts?.map((p) => p.text).join("");
  if (!t) throw new Error("gemini empty");
  return t;
}

async function askGroq(system, question) {
  const r = await fetch("https://api.groq.com/openai/v1/chat/completions", {
    method: "POST",
    signal: AbortSignal.timeout (8000),
    headers: { "Content-Type": "application/json", Authorization: `Bearer ${process.env.GROQ_API_KEY}` },
    body: JSON.stringify({
      model: "openai/gpt-oss-120b",
      temperature: 0.2,
      max_tokens: 1000,
      reasoning_effort: "low",
      messages: [{ role: "system", content: system }, { role: "user", content: question }],
    }),
  });
  if (!r.ok) throw new Error("groq " + r.status);
  const d = await r.json();
  return d.choices[0].message.content;
}

module.exports = async (req, res) => {
  if (req.method !== "POST") return res.status(405).json({ error: "POST only" });
  const question = String(req.body?.question || "").trim().slice(0, 300);
  if (!question) return res.status(400).json({ error: "Empty question" });

  const faq = await getFaq();
  const key = norm(question);
  if (cache.has(key)) return res.json({ answer: cache.get(key), cached: true });

  const system = systemPrompt(faq);
  let answer;
  try {
    answer = await askGemini(system, question);
  } catch (e1) {
    try {
      answer = await askGroq(system, question);
    } catch (e2) {
      return res.status(503).json({ error: "Busy right now. Please try again in a minute or contact the course in-charge." });
    }
  }
  if (cache.size > 500) cache.clear();
  cache.set(key, answer);
  res.json({ answer });
};
