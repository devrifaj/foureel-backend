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

// ── ACTIVITY LOG ─────────────────────────────────────────────
async function log(text, color, view, user) {
  await Activity.create({
    text,
    color: color || "var(--accent)",
    view: view || "home",
    user,
  });
}

// ═══════════════════════════════════════════════════════════════
// CLIENTS
// ═══════════════════════════════════════════════════════════════
router.get("/clients", auth(["team"]), async (req, res) => {
  try {
    const clients = await Client.find().sort({ name: 1 });
    res.json(clients);
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

router.get("/clients/:id", auth(["team"]), async (req, res) => {
  try {
    const client = await Client.findById(req.params.id);
    if (!client) return res.status(404).json({ error: "Not found" });
    res.json(client);
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

router.post("/clients", auth(["team"]), async (req, res) => {
  try {
    const client = await Client.create(req.body);
    // Create portal user if email + portalPassword provided
    if (req.body.portalEmail && req.body.portalPassword) {
      await User.create({
        email: req.body.portalEmail,
        passwordHash: await bcrypt.hash(req.body.portalPassword, 10),
        role: "client",
        name: client.name,
        clientId: client._id,
      });
    }
    await log(
      `Nieuwe klant <strong>${client.name}</strong> toegevoegd`,
      "var(--sage)",
      "klanten",
      req.user.name,
    );
    res.status(201).json(client);
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

router.put("/clients/:id", auth(["team"]), async (req, res) => {
  try {
    const client = await Client.findByIdAndUpdate(req.params.id, req.body, {
      new: true,
    });
    res.json(client);
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
    const tasks = await Task.find({ archived: true }).sort({ archivedAt: -1 });
    res.json(tasks);
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

router.post("/tasks", auth(["team"]), async (req, res) => {
  try {
    const task = await Task.create(req.body);
    res.status(201).json(task);
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

router.put("/tasks/:id", auth(["team"]), async (req, res) => {
  try {
    const task = await Task.findByIdAndUpdate(req.params.id, req.body, {
      new: true,
    });
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
    const task = await Task.findByIdAndUpdate(
      req.params.id,
      {
        archived: true,
        archivedAt: new Date(),
        archiveReason: req.body.reason || "completed",
      },
      { new: true },
    );
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
      { archived: false, archivedAt: null, column: "todo" },
      { new: true },
    );
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
    const batch = await Batch.create(req.body);
    res.status(201).json(batch);
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

router.put("/batches/:id", auth(["team"]), async (req, res) => {
  try {
    const batch = await Batch.findByIdAndUpdate(req.params.id, req.body, {
      new: true,
    });
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
        const client = await Client.findById(batch.clientId);
        if (client) {
          await Note.create({
            clientId: client._id,
            from: "studio",
            author: "Team · 4REEL",
            text: `Video "${video.name}" staat klaar voor jouw beoordeling.`,
          });
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
      const { note } = req.body;
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
    const [clients, tasks, batches, events] = await Promise.all([
      Client.find(),
      Task.find({ archived: false }),
      Batch.find(),
      Event.find(),
    ]);

    const now = new Date();
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
      if (["waitreview", "client_review", "feedbackrdy"].includes(v.editFase))
        editorLoad[ed].reviewing++;
    });

    res.json({
      totalClients: clients.length,
      urgentClients: clients.filter((c) => c.urgent).length,
      totalVideos: allVideos.length,
      inReview:
        (pipelineCounts.waitreview || 0) + (pipelineCounts.client_review || 0),
      finished: pipelineCounts.finished || 0,
      inProgress: pipelineCounts.inprogress || 0,
      shootsPlanned: events.filter(
        (e) => e.type === "Shoot" && new Date(e.date) >= now,
      ).length,
      openTasks: tasks.filter((t) => t.column !== "klaar").length,
      pipelineCounts,
      editorLoad,
    });
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

module.exports = router;
