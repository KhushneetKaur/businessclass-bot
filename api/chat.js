const FAQ = require("../faq");

const SYSTEM = `You are the helpful assistant for the "Business Class" app course at MRSPTU Bathinda.
Answer ONLY using the FAQ below. Keep answers short, clear and friendly. Reply in the language the student writes in (English, Hindi or Hinglish).
If the answer is not in the FAQ, do not guess. Say: "I'm not sure about this. Please contact the course in-charge:" and give the CONTACT details.
Never ask for or store personal data like passwords or ID numbers.

FAQ:
${FAQ}`;

// Simple in-memory cache (lives while the serverless instance is warm)
const cache = new Map();
const norm = (q) => q.toLowerCase().replace(/[^\p{L}\p{N}\s]/gu, "").replace(/\s+/g, " ").trim();

async function askGemini(question) {
  const r = await fetch(
    `https://generativelanguage.googleapis.com/v1beta/models/gemini-2.5-flash:generateContent?key=${process.env.GEMINI_API_KEY}`,
    {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        systemInstruction: { parts: [{ text: SYSTEM }] },
        contents: [{ role: "user", parts: [{ text: question }] }],
        generationConfig: { temperature: 0.2, maxOutputTokens: 800, thinkingConfig: {thinkingBudget: 0} },
      }),
    }
  );
  if (!r.ok) throw new Error("gemini " + r.status);
  const d = await r.json();
  const t = d.candidates?.[0]?.content?.parts?.map((p) => p.text).join("");
  if (!t) throw new Error("gemini empty");
  return t;
}

async function askGroq(question) {
  const r = await fetch("https://api.groq.com/openai/v1/chat/completions", {
    method: "POST",
    headers: { "Content-Type": "application/json", Authorization: `Bearer ${process.env.GROQ_API_KEY}` },
    body: JSON.stringify({
      model: "llama-3.3-70b-versatile",
      temperature: 0.2,
      max_tokens: 400,
      messages: [{ role: "system", content: SYSTEM }, { role: "user", content: question }],
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

  const key = norm(question);
  if (cache.has(key)) return res.json({ answer: cache.get(key), cached: true });

  let answer;
  try {
    answer = await askGemini(question);
  } catch (e1) {
    try {
      answer = await askGroq(question);
    } catch (e2) {
      return res.status(503).json({ error: "DEBUG" + e1.message + " | " + e2.message });
    }
  }
  if (cache.size > 500) cache.clear();
  cache.set(key, answer);
  res.json({ answer });
};
