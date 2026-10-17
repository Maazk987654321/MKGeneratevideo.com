require("dotenv").config();
const express = require("express");
const Database = require("better-sqlite3");
const bcrypt = require("bcryptjs");
const jwt = require("jsonwebtoken");
const cookieParser = require("cookie-parser");
const path = require("path");

const { FAL_KEY, JWT_SECRET, OWNER_EMAIL, OWNER_PASSWORD } = process.env;
if (!FAL_KEY || !JWT_SECRET) {
  console.error("Set FAL_KEY and JWT_SECRET in your environment.");
  process.exit(1);
}

const SIGNUP_CREDITS = 50;
const VIDEO_COST = 10;
const MAX_FREE_SIGNUPS_PER_IP = 2;
const MODELS = {
  t2v: process.env.FAL_MODEL_T2V || "fal-ai/ltx-video",
  i2v: process.env.FAL_MODEL_I2V || "fal-ai/ltx-video/image-to-video",
};
const DISPOSABLE = new Set([
  "mailinator.com", "10minutemail.com", "guerrillamail.com", "tempmail.com",
  "yopmail.com", "trashmail.com", "sharklasers.com", "getnada.com", "dispostable.com",
]);

const db = new Database(process.env.DB_PATH || path.join(__dirname, "data.db"));
db.exec(`
CREATE TABLE IF NOT EXISTS users (
  id INTEGER PRIMARY KEY, email TEXT NOT NULL, canon TEXT UNIQUE NOT NULL,
  hash TEXT NOT NULL, credits INTEGER NOT NULL DEFAULT 0, is_owner INTEGER NOT NULL DEFAULT 0,
  signup_ip TEXT, created_at TEXT DEFAULT CURRENT_TIMESTAMP
);
CREATE TABLE IF NOT EXISTS jobs (
  id INTEGER PRIMARY KEY, user_id INTEGER NOT NULL, mode TEXT, prompt TEXT,
  status TEXT DEFAULT 'pending', status_url TEXT, response_url TEXT,
  video_url TEXT, error TEXT, created_at TEXT DEFAULT CURRENT_TIMESTAMP
);
`);

// Same mailbox, different spelling (a.b@gmail.com, ab+1@gmail.com) counts as ONE email.
function canon(email) {
  let [local, domain] = email.trim().toLowerCase().split("@");
  if (domain === "googlemail.com") domain = "gmail.com";
  local = local.split("+")[0];
  if (domain === "gmail.com") local = local.replace(/\./g, "");
  return `${local}@${domain}`;
}

// The owner account is created from your environment settings and has unlimited use.
if (OWNER_EMAIL && OWNER_PASSWORD) {
  db.prepare(
    `INSERT INTO users (email, canon, hash, is_owner) VALUES (?, ?, ?, 1)
     ON CONFLICT(canon) DO UPDATE SET hash = excluded.hash, is_owner = 1`
  ).run(OWNER_EMAIL.trim().toLowerCase(), canon(OWNER_EMAIL), bcrypt.hashSync(OWNER_PASSWORD, 10));
}

const app = express();
app.set("trust proxy", 1);
app.use(express.json({ limit: "12mb" }));
app.use(cookieParser());
app.use(express.static(path.join(__dirname, "public")));

const publicUser = (u) => ({ email: u.email, unlimited: !!u.is_owner, credits: u.credits });

function login(res, id) {
  res.cookie("t", jwt.sign({ id }, JWT_SECRET, { expiresIn: "30d" }), {
    httpOnly: true, sameSite: "lax", maxAge: 30 * 864e5,
    secure: process.env.NODE_ENV === "production",
  });
}

function auth(req, res, next) {
  try {
    const { id } = jwt.verify(req.cookies.t, JWT_SECRET);
    const user = db.prepare("SELECT * FROM users WHERE id = ?").get(id);
    if (!user) throw new Error("no user");
    req.user = user;
    next();
  } catch {
    res.status(401).json({ error: "Please log in." });
  }
}

app.post("/api/signup", (req, res) => {
  const { email = "", password = "" } = req.body || {};
  if (!/^[^@\s]+@[^@\s]+\.[^@\s]+$/.test(email)) return res.status(400).json({ error: "Enter a valid email address." });
  if (password.length < 10) return res.status(400).json({ error: "Password must be at least 10 characters." });
  if (DISPOSABLE.has(email.split("@")[1].toLowerCase())) return res.status(400).json({ error: "Temporary email addresses are not allowed." });

  const c = canon(email);
  if (db.prepare("SELECT 1 FROM users WHERE canon = ?").get(c)) return res.status(409).json({ error: "This email is already registered. Log in instead." });

  const ip = req.ip;
  const used = db.prepare("SELECT COUNT(*) n FROM users WHERE signup_ip = ? AND is_owner = 0").get(ip).n;
  const credits = used < MAX_FREE_SIGNUPS_PER_IP ? SIGNUP_CREDITS : 0;

  const info = db.prepare("INSERT INTO users (email, canon, hash, credits, signup_ip) VALUES (?, ?, ?, ?, ?)")
    .run(email.trim().toLowerCase(), c, bcrypt.hashSync(password, 10), credits, ip);
  login(res, info.lastInsertRowid);
  res.json({ user: publicUser(db.prepare("SELECT * FROM users WHERE id = ?").get(info.lastInsertRowid)), freeCreditsGiven: credits > 0 });
});

