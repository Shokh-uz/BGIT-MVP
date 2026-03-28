const express = require("express");
const bodyParser = require("body-parser");
const cors = require("cors");
const fs = require("fs/promises");
const path = require("path");
const crypto = require("crypto");

const DATA_PATH = path.join(__dirname, "data.json");
const BOOKS_PATH = path.join(__dirname, "books.json");
const BOOKS_HARRY_PATH = path.join(__dirname, "books-harry.json");
const PORT = process.env.PORT || 3000;

const app = express();

app.use(cors());
app.use(bodyParser.json());

async function readStore() {
  const raw = await fs.readFile(DATA_PATH, "utf8");
  return JSON.parse(raw);
}

async function writeStore(data) {
  await fs.writeFile(DATA_PATH, JSON.stringify(data, null, 2), "utf8");
}

async function readBooksFile() {
  const raw = await fs.readFile(BOOKS_PATH, "utf8");
  const data = JSON.parse(raw);
  try {
    const hpRaw = await fs.readFile(BOOKS_HARRY_PATH, "utf8");
    const hp = JSON.parse(hpRaw);
    if (hp && hp.id && Array.isArray(hp.questions)) {
      data.books.push({
        id: hp.id,
        title: hp.title,
        randomQuestionCount:
          typeof hp.randomQuestionCount === "number" ? hp.randomQuestionCount : undefined,
        questions: hp.questions,
      });
    }
  } catch (_) {
    /* harry kitobi ixtiyoriy */
  }
  return data;
}

function shuffleInPlace(arr) {
  for (let i = arr.length - 1; i > 0; i--) {
    const j = Math.floor(Math.random() * (i + 1));
    [arr[i], arr[j]] = [arr[j], arr[i]];
  }
  return arr;
}

function stripAnswersFromQuestions(questions) {
  return questions.map(({ correctAnswer: _c, ...q }) => q);
}

/** YYYY-MM-DD in UTC for streak comparisons. */
function utcDayKey(isoOrDate) {
  const d = isoOrDate instanceof Date ? isoOrDate : new Date(isoOrDate);
  return d.toISOString().slice(0, 10);
}

/** Whole calendar days from `lastDayKey` to `todayDayKey` (UTC), both YYYY-MM-DD. */
function calendarDayDeltaUtc(lastDayKey, todayDayKey) {
  const t0 = Date.parse(`${lastDayKey}T00:00:00.000Z`);
  const t1 = Date.parse(`${todayDayKey}T00:00:00.000Z`);
  return Math.round((t1 - t0) / 86400000);
}

/**
 * Updates `user.streak` and `user.last_active` (ISO string) when they log in.
 * - No prior `last_active`: streak → 1 (first active day).
 * - Same UTC day: streak unchanged.
 * - Previous UTC day: streak + 1.
 * - Longer gap or invalid: streak → 1.
 */
function applyStreakOnLogin(user, now = new Date()) {
  const todayKey = utcDayKey(now);
  const prevStreak = typeof user.streak === "number" ? user.streak : 0;
  const lastRaw = user.last_active;

  if (lastRaw == null || lastRaw === "") {
    user.streak = 1;
    user.last_active = now.toISOString();
    return;
  }

  const lastKey = utcDayKey(new Date(lastRaw));
  const delta = calendarDayDeltaUtc(lastKey, todayKey);

  if (delta < 0) {
    user.streak = 1;
  } else if (delta === 0) {
    user.streak = prevStreak;
  } else if (delta === 1) {
    user.streak = prevStreak + 1;
  } else {
    user.streak = 1;
  }

  user.last_active = now.toISOString();
}

function userXp(user) {
  const x = user.xp;
  return typeof x === "number" && Number.isFinite(x) ? x : 0;
}

function publicUserAuth(user) {
  return {
    id: user.id,
    email: user.email,
    xp: userXp(user),
    streak: typeof user.streak === "number" ? user.streak : 0,
    last_active: user.last_active ?? null,
  };
}

function hashPassword(password, salt) {
  return crypto.scryptSync(password, salt, 64).toString("hex");
}

function newSalt() {
  return crypto.randomBytes(16).toString("hex");
}

/** Simple, practical email shape check (not full RFC). */
function isValidEmail(email) {
  return /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email);
}

const MIN_PASSWORD_LENGTH = 8;

function validateAuthBody(body, { requireStrongPassword }) {
  const { email, password } = body || {};

  if (email == null || password == null) {
    return {
      ok: false,
      response: {
        status: 400,
        body: { error: "Validation failed", message: "email and password are required" },
      },
    };
  }

  if (typeof email !== "string" || typeof password !== "string") {
    return {
      ok: false,
      response: {
        status: 400,
        body: { error: "Validation failed", message: "email and password must be strings" },
      },
    };
  }

  const normalizedEmail = email.trim().toLowerCase();

  if (!normalizedEmail) {
    return {
      ok: false,
      response: {
        status: 400,
        body: { error: "Validation failed", message: "email cannot be empty" },
      },
    };
  }

  if (!isValidEmail(normalizedEmail)) {
    return {
      ok: false,
      response: {
        status: 400,
        body: { error: "Validation failed", message: "email format is invalid" },
      },
    };
  }

  if (!password.length) {
    return {
      ok: false,
      response: {
        status: 400,
        body: { error: "Validation failed", message: "password cannot be empty" },
      },
    };
  }

  if (requireStrongPassword && password.length < MIN_PASSWORD_LENGTH) {
    return {
      ok: false,
      response: {
        status: 400,
        body: {
          error: "Validation failed",
          message: `password must be at least ${MIN_PASSWORD_LENGTH} characters`,
        },
      },
    };
  }

  return { ok: true, normalizedEmail, password };
}

