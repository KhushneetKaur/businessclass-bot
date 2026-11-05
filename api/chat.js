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


// ---- Streaming helpers: each yields text pieces as the model writes them ----
async function* readSSE(r) {
  const reader = r.body.getReader();
  const dec = new TextDecoder();
  let buf = "";
  while (true) {
    const { done, value } = await reader.read();
    if (done) break;
    buf += dec.decode(value, { stream: true });
    const lines = buf.split("\n");
    buf = lines.pop();
    for (const line of lines) {
      if (line.startsWith("data:")) yield line.slice(5).trim();
    }
  }
}

// Abort the request only if the model hasn't started answering within TIMEOUT_MS
function withStartTimeout() {
  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort(), TIMEOUT_MS);
  return { signal: ctrl.signal, started: () => clearTimeout(timer), stop: () => clearTimeout(timer) };
}

async function* streamGemini(model, system, question) {
  const t = withStartTimeout();
  try {
    const r = await fetch(
      `https://generativelanguage.googleapis.com/v1beta/models/${model}:streamGenerateContent?alt=sse&key=${process.env.GEMINI_API_KEY}`,
      {
        method: "POST",
        signal: t.signal,
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          systemInstruction: { parts: [{ text: system }] },
          contents: [{ role: "user", parts: [{ text: question }] }],
          generationConfig: { temperature: 0.2, maxOutputTokens: 1000 },
        }),
      }
    );
    if (!r.ok) throw new Error(`gemini ${model} ${r.status}`);
    for await (const data of readSSE(r)) {
      let j;
      try { j = JSON.parse(data); } catch { continue; }
      const parts = j.candidates?.[0]?.content?.parts || [];
      const text = parts.filter((p) => !p.thought).map((p) => p.text || "").join("");
      if (text) { t.started(); yield text; }
    }
  } finally {
    t.stop();
  }
}

async function* streamGroq(model, system, question) {
  const t = withStartTimeout();
  try {
    const body = {
      model,
      stream: true,
      temperature: 0.2,
      max_tokens: 1000,
      messages: [{ role: "system", content: system }, { role: "user", content: question }],
    };
    if (model.includes("gpt-oss")) body.reasoning_effort = "low";
    const r = await fetch("https://api.groq.com/openai/v1/chat/completions", {
      method: "POST",
      signal: t.signal,
      headers: { "Content-Type": "application/json", Authorization: `Bearer ${process.env.GROQ_API_KEY}` },
      body: JSON.stringify(body),
    });
    if (!r.ok) throw new Error(`groq ${model} ${r.status}`);
    for await (const data of readSSE(r)) {
      if (data === "[DONE]") return;
      let j;
      try { j = JSON.parse(data); } catch { continue; }
      const text = j.choices?.[0]?.delta?.content;
      if (text) { t.started(); yield text; }
    }
  } finally {
    t.stop();
  }
}

// Tries each model in order. Sends text to the student as it arrives.
async function generateStream(system, question, res) {
  const attempts = [
    ...GROQ_MODELS.map((m) => () => streamGroq(m, system, question)),
    ...GEMINI_MODELS.map((m) => () => streamGemini(m, system, question)),
  ];
  const errors = [];
  for (const run of attempts) {
    let text = "";
    try {
      for await (const piece of run()) {
        text += piece;
        res.write(piece);
      }
      if (text) return { text, complete: true };
      errors.push("empty answer");
    } catch (e) {
      errors.push(e.message);
      if (text) return { text, complete: false }; // failed midway: keep what was already sent
    }
  }
  console.error("All models failed:", errors.join(" | ")); // visible in Vercel Logs
  return { text: "", complete: false };
}

module.exports = async (req, res) => {
  if (req.method !== "POST") { res.statusCode = 405; return res.end("POST only"); }
  const question = String(req.body?.question || "").trim().slice(0, 300);
  if (!question) { res.statusCode = 400; return res.end("Empty question"); }

  const faq = await getFaq();
  const key = norm(question);

  res.setHeader("Content-Type", "text/plain; charset=utf-8");
  res.setHeader("Cache-Control", "no-cache, no-transform");
  res.setHeader("X-Accel-Buffering", "no");

  if (cache.has(key)) return res.end(cache.get(key));

  const { text, complete } = await generateStream(systemPrompt(faq), question, res);
  if (!text) {
    res.statusCode = 503;
    return res.end("Busy right now. Please try again in a minute or contact the course in-charge.");
  }
  if (complete) {
    if (cache.size > 500) cache.clear();
    cache.set(key, text);
  }
  res.end();
};