app.post("/api/login", (req, res) => {
  const { email = "", password = "" } = req.body || {};
  const user = /@/.test(email) ? db.prepare("SELECT * FROM users WHERE canon = ?").get(canon(email)) : null;
  if (!user || !bcrypt.compareSync(password, user.hash)) return res.status(401).json({ error: "Wrong email or password." });
  login(res, user.id);
  res.json({ user: publicUser(user) });
});

app.post("/api/logout", (req, res) => { res.clearCookie("t"); res.json({ ok: true }); });

function refund(user) {
  if (!user.is_owner) db.prepare("UPDATE users SET credits = credits + ? WHERE id = ?").run(VIDEO_COST, user.id);
}

app.post("/api/generate", auth, async (req, res) => {
  const { mode, prompt = "", image } = req.body || {};
  if (!["t2v", "i2v"].includes(mode)) return res.status(400).json({ error: "Pick text to video or image to video." });
  if (prompt.trim().length < 3) return res.status(400).json({ error: "Describe your video first." });
  if (mode === "i2v" && !(typeof image === "string" && image.startsWith("data:image/"))) return res.status(400).json({ error: "Upload an image for image to video." });

  const user = req.user;
  if (!user.is_owner) {
    const r = db.prepare("UPDATE users SET credits = credits - ? WHERE id = ? AND credits >= ?").run(VIDEO_COST, user.id, VIDEO_COST);
    if (!r.changes) return res.status(402).json({ error: `Not enough credits. Each video costs ${VIDEO_COST} credits.` });
  }

  try {
    const input = { prompt: prompt.trim() };
    if (mode === "i2v") input.image_url = image;
    const r = await fetch(`https://queue.fal.run/${MODELS[mode]}`, {
      method: "POST",
      headers: { Authorization: `Key ${FAL_KEY}`, "Content-Type": "application/json" },
      body: JSON.stringify(input),
    });
    const d = await r.json();
    if (!r.ok || !d.status_url) throw new Error(JSON.stringify(d).slice(0, 300));
    const info = db.prepare("INSERT INTO jobs (user_id, mode, prompt, status_url, response_url) VALUES (?, ?, ?, ?, ?)")
      .run(user.id, mode, prompt.trim(), d.status_url, d.response_url);
    res.json({ id: info.lastInsertRowid });
  } catch (e) {
    console.error("fal submit failed:", e.message);
    refund(user);
    res.status(502).json({ error: "The video service rejected the request. Your credits were returned." });
  }
});

function failJob(job, message) {
  const r = db.prepare("UPDATE jobs SET status = 'failed', error = ? WHERE id = ? AND status = 'pending'").run(message, job.id);
  if (r.changes) refund(db.prepare("SELECT * FROM users WHERE id = ?").get(job.user_id));
}

async function refreshJob(job) {
  try {
    const headers = { Authorization: `Key ${FAL_KEY}` };
    const s = await (await fetch(job.status_url, { headers })).json();
    if (s.status === "COMPLETED") {
      const out = await (await fetch(job.response_url, { headers })).json();
      const url = out?.video?.url || out?.data?.video?.url;
      if (url) db.prepare("UPDATE jobs SET status = 'done', video_url = ? WHERE id = ?").run(url, job.id);
      else failJob(job, "No video was returned.");
    } else if (s.status === "FAILED") {
      failJob(job, "Generation failed.");
    }
  } catch (e) {
    console.error("refresh failed:", e.message); // try again on the next poll
  }
}

app.get("/api/jobs", auth, async (req, res) => {
  const list = () => db.prepare("SELECT * FROM jobs WHERE user_id = ? ORDER BY id DESC LIMIT 30").all(req.user.id);
  await Promise.all(list().filter((j) => j.status === "pending").map(refreshJob));
  const me = db.prepare("SELECT * FROM users WHERE id = ?").get(req.user.id);
  res.json({
    user: publicUser(me),
    cost: VIDEO_COST,
    jobs: list().map(({ id, mode, prompt, status, video_url, error }) => ({ id, mode, prompt, status, video_url, error })),
  });
});

app.get("/api/me", auth, (req, res) => res.json({ user: publicUser(req.user) }));

app.listen(process.env.PORT || 3000, () => console.log("MK Video Generate is running."));
