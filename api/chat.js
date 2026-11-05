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
const TOP_K = 6; // how many FAQ entries are sent to the AI per question
const RATE_PER_MIN = 30; // max questions per minute from one network address

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

FAQ (the entries most relevant to this question):
${faq}`;



// ---- Smart FAQ search: send only the relevant entries to the AI ----
const STOP = new Set(("a an the is are was were be to of in on at for from with and or but if then so do does did how what when where which who why " +
  "can could should would i me my we you your it its this that these those there here please sir mam " +
  "hai hain ho hoga hota hoti kya kyu kyun kaise kab kahan kaun ka ki ke ko se mein par pe aur ya nahi nhi mujhe mera meri mere hum ap aap " +
  "kar karna kare karo krna kr raha rahi rha rhi h hi bhi tha thi toh").split(" "));
const SYN = {
  enroll: "register", enrol: "register", enrollment: "register", enrolment: "register", registration: "register",
  admission: "register", signup: "register", unlock: "lock", passwords: "password", paswd: "password", pwd: "password",
  certificat: "certificate", marks: "mark", grade: "mark", result: "mark",
};
const GREETING = /^(hi+|hello+|hey+|hii+|namaste|namaskar|good (morning|afternoon|evening)|thanks?|thank you|thx|ok(ay)?|bye|help)[\s!.?]*$/i;

function stem(w) {
  if (w.length > 5 && w.endsWith("ing")) w = w.slice(0, -3);
  else if (w.length > 4 && w.endsWith("ed")) w = w.slice(0, -2);
  else if (w.length > 3 && w.endsWith("s") && !w.endsWith("ss")) w = w.slice(0, -1);
  return SYN[w] || w;
}
function tokenize(text) {
  return (text.toLowerCase().match(/[\p{L}\p{N}]+/gu) || []).filter((w) => w.length > 1 && !STOP.has(w)).map(stem);
}

const parsedCache = { text: null, value: null };
function parseFaq(text) {
  if (parsedCache.text === text) return parsedCache.value;
  const header = [];
  const entries = [];
  let cur = null;
  let section = "";
  for (const line of text.split("\n")) {
    if (/^\s*===.*===\s*$/.test(line)) {
      section = line.replace(/=/g, "").trim();
      if (cur) { entries.push(cur); cur = null; }
      continue;
    }
    if (/^\s*Q:/.test(line)) {
      if (cur) entries.push(cur);
      cur = { section, lines: [line] };
      continue;
    }
    if (cur) cur.lines.push(line);
    else header.push(line);
  }
  if (cur) entries.push(cur);

  const df = {};
  for (const e of entries) {
    e.text = e.lines.join("\n").trim();
    e.q = e.lines[0].replace(/^\s*Q:\s*/, "").trim();
    e.a = e.lines.slice(1).join("\n").replace(/^\s*A:\s*/, "").trim();
    e.qset = new Set(tokenize(e.q));
    e.aset = new Set([...tokenize(e.a), ...tokenize(e.section)]);
    for (const t of new Set([...e.qset, ...e.aset])) df[t] = (df[t] || 0) + 1;
  }
  const idf = {};
  for (const t in df) idf[t] = Math.log(1 + entries.length / df[t]);
  const value = { full: text, header: header.join("\n").trim(), entries, idf };
  parsedCache.text = text;
  parsedCache.value = value;
  return value;
}

// Returns the FAQ text to send to the AI, plus the best matching entry (used if every AI is down)
function retrieve(question, faq) {
  const p = parseFaq(faq);
  if (p.entries.length < 3) return { text: faq, top: null, topScore: 0 }; // FAQ not in Q:/A: format, send everything
  if (GREETING.test(question.trim())) return { text: p.header, top: null, topScore: 0 };
  const qt = [...new Set(tokenize(question))];
  const scored = p.entries
    .map((e) => {
      let score = 0;
      for (const t of qt) {
        const w = p.idf[t];
        if (!w) continue;
        if (e.qset.has(t)) score += 3 * w;
        else if (e.aset.has(t)) score += w;
      }
      return { e, score };
    })
    .filter((x) => x.score > 0)
    .sort((a, b) => b.score - a.score);
  if (!scored.length) return { text: faq, top: null, topScore: 0 }; // nothing matched (typos, Hindi): send everything so nothing is missed
  const chosen = scored.slice(0, TOP_K).map((x) => x.e.text);
  return { text: p.header + "\n\n" + chosen.join("\n\n"), top: scored[0].e, topScore: scored[0].score };
}

// ---- Simple per-visitor rate limit (best effort, resets when the server restarts) ----
const hits = new Map();
function tooMany(ip) {
  const now = Date.now();
  const arr = (hits.get(ip) || []).filter((t) => now - t < 60000);
  arr.push(now);
  hits.set(ip, arr);
  if (hits.size > 5000) for (const [k, v] of hits) if (now - v[v.length - 1] > 60000) hits.delete(k);
  return arr.length > RATE_PER_MIN;
}

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
      if (text) return { text, complete: false };
    }
  }
  console.error("All models failed:", errors.join(" | ")); // visible in Vercel Logs
  return { text: "", complete: false };
}

// Used only when every AI is unavailable: show the closest FAQ entry, no AI needed
function noAiAnswer(faq, found) {
  const contact = (faq.match(/^\s*CONTACT:.*$/im) || [""])[0].trim();
  const help = contact || "Please raise a ticket in the app or portal, or contact the course in-charge.";
  if (found.top && found.topScore >= 5) {
    return `Our AI helper is busy right now. This is the closest answer in the FAQ:\n\n**${found.top.q}**\n${found.top.a}\n\n${help}`;
  }
  return `Busy right now. Please try again in a minute.\n\n${help}`;
}

async function handler(req, res) {
  if (req.method !== "POST") { res.statusCode = 405; return res.end("POST only"); }
  const question = String(req.body?.question || "").trim().slice(0, 300);
  if (!question) { res.statusCode = 400; return res.end("Empty question"); }

  const ip = (req.headers["x-forwarded-for"] || "").split(",")[0].trim() || req.socket?.remoteAddress || "unknown";
  if (tooMany(ip)) { res.statusCode = 429; return res.end("Too many questions at once. Please wait a minute and try again."); }

  const faq = await getFaq();
  const key = norm(question);

  res.setHeader("Content-Type", "text/plain; charset=utf-8");
  res.setHeader("Cache-Control", "no-cache, no-transform");
  res.setHeader("X-Accel-Buffering", "no");

  if (cache.has(key)) return res.end(cache.get(key));

  const found = retrieve(question, faq);
  const { text, complete } = await generateStream(systemPrompt(found.text), question, res);
  if (!text) return res.end(noAiAnswer(faq, found)); // nothing was written yet, so this is the whole reply
  if (complete) {
    if (cache.size > 500) cache.clear();
    cache.set(key, text);
  }
  res.end();
}

module.exports = handler;
module.exports.retrieve = retrieve; // exported for testing
