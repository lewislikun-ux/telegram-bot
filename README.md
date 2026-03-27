# telegram-bot
Phase 1 Telegram Personal Ops Bot
This is a browser-first build for your Phase 1 Telegram bot.
What it can do
Save notes
Save tasks
Mark tasks done
Save reminders
Save recurring admin items
Show due items
Search your saved items
Generate a weekly summary on demand
Commands
`/start`
`/help`
`/note your text`
`/task your text`
`/done keyword`
`/remind YYYY-MM-DD HH:MM | message`
`/adminadd title | YYYY-MM-DD | none|monthly|yearly | 30,7,1`
`/due`
`/search keyword`
`/weekly`
---
Browser-only setup steps
1) Create the Telegram bot
Open Telegram.
Search for BotFather.
Send `/newbot`.
Follow the prompts.
Copy the bot token.
2) Create the Supabase project
Open Supabase.
Create a new project.
Wait until the project is ready.
3) Run the SQL in Supabase
In Supabase, open SQL Editor.
Click New Query.
Copy everything from `supabase.sql` and paste it in.
Click Run.
4) Get your Supabase project values
In Supabase:
Go to Project Settings.
Open API.
Copy:
`Project URL`
`anon public` key
5) Create a GitHub repository in the browser
Open GitHub.
Create a new repository.
Upload these files:
`index.js`
`package.json`
`render.yaml`
Create a file named `.env.example` and paste in the example values.
Create a file named `README.md` and paste this README in if you want it saved there.
Important: do not upload your real `.env` file with real secrets.
6) Deploy to Render
Open Render.
Click New +.
Choose Web Service.
Connect your GitHub repo.
Render should detect `render.yaml` automatically.
Create the service.
7) Add the environment variables in Render
In Render, open your service and add these environment variables:
`TELEGRAM_BOT_TOKEN`
`WEBHOOK_URL`
`SUPABASE_URL`
`SUPABASE_ANON_KEY`
`PORT` = `10000`
For `WEBHOOK_URL`, use your Render service URL, for example:
`https://telegram-phase1-personal-ops-bot.onrender.com`
8) Redeploy once after adding the variables
After saving the environment variables, manually redeploy the service once.
When it starts, it will register the Telegram webhook automatically.
9) Test in Telegram
Open your bot and send:
`/start`
`/help`
`/note buy new tyres soon`
`/task renew insurance`
`/remind 2026-04-02 09:00 | renew road tax`
`/adminadd road tax | 2026-04-15 | yearly | 30,7,1`
`/due`
`/weekly`
---
Important limitation
This Phase 1 build is intentionally simple and pull-based.
It is good for on-demand use.
It does not include a reliable always-on scheduler for exact real-time reminders on the free Render tier.
---
Troubleshooting
Bot does not reply
Check:
Render deploy logs
environment variables are filled in correctly
`WEBHOOK_URL` matches your real Render URL
Supabase SQL was run successfully
Render page loads but Telegram bot is silent
Redeploy once after setting the environment variables. The webhook is set during app startup.
Supabase error
Make sure you pasted and ran the full `supabase.sql` file.