app.post("/register", async (req, res) => {
  try {
    const check = validateAuthBody(req.body, { requireStrongPassword: true });
    if (!check.ok) {
      return res.status(check.response.status).json(check.response.body);
    }

    const { normalizedEmail, password } = check;
    const store = await readStore();

    if (store.users.some((u) => u.email === normalizedEmail)) {
      return res.status(409).json({
        error: "Conflict",
        message: "A user with this email already exists",
      });
    }

    const salt = newSalt();
    const user = {
      id: crypto.randomUUID(),
      email: normalizedEmail,
      passwordHash: hashPassword(password, salt),
      salt,
      streak: 0,
      last_active: null,
      xp: 0,
    };

    store.users.push(user);
    await writeStore(store);

    return res.status(201).json({
      success: true,
      user: publicUserAuth(user),
    });
  } catch (err) {
    console.error(err);
    return res.status(500).json({ error: "Internal server error" });
  }
});

app.post("/login", async (req, res) => {
  try {
    const check = validateAuthBody(req.body, { requireStrongPassword: false });
    if (!check.ok) {
      return res.status(check.response.status).json(check.response.body);
    }

    const { normalizedEmail, password } = check;
    const store = await readStore();
    const user = store.users.find((u) => u.email === normalizedEmail);

    if (!user) {
      return res.status(401).json({
        error: "Unauthorized",
        message: "Invalid email or password",
      });
    }

    const candidate = hashPassword(password, user.salt);
    if (candidate !== user.passwordHash) {
      return res.status(401).json({
        error: "Unauthorized",
        message: "Invalid email or password",
      });
    }

    applyStreakOnLogin(user);
    await writeStore(store);

    return res.status(200).json({
      success: true,
      user: publicUserAuth(user),
    });
  } catch (err) {
    console.error(err);
    return res.status(500).json({ error: "Internal server error" });
  }
});

app.get("/leaderboard", async (req, res) => {
  try {
    const store = await readStore();
    const sorted = [...store.users].sort((a, b) => {
      const byXp = userXp(b) - userXp(a);
      if (byXp !== 0) return byXp;
      const sa = typeof a.streak === "number" ? a.streak : 0;
      const sb = typeof b.streak === "number" ? b.streak : 0;
      const byStreak = sb - sa;
      if (byStreak !== 0) return byStreak;
      return (a.email || "").localeCompare(b.email || "");
    });

    const leaderboard = sorted.slice(0, 10).map((u, idx) => ({
      rank: idx + 1,
      id: u.id,
      email: u.email,
      xp: userXp(u),
      streak: typeof u.streak === "number" ? u.streak : 0,
    }));

    return res.status(200).json({ leaderboard });
  } catch (err) {
    console.error(err);
    return res.status(500).json({ error: "Internal server error" });
  }
});

app.get("/books", async (req, res) => {
  try {
    const { books } = await readBooksFile();
    return res.status(200).json({
      books: books.map((b) => ({ id: b.id, title: b.title })),
    });
  } catch (err) {
    console.error(err);
    return res.status(500).json({ error: "Internal server error" });
  }
});

app.get("/quiz/:bookId", async (req, res) => {
  try {
    const bookId = req.params.bookId;
    if (!bookId || typeof bookId !== "string") {
      return res.status(400).json({ error: "Invalid book id" });
    }

    const { books } = await readBooksFile();
    const book = books.find((b) => b.id === bookId);

    if (!book) {
      return res.status(404).json({ error: "Book not found" });
    }

    let pool = [...book.questions];
    if (typeof book.randomQuestionCount === "number" && book.randomQuestionCount > 0) {
      shuffleInPlace(pool);
      pool = pool.slice(0, Math.min(book.randomQuestionCount, pool.length));
    }

    return res.status(200).json({
      id: book.id,
      title: book.title,
      questions: stripAnswersFromQuestions(pool),
    });
  } catch (err) {
    console.error(err);
    return res.status(500).json({ error: "Internal server error" });
  }
});

/**
 * Javoblarni serverda tekshiradi; klientga to‘g‘ri variant matni qaytarilmaydi.
 */
app.post("/quiz/:bookId/grade", async (req, res) => {
  try {
    const bookId = req.params.bookId;
    if (!bookId || typeof bookId !== "string") {
      return res.status(400).json({ error: "Invalid book id" });
    }

    const { answers } = req.body || {};
    if (!Array.isArray(answers)) {
      return res.status(400).json({ error: "answers array required" });
    }

    const { books } = await readBooksFile();
    const book = books.find((b) => b.id === bookId);

    if (!book) {
      return res.status(404).json({ error: "Book not found" });
    }

    const byId = new Map(book.questions.map((q) => [q.id, q]));
    const results = answers.map(({ questionId, selected }) => {
      const q = byId.get(questionId);
      if (!q) {
        return { questionId, correct: false };
      }
      if (selected == null || selected === "") {
        return { questionId, correct: false };
      }
      return { questionId, correct: selected === q.correctAnswer };
    });

    return res.status(200).json({ results });
  } catch (err) {
    console.error(err);
    return res.status(500).json({ error: "Internal server error" });
  }
});

app.use(express.static(path.join(__dirname, "public")));

app.use((req, res) => {
  res.status(404).json({ error: "Not found" });
});

app.listen(PORT, () => {
  console.log(`Server listening on http://localhost:${PORT}`);
});
