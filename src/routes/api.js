const express = require("express");
const bcrypt = require("bcryptjs");
const {
  Client,
  Event,
  Task,
  Batch,
  Note,
  Questionnaire,
  Activity,
  User,
} = require("../models");
const auth = require("../middleware/auth");

const router = express.Router();
const EMAIL_REGEX = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;
const TASK_COLUMNS = ["todo", "bezig", "review", "klaar"];
const BCRYPT_HASH_REGEX = /^\$2[aby]\$\d{2}\$/;
const LT_LANG_MAP = {
  nl: "nl-NL",
  en: "en-US",
  "nl+en": "auto",
};

function normalizeEmail(value) {
  return typeof value === "string" ? value.trim().toLowerCase() : "";
}

function isValidPortalPassword(password) {
  return typeof password === "string" && password.trim().length >= 8;
}

function hasOwn(obj, key) {
  return Object.prototype.hasOwnProperty.call(obj, key);
}

async function resolveClientIdFromPayload(payload = {}) {
  if (payload.clientId) return payload.clientId;
  const name = typeof payload.client === "string" ? payload.client.trim() : "";
  if (!name) return undefined;
  const client = await Client.findOne({ name });
  return client?._id;
}

async function resolveTaskClientFields(payload = {}) {
  const clientId = await resolveClientIdFromPayload(payload);
  if (clientId) {
    const clientDoc = await Client.findById(clientId).select("name");
    return {
      clientId,
      client: clientDoc?.name || payload.client || undefined,
    };
  }
  return {
    clientId: undefined,
    client:
      typeof payload.client === "string" && payload.client.trim()
        ? payload.client.trim()
        : undefined,
  };
}

async function ensureClientPortalPasswordHashed(clientDoc) {
  if (!clientDoc?.portalPassword) return;
  if (BCRYPT_HASH_REGEX.test(clientDoc.portalPassword)) return;
  clientDoc.portalPassword = await bcrypt.hash(
    String(clientDoc.portalPassword),
    10,
  );
  await clientDoc.save();
}

// ── ACTIVITY LOG ─────────────────────────────────────────────
async function log(text, color, view, user) {
  await Activity.create({
    text,
    color: color || "var(--accent)",
    view: view || "home",
    user,
  });
}

function sanitizeClient(clientDoc) {
  if (!clientDoc) return clientDoc;
  const obj =
    typeof clientDoc.toObject === "function" ? clientDoc.toObject() : clientDoc;
  return { ...obj, portalPassword: undefined };
}

