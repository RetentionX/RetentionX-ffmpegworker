import express from "express";
import multer from "multer";
import { exec } from "child_process";
import fs from "fs";
import path from "path";
import { fileURLToPath } from "url";
import crypto from "crypto";

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

const app = express();
app.use(express.json());

/* ===============================
   CORS (REQUIRED FOR FRONTEND)
================================ */
app.use((req, res, next) => {
  res.setHeader("Access-Control-Allow-Origin", "*");
  res.setHeader("Access-Control-Allow-Headers", "Content-Type, Authorization");
  res.setHeader("Access-Control-Allow-Methods", "GET,POST,OPTIONS");

  if (req.method === "OPTIONS") {
    return res.sendStatus(200);
  }

  next();
});

/* ===============================
   AUTH MIDDLEWARE (REQUIRED)
================================ */

app.use((req, res, next) => {
  const auth = req.headers.authorization;

  // Allow health check without auth
  if (req.path === "/") return next();

  // If no API key configured, allow (dev mode)
  if (!process.env.FFMPEG_API_KEY) return next();

  if (!auth || auth !== `Bearer ${process.env.FFMPEG_API_KEY}`) {
    return res.status(401).json({ error: "Unauthorized" });
  }

  next();
});

/* ===============================
   BASIC CONFIG
================================ */

const PORT = process.env.PORT || 3000;
const TMP_DIR = path.join(__dirname, "tmp");

if (!fs.existsSync(TMP_DIR)) {
  fs.mkdirSync(TMP_DIR);
}

/* ===============================
   MULTER (UPLOAD – DISK STORAGE)
================================ */

const upload = multer({
  dest: TMP_DIR,
  limits: {
    fileSize: 1024 * 1024 * 1024 // 1GB
  }
});

/* ===============================
   HELPERS
================================ */

function run(cmd) {
  return new Promise((resolve, reject) => {
    exec(cmd, (error, stdout, stderr) => {
      if (error) reject(stderr || error.message);
      else resolve(stderr || stdout);
    });
  });
}

function uid() {
  return crypto.randomBytes(8).toString("hex");
}

/* ===============================
   HEALTH CHECK
================================ */

app.get("/", (req, res) => {
  res.json({ status: "RetentionX FFmpeg Worker Running" });
});

/* ===============================
   ANALYZE SILENCE (FINAL WORKING)
================================ */

app.post("/analyze-silence", upload.single("video"), async (req, res) => {
  try {
    /* ---------- 1. Validate input ---------- */
    if (!req.file || !req.file.path) {
      return res.status(400).json({
        error: "Video file missing",
        hint: "Send multipart/form-data with field name 'video'"
      });
    }

    const input = req.file.path;
    const logFile = `${input}.log`;

    /* ---------- 2. Run FFmpeg silence detection ---------- */
    const cmd = `ffmpeg -y -i "${input}" -af silencedetect=n=-30dB:d=0.3 -f null - 2> "${logFile}"`;
    await run(cmd);

    /* ---------- 3. Parse silence log ---------- */
    const log = fs.readFileSync(logFile, "utf8");
    const lines = log.split("\n");

    const silences = [];
    let start = null;

    for (const line of lines) {
      if (line.includes("silence_start")) {
        start = parseFloat(line.split("silence_start:")[1]);
      }

      if (line.includes("silence_end") && start !== null) {
        const end = parseFloat(line.split("silence_end:")[1]);
        silences.push({
          start: Number(start.toFixed(2)),
          end: Number(end.toFixed(2)),
          duration: Number((end - start).toFixed(2))
        });
        start = null;
      }
    }

    /* ---------- 4. Respond ---------- */
    res.json({
      status: "ok",
      silences,
      totalSilenceDuration: silences.reduce(
        (sum, s) => sum + s.duration,
        0
      )
    });

  } catch (err) {
    console.error("Analyze silence failed:", err);
    res.status(500).json({
      error: "Video analysis failed"
    });
  }
});

/* ===============================
   APPLY SILENCE CUTS (FINAL STABLE)
================================ */

