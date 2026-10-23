# הבית והגינה

לוח שליטה לבית ולגינה: מתגים, תריסים, מזגנים (שלט IR), דוד, וארבעה אזורי השקיה ב-Hydrawise. האתר סטטי ואין בו סודות. כל הקריאות ל-Tuya ול-Hydrawise עוברות דרך Cloudflare Worker ששומר את המפתחות אצלו.

הממשק בעברית, מימין לשמאל, ומותאם לטלפון.

## שימוש

1. פותחים את [https://eylonrosner-collab.github.io/smarthome/](https://eylonrosner-collab.github.io/smarthome/) בטלפון.
2. מזינים את הסיסמה פעם אחת. היא נשמרת רק בדפדפן (`localStorage`), לא באתר.
3. בכרטיס של כל מכשיר: הדלקה וכיבוי של כל מתג, פתיחה/סגירה/עצירה/מיקום לתריס, הפעלה/מצב/טמפרטורה למזגן, והשקיה/עצירה/השהיה לאזור. «שינוי שם» (העיפרון) ו«הסתר» זמינים לכל מכשיר ולכל מתג. מה שמוסתר נעלם מהלוח; «הצג מוסתרים» מחזיר אותו עם סימון ואפשרות להציג שוב. השם שנבחר מחליף את שם ה-Tuya גם בלוח וגם כשכותבים תרחיש, ונשמר בשרת כדי שיהיה זהה בטלפון ובמחשב.
4. בלשונית **תרחישים** כותבים משפט בעברית או באנגלית. המערכת מציגה בעברית מה היא הבינה, ורק אחרי אישור התרחיש נשמר.
5. בלשונית **יומן** רואים מה רץ לאחרונה. בדיקה אוטומטית רצה כל חמש דקות לפי שעון ישראל, ונרשמת ביומן רק כשתרחיש באמת רץ. הלוח מתרענן בערך פעם בדקה; מצב המכשירים של Tuya נקרא מחדש לכל היותר כל חצי שעה. אם Hydrawise עמוס, אזורי ההשקיה נשארים על המסך עם הסימון «נתונים ישנים» והשעה האחרונה שבה הם עודכנו. אם מכסת הקריאות החודשית של Tuya נגמרה, הלוח מציג את המצב השמור ואת ההודעה «מכסת הקריאות של Tuya נגמרה החודש».

דוגמאות:

- `כשלחות הקרקע מתחת ל-30% השקה את Back Lawn ל-10 דקות`
- `כל יום ב-19:00 סגור את תריסי הסלון והדלק תאורת שביל`
- `סצנה: ערב סרט`

תרחיש של חיישן לא יופעל שוב ושוב כל עוד התנאי מתקיים: בהשקיה יש המתנה של שלוש שעות לפחות. תרחיש של שעה רץ פעם אחת בחלון של עשר דקות סביב השעה שנבחרה.

חיישן לחות קרקע של Tuya (קטגוריה כמו `zwjcy`) יופיע בגינה עם לחות, טמפרטורה וסוללה ברגע שהוא מחובר לחשבון. אין צורך בעדכון קוד בשביל להציג אותו. תרחיש שמסתמך על לחות קרקע, כשעדיין אין חיישן כזה, מציג אזהרה בעברית וכפתור השמירה נשאר כבוי עד שהחיישן מופיע בחשבון.

לפני שה-Worker פרוס אפשר לפתוח `?mock=1` ולראות תצוגת הדגמה.

## What runs where

| Piece | Role |
| --- | --- |
| `docs/` | Static Hebrew UI. GitHub Pages serves it at `/smarthome/`. |
| `docs/config.js` | The only site setting: the public Worker URL. |
| `worker/` | Cloudflare Worker. Holds `TUYA_ACCESS_ID`, `TUYA_ACCESS_SECRET`, `HYDRAWISE_API_KEY`, and `DASH_PASSWORD`. |
| Workers KV `RULES` | Only durable data: scenarios, hide/rename prefs, and the activity log. A write happens when one of those actually changes. |
| Status cache | Hydrawise and Tuya status live in memory and the Cache API, not KV. Hydrawise `statusschedule.php` at most about once a minute (or longer when `nextpoll` is set), including `fresh=1`. A 429 keeps the last zones. Tuya device metadata is cached for 24 hours. A full status sweep runs at most every 30 minutes, and only while the dashboard is open. Cron reads Tuya only for devices referenced by an enabled sensor rule, in one batch call. |
| Workers AI | Turns a free-text scenario into a JSON rule. Model: `@cf/meta/llama-3.3-70b-instruct-fp8-fast`. |
| Cron `*/5 * * * *` | Evaluates enabled rules in `Asia/Jerusalem`. A tick where nothing fires does not write to KV. |

The Workers free plan allows 1,000 KV writes per day. Status polling does not use that budget. A quiet day — dashboard left open, cron running, no commands and no scenario firing — writes zero times. Each command or rename is one write, and a scenario that fires adds one activity line plus one rules write for that tick. Ordinary use stays under about 30 writes a day. Reads of rules, names, and the log come from memory or the Cache API after the first load, so a warm worker does not re-read KV on every poll.

The browser sends `Authorization: Bearer <password>`. CORS allows only `https://eylonrosner-collab.github.io`.

Tuya uses the EU host `https://openapi.tuyaeu.com`. Signing matches the working Python client: HMAC-SHA256 over `client_id + token + timestamp + METHOD + "\n" + sha256(body) + "\n\n" + path`, with query keys sorted. Device status tries `/v1.0/devices/{id}/status` and falls back to `/v2.0/cloud/thing/{id}/shadow/properties`. Air conditioners are sent through the IR multi-key API `POST /v2.0/infrareds/{infrared_id}/air-conditioners/{remote_id}/scenes/command`.

Hydrawise uses API v1: `statusschedule.php`, `customerdetails.php`, and `setzone.php` (`run` custom seconds, `stop`, `suspend` until a unix time, `period_id=0` to resume).

## Deploy the Worker

Create a Cloudflare API token with **Account / Workers Scripts / Edit** and **Account / Workers KV Storage / Edit**. Turn on Workers AI for the account (the AI binding). On the Tuya cloud project, IoT Core is required for status and commands, and **IR Control Hub** is required for the air conditioners.

From a shell, with the secrets only in the environment:

```bash
export CLOUDFLARE_API_TOKEN="..."
export CLOUDFLARE_ACCOUNT_ID="..."
export TUYA_ACCESS_ID="..."
export TUYA_ACCESS_SECRET="..."
export HYDRAWISE_API_KEY="..."
export DASH_PASSWORD="..."

cd worker
chmod +x deploy.sh
./deploy.sh --write-config
```

The script reuses the KV namespace already set in `wrangler.toml`, or an existing namespace titled `RULES` (Wrangler 4) or `smarthome-RULES`. It creates `RULES` only when none of those exist, writes the id into `worker/wrangler.toml`, uploads the four secrets, deploys with `npx wrangler`, prints the `workers.dev` URL, and with `--write-config` sets that URL in `docs/config.js`. A second run does not create another namespace.

Commit and push `docs/config.js` and the updated `worker/wrangler.toml` (the namespace id is not a secret). Do not commit `.dev.vars`.

## GitHub Pages

1. On GitHub: **Settings → Pages → Build and deployment → Source: GitHub Actions**.
2. Push to `main`. The workflow [`.github/workflows/pages.yml`](.github/workflows/pages.yml) publishes the `docs/` folder.
3. Open `https://eylonrosner-collab.github.io/smarthome/` and sign in with `DASH_PASSWORD`.

Until `docs/config.js` points at the Worker, the password form explains that, and **תצוגת הדגמה** shows the layout with sample devices.

## Tests

No cloud credentials are required. Node.js 22 or newer (`engines` in `worker/package.json`; Wrangler 4 needs it).

```bash
cd worker
npm install
npm test
npm run typecheck
npm run dry-run
```

`npm test` checks the Tuya signature against known HMAC vectors, Hebrew/English rule parsing, Jerusalem-time evaluation and cooldowns, Hydrawise query parameters, soil-sensor normalization, and HTML rendering of the mock dashboard.