// ═══════════════════════════════════════════════════════════════
// CLIENTS
// ═══════════════════════════════════════════════════════════════
router.get("/clients", auth(["team"]), async (req, res) => {
  try {
    const clients = await Client.find().sort({ name: 1 });
    res.json(clients.map(sanitizeClient));
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

router.get("/clients/:id", auth(["team"]), async (req, res) => {
  try {
    const client = await Client.findById(req.params.id);
    if (!client) return res.status(404).json({ error: "Not found" });
    res.json(sanitizeClient(client));
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

router.post("/clients", auth(["team"]), async (req, res) => {
  try {
    if (!req.body?.name?.trim()) {
      return res.status(400).json({ error: "Client name is required" });
    }

    const normalizedPortalEmail = normalizeEmail(req.body.portalEmail);
    const rawPortalPassword =
      typeof req.body.portalPassword === "string"
        ? req.body.portalPassword.trim()
        : "";
    const hasPortalEmail = Boolean(normalizedPortalEmail);
    const hasPortalPassword = Boolean(rawPortalPassword);
    const hashedPortalPassword = hasPortalPassword
      ? await bcrypt.hash(rawPortalPassword, 10)
      : undefined;

    if (hasPortalEmail !== hasPortalPassword) {
      return res.status(400).json({
        error: "Portal email and portal password must both be provided",
      });
    }
    if (hasPortalEmail && !EMAIL_REGEX.test(normalizedPortalEmail)) {
      return res.status(400).json({ error: "Invalid portal email format" });
    }
    if (hasPortalPassword && !isValidPortalPassword(rawPortalPassword)) {
      return res.status(400).json({
        error: "Portal password must be at least 8 characters",
      });
    }

    if (hasPortalEmail) {
      const exists = await User.findOne({ email: normalizedPortalEmail });
      if (exists) {
        return res
          .status(409)
          .json({ error: "Portal email is already in use by another account" });
      }
    }

    const payload = {
      ...req.body,
      portalEmail: hasPortalEmail ? normalizedPortalEmail : undefined,
    };
    delete payload.portalPassword;

    const client = await Client.create({
      ...payload,
      portalPassword: hashedPortalPassword,
    });
    await ensureClientPortalPasswordHashed(client);

    // Create portal user if email + portalPassword provided
    if (hasPortalEmail && hasPortalPassword) {
      try {
        await User.create({
          email: normalizedPortalEmail,
          passwordHash: hashedPortalPassword,
          role: "client",
          name: client.name,
          clientId: client._id,
        });
      } catch (error) {
        await Client.findByIdAndDelete(client._id);
        throw error;
      }
    }
    await log(
      `Nieuwe klant <strong>${client.name}</strong> toegevoegd`,
      "var(--sage)",
      "klanten",
      req.user.name,
    );
    res.status(201).json(sanitizeClient(client));
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

router.put("/clients/:id", auth(["team"]), async (req, res) => {
  try {
    const existingClient = await Client.findById(req.params.id);
    if (!existingClient) return res.status(404).json({ error: "Not found" });
    const rawPortalPassword =
      typeof req.body.portalPassword === "string"
        ? req.body.portalPassword.trim()
        : "";

    const hasPortalEmailInPayload = hasOwn(req.body, "portalEmail");
    const normalizedPortalEmail = hasPortalEmailInPayload
      ? normalizeEmail(req.body.portalEmail) || ""
      : existingClient.portalEmail || "";
    const hasPortalPasswordInPayload = hasOwn(req.body, "portalPassword");
    const hashedPortalPassword =
      hasPortalPasswordInPayload && rawPortalPassword
        ? await bcrypt.hash(rawPortalPassword, 10)
        : undefined;

    if (
      hasPortalEmailInPayload &&
      normalizedPortalEmail &&
      !EMAIL_REGEX.test(normalizedPortalEmail)
    ) {
      return res.status(400).json({ error: "Invalid portal email format" });
    }
    if (
      hasPortalPasswordInPayload &&
      rawPortalPassword &&
      !isValidPortalPassword(rawPortalPassword)
    ) {
      return res.status(400).json({
        error: "Portal password must be at least 8 characters",
      });
    }
    if (
      (hasPortalEmailInPayload &&
        normalizedPortalEmail &&
        !rawPortalPassword &&
        !existingClient.portalEmail) ||
      (hasPortalPasswordInPayload &&
        rawPortalPassword &&
        !normalizedPortalEmail)
    ) {
      return res.status(400).json({
        error:
          "Portal email and password are both required to create first-time portal credentials",
      });
    }

    if (hasPortalEmailInPayload && normalizedPortalEmail) {
      const conflict = await User.findOne({
        email: normalizedPortalEmail,
        clientId: { $ne: existingClient._id },
      });
      if (conflict) {
        return res
          .status(409)
          .json({ error: "Portal email is already in use by another account" });
      }
    }

    const updatePayload = {
      ...req.body,
    };
    if (hasPortalPasswordInPayload) {
      updatePayload.portalPassword = hashedPortalPassword;
    } else {
      delete updatePayload.portalPassword;
    }
    if (hasPortalEmailInPayload) {
      updatePayload.portalEmail = normalizedPortalEmail || undefined;
    }

    const client = await Client.findByIdAndUpdate(
      req.params.id,
      updatePayload,
      {
        new: true,
      },
    );
    await ensureClientPortalPasswordHashed(client);

    const providedPortalPassword = rawPortalPassword;
    const shouldUpsertPortalUser =
      (hasPortalEmailInPayload && normalizedPortalEmail) ||
      !!providedPortalPassword;

    if (hasPortalEmailInPayload && !normalizedPortalEmail) {
      await User.findOneAndDelete({ clientId: client._id });
    }

    if (shouldUpsertPortalUser) {
      const targetEmail = normalizedPortalEmail || client.portalEmail;
      if (targetEmail) {
        const existingPortalUser = await User.findOne({ clientId: client._id });
        const passwordHash = providedPortalPassword
          ? hashedPortalPassword
          : existingPortalUser?.passwordHash;

        if (!existingPortalUser) {
          if (!passwordHash) {
            return res.status(400).json({
              error:
                "A password is required the first time you create portal login credentials",
            });
          }
          await User.create({
            email: targetEmail,
            passwordHash,
            role: "client",
            name: client.name,
            clientId: client._id,
          });
        } else {
          existingPortalUser.email = targetEmail;
          existingPortalUser.name = client.name;
          if (providedPortalPassword) {
            existingPortalUser.passwordHash = passwordHash;
          }
          await existingPortalUser.save();
        }
      }
    }

    res.json(sanitizeClient(client));
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

router.delete("/clients/:id", auth(["team"]), async (req, res) => {
  try {
    await Client.findByIdAndDelete(req.params.id);
    res.json({ message: "Deleted" });
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

// ═══════════════════════════════════════════════════════════════
// EVENTS (Calendar)
// ═══════════════════════════════════════════════════════════════
router.get("/events", auth(["team"]), async (req, res) => {
  try {
    const events = await Event.find().sort({ date: 1 });
    res.json(events);
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

router.post("/events", auth(["team"]), async (req, res) => {
  try {
    const ev = await Event.create(req.body);
    await log(
      `<strong>${req.user.name}</strong> event toegevoegd: <strong>${ev.name}</strong>`,
      "var(--accent)",
      "agenda",
      req.user.name,
    );
    res.status(201).json(ev);
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

router.put("/events/:id", auth(["team"]), async (req, res) => {
  try {
    const ev = await Event.findByIdAndUpdate(req.params.id, req.body, {
      new: true,
    });
    res.json(ev);
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

router.delete("/events/:id", auth(["team"]), async (req, res) => {
  try {
    await Event.findByIdAndDelete(req.params.id);
    res.json({ message: "Deleted" });
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

// ═══════════════════════════════════════════════════════════════
// TASKS (Kanban)
// ═══════════════════════════════════════════════════════════════
router.get("/tasks", auth(["team"]), async (req, res) => {
  try {
    const tasks = await Task.find({ archived: false }).sort({ createdAt: -1 });
    res.json(tasks);
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

router.get("/tasks/archived", auth(["team"]), async (req, res) => {
  try {
    const filters = { archived: true };
    if (req.query?.clientId) {
      filters.clientId = req.query.clientId;
    }
    const tasks = await Task.find(filters).sort({ archivedAt: -1 });
    res.json(tasks);
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

router.post("/tasks", auth(["team"]), async (req, res) => {
  try {
    const clientFields = await resolveTaskClientFields(req.body);
    const task = await Task.create({
      ...req.body,
      ...clientFields,
    });
    res.status(201).json(task);
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

router.patch("/tasks/:id/column", auth(["team"]), async (req, res) => {
  try {
    const { column } = req.body || {};
    if (!TASK_COLUMNS.includes(column)) {
      return res.status(400).json({ error: "Invalid task column" });
    }

    const task = await Task.findById(req.params.id);
    if (!task) return res.status(404).json({ error: "Task not found" });

    if (task.column === column) {
      return res.json(task);
    }

    task.column = column;
    await task.save();

    await log(
      `<strong>${task.assignee}</strong> taak <strong>${task.title}</strong> naar ${task.column}`,
      "var(--blue)",
      "taken",
      req.user.name,
    );
    res.json(task);
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

router.put("/tasks/:id", auth(["team"]), async (req, res) => {
  try {
    if (
      Object.prototype.hasOwnProperty.call(req.body || {}, "column") &&
      !TASK_COLUMNS.includes(req.body.column)
    ) {
      return res.status(400).json({ error: "Invalid task column" });
    }
    const shouldResolveClient =
      Object.prototype.hasOwnProperty.call(req.body || {}, "clientId") ||
      Object.prototype.hasOwnProperty.call(req.body || {}, "client");
    const resolvedClientFields = shouldResolveClient
      ? await resolveTaskClientFields(req.body)
      : {};

    const task = await Task.findByIdAndUpdate(
      req.params.id,
      {
        ...req.body,
        ...resolvedClientFields,
      },
      {
      new: true,
      },
    );
    if (!task) return res.status(404).json({ error: "Task not found" });
    if (req.body.column) {
      await log(
        `<strong>${task.assignee}</strong> taak <strong>${task.title}</strong> naar ${task.column}`,
        "var(--blue)",
        "taken",
        req.user.name,
      );
    }
    res.json(task);
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

router.post("/tasks/:id/archive", auth(["team"]), async (req, res) => {
  try {
    const archivedReason =
      typeof req.body?.archivedReason === "string" && req.body.archivedReason.trim()
        ? req.body.archivedReason.trim()
        : typeof req.body?.reason === "string" && req.body.reason.trim()
          ? req.body.reason.trim()
          : "manual";

    const task = await Task.findByIdAndUpdate(
      req.params.id,
      {
        archived: true,
        archivedAt: new Date(),
        archivedReason,
      },
      { new: true },
    );
    if (!task) return res.status(404).json({ error: "Task not found" });
    await log(
      `<strong>${req.user.name}</strong> taak <strong>${task.title}</strong> gearchiveerd`,
      "var(--amber)",
      "archief",
      req.user.name,
    );
    res.json(task);
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

router.post("/tasks/:id/restore", auth(["team"]), async (req, res) => {
  try {
    const task = await Task.findByIdAndUpdate(
      req.params.id,
      { archived: false, archivedAt: null, archivedReason: null, column: "todo" },
      { new: true },
    );
    if (!task) return res.status(404).json({ error: "Task not found" });
    res.json(task);
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

// ═══════════════════════════════════════════════════════════════
// WORKSPACE (Batches + Videos)
// ═══════════════════════════════════════════════════════════════
router.get("/batches", auth(["team"]), async (req, res) => {
  try {
    const batches = await Batch.find().sort({ createdAt: -1 });
    res.json(batches);
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

router.post("/batches", auth(["team"]), async (req, res) => {
  try {
    const clientId = await resolveClientIdFromPayload(req.body);
    const batch = await Batch.create({
      ...req.body,
      clientId: clientId || req.body.clientId,
    });
    res.status(201).json(batch);
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

router.put("/batches/:id", auth(["team"]), async (req, res) => {
  try {
    const clientId = await resolveClientIdFromPayload(req.body);
    const batch = await Batch.findByIdAndUpdate(req.params.id, req.body, {
      new: true,
    });
    if (batch && clientId && !batch.clientId) {
      batch.clientId = clientId;
      await batch.save();
    }
    res.json(batch);
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

router.delete("/batches/:id", auth(["team"]), async (req, res) => {
  try {
    await Batch.findByIdAndDelete(req.params.id);
    res.json({ message: "Deleted" });
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

// Add video to batch
router.post("/batches/:id/videos", auth(["team"]), async (req, res) => {
  try {
    const batch = await Batch.findById(req.params.id);
    batch.videos.push(req.body);
    await batch.save();
    res.status(201).json(batch);
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

// Update specific video in batch
router.put(
  "/batches/:batchId/videos/:videoId",
  auth(["team"]),
  async (req, res) => {
    try {
      const batch = await Batch.findById(req.params.batchId);
      const video = batch.videos.id(req.params.videoId);
      if (!video) return res.status(404).json({ error: "Video not found" });

      Object.assign(video, req.body);
      await batch.save();

      // Auto-push to portal when fase = waitreview
      if (req.body.editFase === "waitreview") {
        if (!video.portalPushed) {
          video.portalPushed = true;
          video.revision = false;
          video.revisionNote = "";
          video.approved = false;
          video.approvedAt = null;
          await batch.save();
        }

        const targetClientId = batch.clientId || (await resolveClientIdFromPayload(batch));
        const client = targetClientId ? await Client.findById(targetClientId) : null;
        if (client) {
          const existingPushNote = await Note.findOne({
            clientId: client._id,
            from: "studio",
            text: `Video "${video.name}" staat klaar voor jouw beoordeling.`,
          }).sort({ createdAt: -1 });
          const recentDuplicate =
            existingPushNote &&
            Date.now() - new Date(existingPushNote.createdAt).getTime() <
              60 * 1000;
          if (!recentDuplicate) {
            await Note.create({
              clientId: client._id,
              from: "studio",
              author: "Team · 4REEL",
              text: `Video "${video.name}" staat klaar voor jouw beoordeling.`,
            });
          }
          await log(
            `Video <strong>${video.name}</strong> naar klantportaal gestuurd`,
            "var(--accent)",
            "workspace",
            req.user.name,
          );
        }
      }

      res.json(batch);
    } catch (e) {
      res.status(500).json({ error: e.message });
    }
  },
);

// Delete video from batch
router.delete(
  "/batches/:batchId/videos/:videoId",
  auth(["team"]),
  async (req, res) => {
    try {
      const batch = await Batch.findById(req.params.batchId);
      batch.videos.pull({ _id: req.params.videoId });
      await batch.save();
      res.json(batch);
    } catch (e) {
      res.status(500).json({ error: e.message });
    }
  },
);

// ═══════════════════════════════════════════════════════════════
// PORTAL (team-side read/write for portal tab in klanten)
// ═══════════════════════════════════════════════════════════════
router.get("/portal/:clientId/notes", auth(["team"]), async (req, res) => {
  try {
    const notes = await Note.find({ clientId: req.params.clientId }).sort({
      createdAt: 1,
    });
    res.json(notes);
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

router.post("/portal/:clientId/notes", auth(["team"]), async (req, res) => {
  try {
    const note = await Note.create({
      clientId: req.params.clientId,
      from: "studio",
      author: req.body.author || `${req.user.name} · 4REEL`,
      text: req.body.text,
    });
    res.status(201).json(note);
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

router.get("/portal/:clientId/videos", auth(["team"]), async (req, res) => {
  try {
    const batches = await Batch.find({ clientId: req.params.clientId });
    const reviewVideos = [];
    batches.forEach((b) => {
      b.videos.forEach((v) => {
        if (
          ["waitreview", "client_review", "client_revision"].includes(
            v.editFase,
          )
        ) {
          reviewVideos.push({
            ...v.toObject(),
            frameUrl: v.export || "",
            driveUrl: v.assets || "",
            batchName: b.name,
            batchId: b._id,
          });
        }
      });
    });
    res.json(reviewVideos);
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

router.get("/portal/unread-summary", auth(["team"]), async (req, res) => {
  try {
    const rows = await Note.aggregate([
      { $match: { from: "client", read: false } },
      { $group: { _id: "$clientId", unread: { $sum: 1 } } },
    ]);

    const byClient = {};
    let totalUnread = 0;
    rows.forEach((row) => {
      const key = String(row._id);
      byClient[key] = row.unread;
      totalUnread += row.unread;
    });

    res.json({ byClient, totalUnread });
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

// Mark notes as read
router.post(
  "/portal/:clientId/notes/read",
  auth(["team"]),
  async (req, res) => {
    try {
      await Note.updateMany(
        { clientId: req.params.clientId, from: "client", read: false },
        { read: true },
      );
      res.json({ message: "Marked as read" });
    } catch (e) {
      res.status(500).json({ error: e.message });
    }
  },
);

// ═══════════════════════════════════════════════════════════════
// CLIENT PORTAL ROUTES (authenticated as client)
// ═══════════════════════════════════════════════════════════════
router.get("/portal/me", auth(["client"]), async (req, res) => {
  try {
    if (!req.user.clientId) {
      return res
        .status(403)
        .json({ error: "Client access requires a linked client account" });
    }
    const client = await Client.findById(req.user.clientId);
    if (!client) return res.status(404).json({ error: "Client not found" });

    const notes = await Note.find({ clientId: client._id }).sort({
      createdAt: 1,
    });
    const batches = await Batch.find({ clientId: client._id });

    const reviewVideos = [];
    const deliveredBatches = [];
    batches.forEach((b) => {
      const rv = b.videos.filter((v) =>
        ["waitreview", "client_review", "client_revision"].includes(v.editFase),
      );
      const dv = b.videos.filter((v) => v.approved);
      rv.forEach((v) =>
        reviewVideos.push({
          ...v.toObject(),
          frameUrl: v.export || "",
          driveUrl: v.assets || "",
          batchName: b.name,
        }),
      );
      if (dv.length)
        deliveredBatches.push({
          name: b.name,
          date: b.createdAt,
          videos: dv.map((v) => ({ name: v.name, driveUrl: v.assets || "" })),
        });
    });

    const questionnaire = await Questionnaire.findOne({ clientId: client._id });

    res.json({
      client: { ...client.toObject(), portalPassword: undefined },
      notes,
      reviewVideos,
      deliveredBatches,
      questionnaire: questionnaire
        ? {
            submitted: questionnaire.submitted,
            openedAt: questionnaire.openedAt,
          }
        : null,
      retainer: client.retainer?.zichtbaarInPortaal ? client.retainer : null,
    });
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

// Client sends a note
router.post("/portal/me/notes", auth(["client"]), async (req, res) => {
  try {
    const client = await Client.findById(req.user.clientId);
    const note = await Note.create({
      clientId: req.user.clientId,
      from: "client",
      author: client.name,
      text: req.body.text,
    });
    res.status(201).json(note);
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

// Client approves video
router.post(
  "/portal/me/videos/:videoId/approve",
  auth(["client"]),
  async (req, res) => {
    try {
      const batches = await Batch.find({ clientId: req.user.clientId });
      for (const batch of batches) {
        const video = batch.videos.id(req.params.videoId);
        if (video) {
          video.approved = true;
          video.approvedAt = new Date();
          video.editFase = "client_approved";
          await batch.save();
          // Notify studio
          const client = await Client.findById(req.user.clientId);
          await Note.create({
            clientId: req.user.clientId,
            from: "client",
            author: client.name,
            text: `Goedgekeurd: "${video.name}"`,
          });
          return res.json({ message: "Approved", video });
        }
      }
      res.status(404).json({ error: "Video not found" });
    } catch (e) {
      res.status(500).json({ error: e.message });
    }
  },
);

// Client requests revision
router.post(
  "/portal/me/videos/:videoId/revision",
  auth(["client"]),
  async (req, res) => {
    try {
      const note =
        typeof req.body?.note === "string" ? req.body.note.trim() : "";
      if (!note) {
        return res.status(400).json({ error: "Revision note is required" });
      }
      const batches = await Batch.find({ clientId: req.user.clientId });
      for (const batch of batches) {
        const video = batch.videos.id(req.params.videoId);
        if (video) {
          video.revision = true;
          video.revisionNote = note;
          video.editFase = "client_revision";
          await batch.save();
          const client = await Client.findById(req.user.clientId);
          await Note.create({
            clientId: req.user.clientId,
            from: "client",
            author: client.name,
            text: `Revisie voor "${video.name}": ${note}`,
          });
          return res.json({ message: "Revision requested", video });
        }
      }
      res.status(404).json({ error: "Video not found" });
    } catch (e) {
      res.status(500).json({ error: e.message });
    }
  },
);

// ═══════════════════════════════════════════════════════════════
// QUESTIONNAIRE
// ═══════════════════════════════════════════════════════════════
router.get("/questionnaire/:clientId", auth(["team"]), async (req, res) => {
  try {
    const q = await Questionnaire.findOne({ clientId: req.params.clientId });
    res.json(q);
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

router.post("/questionnaire/me", auth(["client"]), async (req, res) => {
  try {
    const { answers, submitted } = req.body;
    let q = await Questionnaire.findOne({ clientId: req.user.clientId });
    if (!q) {
      q = new Questionnaire({
        clientId: req.user.clientId,
        openedAt: new Date(),
      });
    }
    q.answers = answers;
    if (submitted) {
      q.submitted = true;
      q.submittedAt = new Date();
      // Notify team
      const client = await Client.findById(req.user.clientId);
      await Note.create({
        clientId: req.user.clientId,
        from: "client",
        author: client.name,
        text: "Onboarding vragenlijst ingevuld en verzonden!",
      });
    }
    await q.save();
    res.json(q);
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

// ═══════════════════════════════════════════════════════════════
// ACTIVITY FEED
// ═══════════════════════════════════════════════════════════════
router.get("/activity", auth(["team"]), async (req, res) => {
  try {
    const activities = await Activity.find().sort({ createdAt: -1 }).limit(20);
    res.json(activities);
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

// ═══════════════════════════════════════════════════════════════
// STUDIO PULSE (aggregated stats)
// ═══════════════════════════════════════════════════════════════
router.get("/pulse", auth(["team"]), async (req, res) => {
  try {
    const [clients, tasks, archivedTasks, batches, events] = await Promise.all([
      Client.find(),
      Task.find({ archived: false }),
      Task.find({ archived: true }),
      Batch.find(),
      Event.find(),
    ]);

    const now = new Date();
    const monthLabels = [
      "jan",
      "feb",
      "mrt",
      "apr",
      "mei",
      "jun",
      "jul",
      "aug",
      "sep",
      "okt",
      "nov",
      "dec",
    ];
    const thisMonth = now.getMonth();
    const thisYear = now.getFullYear();
    const allVideos = batches.flatMap((b) => b.videos.map((v) => ({ v, b })));

    const pipelineCounts = {};
    allVideos.forEach(({ v }) => {
      pipelineCounts[v.editFase] = (pipelineCounts[v.editFase] || 0) + 1;
    });

    const editorLoad = {};
    allVideos.forEach(({ v, b }) => {
      const ed = b.editor;
      if (!ed) return;
      if (!editorLoad[ed]) editorLoad[ed] = { active: 0, reviewing: 0 };
      if (["inprogress", "intern_review"].includes(v.editFase))
        editorLoad[ed].active++;
      if (["inprogress", "waitreview", "client_review", "client_revision"].includes(v.editFase))
        editorLoad[ed].reviewing++;
    });

    const notStarted =
      (pipelineCounts.tentative || 0) + (pipelineCounts.spotting || 0);
    const inEdit = (pipelineCounts.ready || 0) + (pipelineCounts.inprogress || 0);
    const inReview =
      (pipelineCounts.waitreview || 0) +
      (pipelineCounts.client_review || 0) +
      (pipelineCounts.client_revision || 0) +
      (pipelineCounts.uploaddrive || 0);
    const delivered = pipelineCounts.finished || 0;

    const shootsThisMonth = events.filter((e) => {
      if (e.type !== "Shoot") return false;
      const dt = new Date(e.date);
      if (Number.isNaN(dt.getTime())) return false;
      return dt.getMonth() === thisMonth && dt.getFullYear() === thisYear;
    }).length;

    const urgentDeadlines = [];
    batches.forEach((b) => {
      if (!b.deadline) return;
      const deadlineDate = new Date(b.deadline);
      if (Number.isNaN(deadlineDate.getTime())) return;
      const diffDays = Math.ceil((deadlineDate.getTime() - now.getTime()) / 86400000);
      if (diffDays < 0 || diffDays > 7) return;
      const openVideos = (b.videos || []).filter((v) => v.editFase !== "finished").length;
      if (!openVideos) return;
      urgentDeadlines.push({
        name: b.name,
        client: b.client,
        days: diffDays,
        open: openVideos,
      });
    });

    const deliveredMonth = archivedTasks.filter((t) => {
      if (t.archivedReason !== "delivered") return false;
      const dt = t.archivedAt ? new Date(t.archivedAt) : null;
      if (!dt || Number.isNaN(dt.getTime())) return false;
      return dt.getMonth() === thisMonth && dt.getFullYear() === thisYear;
    }).length;

    const monthlyDelivered = {};
    for (let i = 5; i >= 0; i -= 1) {
      const d = new Date(thisYear, thisMonth - i, 1);
      const key = `${monthLabels[d.getMonth()]} ${d.getFullYear()}`;
      monthlyDelivered[key] = 0;
    }

    archivedTasks.forEach((t) => {
      const dt = t.archivedAt ? new Date(t.archivedAt) : null;
      if (!dt || Number.isNaN(dt.getTime())) return;
      const key = `${monthLabels[dt.getMonth()]} ${dt.getFullYear()}`;
      if (Object.prototype.hasOwnProperty.call(monthlyDelivered, key)) {
        monthlyDelivered[key] += 1;
      }
    });

    allVideos
      .filter(({ v }) => v.editFase === "finished")
      .forEach(() => {
        const key = `${monthLabels[thisMonth]} ${thisYear}`;
        if (Object.prototype.hasOwnProperty.call(monthlyDelivered, key)) {
          monthlyDelivered[key] += 1;
        }
      });

    const clientStats = clients.map((c) => {
      const clientBatches = batches.filter((b) => {
        if (b.clientId && String(b.clientId) === String(c._id)) return true;
        return b.client && b.client === c.name;
      });
      const videoCount = clientBatches.reduce(
        (sum, b) => sum + ((b.videos && b.videos.length) || 0),
        0,
      );
      return {
        _id: c._id,
        name: c.name,
        urgent: !!c.urgent,
        batchCount: clientBatches.length,
        videoCount,
      };
    });

    res.json({
      totalClients: clients.length,
      urgentClients: clients.filter((c) => c.urgent).length,
      batchesActive: batches.length,
      totalVideos: allVideos.length,
      notStarted,
      inEdit,
      inReview,
      finished: delivered,
      inProgress: pipelineCounts.inprogress || 0,
      shootsThisMonth,
      shootsPlanned: events.filter(
        (e) => e.type === "Shoot" && new Date(e.date) >= now,
      ).length,
      deliveredMonth,
      openTasks: tasks.filter((t) => t.column !== "klaar").length,
      monthlyDelivered,
      clients: clientStats,
      pipelineCounts,
      editorLoad,
      urgentDeadlines,
    });
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

// ═══════════════════════════════════════════════════════════════
// VIDEO CHECKER
// ═══════════════════════════════════════════════════════════════
router.post("/checker/analyze", auth(["team"]), async (req, res) => {
  try {
    const text = typeof req.body?.text === "string" ? req.body.text.trim() : "";
    const language = LT_LANG_MAP[req.body?.language] || "nl-NL";
    const mode =
      typeof req.body?.mode === "string" ? req.body.mode : "spelling";

    if (!text) {
      return res.json({ errors: [] });
    }

    const params = new URLSearchParams();
    params.set("text", text);
    params.set("language", language);
    params.set("enabledOnly", "false");

    if (mode === "spelling") {
      params.set("enabledCategories", "TYPOS");
    } else if (mode === "spelling+grammar") {
      params.set("enabledCategories", "TYPOS,GRAMMAR");
    }

    const ltRes = await fetch("https://api.languagetool.org/v2/check", {
      method: "POST",
      headers: { "Content-Type": "application/x-www-form-urlencoded" },
      body: params.toString(),
    });

    if (!ltRes.ok) {
      return res.status(502).json({ error: "LanguageTool request failed" });
    }

    const data = await ltRes.json();
    const errors = (data.matches || []).map((m) => ({
      wrong: text.slice(m.offset, m.offset + m.length),
      suggestion: m.replacements?.[0]?.value || "",
      message: m.message || "",
      offset: m.offset,
      length: m.length,
      ruleId: m.rule?.id || "",
    }));

    res.json({ errors });
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

module.exports = router;