app.post("/apply-silence", upload.any(), async (req, res) => {
  try {
    /* ---------- 1. Get uploaded video ---------- */
    if (!req.files || !Array.isArray(req.files)) {
      return res.status(400).json({ error: "No files received" });
    }

    const videoFile = req.files.find(f => f.fieldname === "video");

    if (!videoFile || !videoFile.path) {
      return res.status(400).json({
        error: "Video file missing",
        hint: "Send multipart/form-data with field name 'video'"
      });
    }

    const inputPath = videoFile.path; // ✅ USE MULTER PATH
    const outputPath = `${TMP_DIR}/${uid()}.mp4`;

    /* ---------- 2. Read silences ---------- */
    let silencesRaw =
      req.body.silences ||
      req.body.silenceSegments ||
      req.body.silence_list;

    if (!silencesRaw) {
      return res.status(400).json({ error: "Silence list missing" });
    }

    /* ---------- 3. Parse silence JSON ---------- */
    let silences;
    try {
      silences =
        typeof silencesRaw === "string"
          ? JSON.parse(silencesRaw)
          : silencesRaw;
    } catch {
      return res.status(400).json({
        error: "Invalid silence JSON",
        received: silencesRaw
      });
    }

    /* ---------- 4. Validate silences ---------- */
    if (!Array.isArray(silences) || silences.length === 0) {
      return res.status(400).json({ error: "Empty silence list" });
    }

    silences = silences.map(s => ({
      start: Number(s.start),
      end: Number(s.end)
    }));

    for (const s of silences) {
      if (
        Number.isNaN(s.start) ||
        Number.isNaN(s.end) ||
        s.start >= s.end
      ) {
        return res.status(400).json({
          error: "Invalid silence range",
          silence: s
        });
      }
    }

    /* ---------- 5. Build FFmpeg filter ---------- */
    const filterExpr = silences
      .map(s => `between(t,${s.start},${s.end})`)
      .join("+");

    const cmd = `
      ffmpeg -y -i "${inputPath}" \
      -af "aselect='not(${filterExpr})',asetpts=N/SR/TB" \
      -vf "select='not(${filterExpr})',setpts=N/FRAME_RATE/TB" \
      "${outputPath}"
    `;

    await run(cmd);

    /* ---------- 6. Success ---------- */
    res.json({
      status: "silence_removed",
      outputFile: outputPath,
      silencesApplied: silences.length
    });

  } catch (err) {
    console.error("Apply silence failed:", err);
    res.status(500).json({
      error: "Video processing failed",
      details: err.message
    });
  }
});

/* ===============================
   EXTRACT AUDIO
================================ */

app.post("/extract-audio", upload.single("video"), async (req, res) => {
  try {
    const input = req.file.path;
    const audio = `${TMP_DIR}/${uid()}.wav`;

    await run(`ffmpeg -i "${input}" -ar 16000 -ac 1 "${audio}"`);

    res.json({
      status: "audio_extracted",
      audioFile: audio
    });

  } catch (err) {
    res.status(500).json({ error: err.toString() });
  }
});

/* ===============================
   APPLY CAPTIONS
================================ */

app.post("/apply-captions", upload.fields([
  { name: "video", maxCount: 1 },
  { name: "srt", maxCount: 1 }
]), async (req, res) => {
  try {
    const video = req.files.video[0].path;
    const srt = req.files.srt[0].path;
    const output = `${TMP_DIR}/${uid()}.mp4`;

    const cmd = `
      ffmpeg -i "${video}"
      -vf subtitles="${srt}"
      "${output}"
    `;

    await run(cmd);

    res.json({
      status: "captions_applied",
      outputFile: output
    });

  } catch (err) {
    res.status(500).json({ error: err.toString() });
  }
});

/* ===============================
   CLEANUP
================================ */

app.post("/cleanup", (req, res) => {
  const { file } = req.body;
  if (file && fs.existsSync(file)) fs.unlinkSync(file);
  res.json({ status: "cleaned" });
});

/* ===============================
   START SERVER
================================ */

app.listen(PORT, () => {
  console.log("FFmpeg Worker running on port", PORT);
});
