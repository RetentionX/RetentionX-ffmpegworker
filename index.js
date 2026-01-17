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
   BASIC CONFIG
================================ */

const PORT = process.env.PORT || 3000;
const TMP_DIR = path.join(__dirname, "tmp");

if (!fs.existsSync(TMP_DIR)) {
  fs.mkdirSync(TMP_DIR);
}

/* ===============================
   MULTER (UPLOAD)
================================ */

const upload = multer({
  dest: TMP_DIR,
  limits: { fileSize: 1024 * 1024 * 1024 } // 1GB
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
   ANALYZE SILENCE (FIXED)
================================ */

app.post("/analyze-silence", upload.single("video"), async (req, res) => {
  try {
    if (!req.file) {
      return res.status(400).json({ error: "video required" });
    }

    const level = req.body.level || "medium";

    const noiseMap = {
      low: "-40dB",
      medium: "-35dB",
      high: "-30dB"
    };

    const noise = noiseMap[level];

    if (!noise) {
      return res.status(400).json({ error: "invalid level" });
    }

    const input = req.file.path;
    const logFile = `${input}.log`;

    const cmd = `
      ffmpeg -i "${input}"
      -af silencedetect=n=${noise}:d=0.3
      -f null - 2> "${logFile}"
    `;

    await run(cmd);

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

    res.json({
      status: "ok",
      level,
      silences
    });

  } catch (err) {
    res.status(500).json({ error: err.toString() });
  }
});

/* ===============================
   APPLY SILENCE CUTS
================================ */

app.post("/apply-silence", upload.single("video"), async (req, res) => {
  try {
    const { silences } = req.body;
    const input = req.file.path;
    const output = `${TMP_DIR}/${uid()}.mp4`;

    if (!silences || !Array.isArray(silences)) {
      return res.status(400).json({ error: "Silence list missing" });
    }

    const filters = silences
      .map(s => `between(t,${s.start},${s.end})`)
      .join("+");

    const cmd = `
      ffmpeg -i "${input}"
      -af "aselect='not(${filters})',asetpts=N/SR/TB"
      -vf "select='not(${filters})',setpts=N/FRAME_RATE/TB"
      "${output}"
    `;

    await run(cmd);

    res.json({
      status: "silence_removed",
      outputFile: output
    });

  } catch (err) {
    res.status(500).json({ error: err.toString() });
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
