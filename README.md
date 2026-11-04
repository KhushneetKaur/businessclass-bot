# Business Class Help Bot (free setup)

1. Get free keys: Gemini -> aistudio.google.com/apikey ; Groq -> console.groq.com/keys
2. Edit faq.js with the real answers (Sir's contact details at the top).
3. Push this folder to a GitHub repo, then import it on vercel.com (free).
4. In Vercel > Settings > Environment Variables add GEMINI_API_KEY and GROQ_API_KEY.
5. Deploy. Share the yourproject.vercel.app link in the WhatsApp groups.

Test locally: npm i -g vercel, then `vercel dev` (put keys in a .env file).
In-app: add a Help button that opens the link, or a WebView screen loading it.
