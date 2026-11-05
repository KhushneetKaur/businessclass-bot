# Business Class Help Bot

A free FAQ chatbot for the **Business Class (Entrepreneurship Mindset Course)** at MRSPTU. Students open a web link, ask a question in English, Hindi or Hinglish, and get an answer taken only from the official FAQ. If the bot doesn't know, it tells them to raise a ticket and shows the contact details.

Built by Khushneet Kaur (MRSPTU).

## How it works

1. The student types a question on the chat page (`public/index.html`).
2. The page sends it to the backend (`api/chat.js`), a serverless function on Vercel.
3. The backend reads the FAQ from a **Google Doc** (re-read every 2 minutes; `faq.txt` is the backup copy).
4. It picks the most relevant FAQ entries for the question (keyword search, so fewer tokens are used).
5. It asks an AI model to answer using only those entries. Models are tried in order until one works: Groq first, then Gemini.
6. The answer streams back to the page word by word.

Extras built in:
- **Cache:** repeated questions are answered instantly, with no AI call.
- **Rate limit:** 30 questions per minute from one network address.
- **No-AI fallback:** if every AI provider is down or over its free limit, the bot shows the closest FAQ answer plus the contact line.
- **Greetings:** "hello", "thanks" and similar get a friendly reply asking how it can help.

## Files

| File | Purpose |
|---|---|
| `api/chat.js` | Backend: FAQ search, AI calls, fallback, caching, rate limit |
| `public/index.html` | The chat page students see |
| `faq.txt` | Backup copy of the FAQ. **Must exist**, the backend reads it on start-up |
| `vercel.json` | Makes Vercel include `faq.txt` with the backend |
| `package.json` | Minimal project file |


## Updating the FAQ (for Sir)

The live FAQ is the **Google Doc**. Edit it like a normal document. Changes reach the bot in about 2 to 3 minutes.

Keep this format:

```
CONTACT: Course coordinator name. Helpline/email. Raise a ticket in the app first.

=== SECTION NAME ===

Q: The question?
A: The answer.
```

Tips:
- Put the `CONTACT:` line at the very top. The bot shows it when it doesn't know an answer.
- Leave a blank line between questions.
- When a status changes (last date, known issue fixed), update the answer, or the bot will keep repeating the old one.
- Share the Doc as **Anyone with the link: Viewer**, and keep **Edit** access only for Sir. Don't put private details in it, since anyone with the link can read it.
- Copy the new text into `faq.txt` on GitHub now and then, so the backup stays current.

## Setup from scratch

1. Put this folder in a GitHub repository.
2. Get free API keys: Gemini at aistudio.google.com/apikey and Groq at console.groq.com/keys.
3. Import the repo in Vercel (framework preset: **Other**, build settings empty).
4. Add the environment variables below in Vercel → Settings → Environment Variables.
5. Deploy (or Redeploy, since variables only apply to new deployments).

### Environment variables

| Name | Required | What it is |
|---|---|---|
| `GEMINI_API_KEY` | Yes | Google AI Studio key |
| `GROQ_API_KEY` | Yes | Groq key |
| `FAQ_DOC_ID` | Recommended | The long ID in the Doc link: `docs.google.com/document/d/THIS_PART/edit` |
| `GROQ_MODELS` | No | Comma-separated model names, tried in order. Default: `openai/gpt-oss-120b,openai/gpt-oss-20b` |
| `GEMINI_MODELS` | No | Comma-separated model names, tried in order. Default: `gemini-flash-lite-latest,gemini-flash-latest` |

Never put API keys in the code or in GitHub. Keep them only in Vercel.

### Settings in `api/chat.js`

| Setting | Default | Meaning |
|---|---|---|
| `TOP_K` | 6 | FAQ entries sent to the AI per question |
| `RATE_PER_MIN` | 30 | Questions per minute per network address |
| `TIMEOUT_MS` | 8000 | Wait for an AI model to start answering before trying the next one |
| `REFRESH_MS` | 2 minutes | How often the Google Doc is re-read |

## Troubleshooting

First step for any problem: Vercel → your project → **Logs**, ask a question on the site, and read the red line for `/api/chat`.

| Symptom | Likely cause | Fix |
|---|---|---|
| Every question says "Busy right now" | A model name was retired (log shows `404`), or a key is wrong (`401`/`403`) | Update `GROQ_MODELS` / `GEMINI_MODELS` in Vercel (check the current names on Groq's and Google's model pages), or fix the key. Then redeploy |
| Log shows `429` | Free limit reached | Wait, or the no-AI fallback will answer. If it happens daily, consider paid billing on one provider |
| Bot gives old answers | Doc not shared, wrong `FAQ_DOC_ID`, or the cache | Check the Doc is "Anyone with the link: Viewer". Wait 3 minutes |
| Bot ignores Doc changes and uses old text | The Doc can't be read, so it's using `faq.txt` | Check sharing and `FAQ_DOC_ID`; update `faq.txt` as a stop-gap |
| Page says "No connection" | Server error, or the old page is cached | Hard-refresh. Check the Logs |
| Answers show `**` symbols | Old `index.html` | Use the current `public/index.html` |
| Environment variable changes have no effect | Not redeployed | Vercel → Deployments → ⋯ → Redeploy |

Free AI model names get retired every few months. If the bot suddenly fails, the model names are the first thing to check.

## Limits to know about

- It runs on free plans (Vercel, Groq, Gemini). Free limits can change, and heavy use at busy times (results, deadlines) may reach them.
- The cache and rate limit live in server memory and reset when Vercel restarts the function. That's fine for this use.
- The bot is only as accurate as the FAQ. It is told not to guess, but a wrong or outdated FAQ entry means a wrong answer.

## Using it inside the app

- **Easiest:** add a "Help" button in the Business Class app that opens the bot link.
- **If the team has the app code:** load the same link in a WebView screen.
