const express = require("express");
const mongoose = require("mongoose");
const bcrypt = require("bcryptjs");
const crypto = require("crypto");
const { PutObjectCommand } = require("@aws-sdk/client-s3");
const { getSignedUrl } = require("@aws-sdk/s3-request-presigner");
const {
  Client,
  Event,
  Task,
  Batch,
  Workspace,
  Note,
  Questionnaire,
  Activity,
  User,
  FrameWebhookEvent,
  VideoCheckerRun,
} = require("../models");
const s3 = require("../lib/s3");
const {
  readAwsCheckerEnv,
  hasBucketAndRegion,
  hasSigningCredentials,
} = require("../config/awsEnv");
const auth = require("../middleware/auth");

const router = express.Router();
const TEAM_ALL_ACCESS = {
  roles: ["team"],
  teamAccessLevels: ["admin", "editor"],
};
const EMAIL_REGEX = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;
const TASK_COLUMNS = ["todo", "bezig", "review", "klaar"];
const BCRYPT_HASH_REGEX = /^\$2[aby]\$\d{2}\$/;
const LT_LANG_MAP = {
  nl: "nl-NL",
  en: "en-US",
  "nl+en": "auto",
};
const WHATSAPP_IMAGE_CONTENT_TYPES = new Set([
  "image/jpeg",
  "image/png",
  "image/webp",
  "image/heic",
  "image/heif",
]);
const WHATSAPP_MAX_FILE_BYTES = 15 * 1024 * 1024;
const REQUIRED_QUESTIONNAIRE_FIELDS = [
  { key: "intro_beschrijving", type: "textarea" },
  { key: "intro_diensten", type: "textarea" },
  { key: "intro_usps", type: "textarea" },
  { key: "intro_positionering", type: "radio" },
  { key: "dg_resultaten", type: "textarea" },
  { key: "dg_frustraties", type: "textarea" },
  { key: "dg_minder_focus", type: "textarea" },
  { key: "dg_ideaal", type: "textarea" },
  { key: "dg_doel", type: "textarea" },
  { key: "cs_strategie", type: "radio" },
  { key: "cs_onderwerpen", type: "textarea" },
  { key: "cs_boodschap", type: "textarea" },
  { key: "cs_inspiratie", type: "textarea" },
  { key: "cs_type", type: "checkbox" },
  { key: "cs_stijl", type: "checkbox" },
  { key: "cs_transformaties", type: "textarea" },
  { key: "cs_vermijden", type: "textarea" },
  { key: "cs_ads", type: "radio" },
  { key: "cs_verkopen", type: "textarea" },
  { key: "cs_pijnpunten", type: "textarea" },
  { key: "pr_opnames", type: "textarea" },
  { key: "pr_filmen_ok", type: "radio" },
  { key: "pr_camera", type: "textarea" },
  { key: "pr_start", type: "radio" },
  { key: "af_brandbook", type: "radio" },
  { key: "af_meta", type: "radio" },
  { key: "af_email", type: "email" },
  { key: "af_extra", type: "textarea" },
];
const FRAMEIO_SIGNATURE_HEADER = "x-frameio-signature";
const FRAMEIO_TIMESTAMP_HEADER = "x-frameio-request-timestamp";

function getFrameReviewUrl(video) {
  if (!video) return "";
  return (
    (typeof video.frameReviewUrl === "string" && video.frameReviewUrl.trim()) ||
    (typeof video.export === "string" && video.export.trim()) ||
    ""
  );
}

function buildPortalReviewVideo(video, extra = {}) {
  return {
    ...video.toObject(),
    frameUrl: getFrameReviewUrl(video),
    driveUrl: video.assets || "",
    ...extra,
  };
}

function buildFrameReviewPushText(videoName, frameUrl) {
  const safeName = videoName || "Video";
  if (frameUrl) {
    return `Video "${safeName}" staat klaar voor jouw beoordeling.\nFrame.io: ${frameUrl}`;
  }
  return `Video "${safeName}" staat klaar voor jouw beoordeling.`;
}

function parseFrameOutcome(payload = {}) {
  const eventType = String(
    payload.event || payload.type || payload.action || "",
  ).toLowerCase();
  const status = String(
    payload.status || payload.reviewStatus || payload.approval || "",
  ).toLowerCase();
  const decision = String(
    payload.decision || payload.result || payload.outcome || "",
  ).toLowerCase();
  const merged = `${eventType} ${status} ${decision}`;
  if (/(approve|approved|accept)/.test(merged)) return "approved";
  if (
    /(revision|revise|changes_requested|changes-requested|request_changes|requested_changes|reject|rejected)/.test(
      merged,
    )
  ) {
    return "revision";
  }
  return "";
}

function getFrameAssetIdFromPayload(payload = {}) {
  const candidates = [
    payload?.resource?.id,
    payload?.resource?.asset_id,
    payload?.resource?.assetId,
    payload?.asset?.id,
    payload?.asset?.asset_id,
    payload?.assetId,
    payload?.asset_id,
    payload?.data?.asset?.id,
    payload?.data?.asset_id,
    payload?.data?.assetId,
  ];
  for (const item of candidates) {
    if (typeof item === "string" && item.trim()) return item.trim();
  }
  return "";
}

function getFrameEventIdFromPayload(payload = {}) {
  const candidates = [
    payload.id,
    payload.event_id,
    payload.eventId,
    payload.delivery_id,
    payload.deliveryId,
  ];
  for (const item of candidates) {
    if (typeof item === "string" && item.trim()) return item.trim();
  }
  return "";
}

function getFrameRevisionNote(payload = {}) {
  const candidates = [
    payload?.comment?.text,
    payload?.comment,
    payload?.message,
    payload?.note,
    payload?.reason,
    payload?.data?.comment?.text,
    payload?.data?.comment,
  ];
  for (const item of candidates) {
    if (typeof item === "string" && item.trim())
      return item.trim().slice(0, 1000);
  }
  return "Revision requested via Frame.io";
}

function normalizeVideoFrameFields(input = {}) {
  const payload = { ...input };
  const frameAssetId =
    typeof payload.frameAssetId === "string" ? payload.frameAssetId.trim() : "";
  const frameReviewUrl =
    typeof payload.frameReviewUrl === "string"
      ? payload.frameReviewUrl.trim()
      : typeof payload.frameUrl === "string"
        ? payload.frameUrl.trim()
        : "";
  if (
    frameAssetId ||
    Object.prototype.hasOwnProperty.call(payload, "frameAssetId")
  ) {
    payload.frameAssetId = frameAssetId || undefined;
  }
  if (
    frameReviewUrl ||
    Object.prototype.hasOwnProperty.call(payload, "frameReviewUrl") ||
    Object.prototype.hasOwnProperty.call(payload, "frameUrl")
  ) {
    payload.frameReviewUrl = frameReviewUrl || undefined;
  }
  if (Object.prototype.hasOwnProperty.call(payload, "frameUrl")) {
    delete payload.frameUrl;
  }
  return payload;
}

function isQuestionnaireAnswerFilled(value, type) {
  if (type === "checkbox") return Array.isArray(value) && value.length > 0;
  return typeof value === "string" && value.trim().length > 0;
}

function getMissingQuestionnaireFields(answers) {
  const source = answers && typeof answers === "object" ? answers : {};
  return REQUIRED_QUESTIONNAIRE_FIELDS.filter(
    (field) => !isQuestionnaireAnswerFilled(source[field.key], field.type),
  ).map((field) => field.key);
}

function compareTaskOrder(left, right) {
  const leftHasOrder = Number.isFinite(left?.sortOrder);
  const rightHasOrder = Number.isFinite(right?.sortOrder);
  if (leftHasOrder && rightHasOrder) {
    if (left.sortOrder !== right.sortOrder)
      return left.sortOrder - right.sortOrder;
  } else if (leftHasOrder !== rightHasOrder) {
    return leftHasOrder ? -1 : 1;
  }
  const leftCreatedAt = new Date(left?.createdAt || 0).getTime();
  const rightCreatedAt = new Date(right?.createdAt || 0).getTime();
  if (leftCreatedAt !== rightCreatedAt) return leftCreatedAt - rightCreatedAt;
  return String(left?._id || "").localeCompare(String(right?._id || ""));
}

function sanitizeTaskChecklist(value) {
  if (!Array.isArray(value)) return undefined;
  return value
    .map((item) => ({
      text: typeof item?.text === "string" ? item.text.trim() : "",
      done: Boolean(item?.done),
    }))
    .filter((item) => item.text);
}

function sanitizeTaskLinks(value) {
  if (!Array.isArray(value)) return undefined;
  return value
    .map((item) => {
      const label = typeof item?.label === "string" ? item.label.trim() : "";
      const url = typeof item?.url === "string" ? item.url.trim() : "";
      return {
        label: label || url,
        url,
      };
    })
    .filter((item) => /^https?:\/\//i.test(item.url));
}

function sanitizeTaskComments(value) {
  if (!Array.isArray(value)) return undefined;
  return value
    .map((item) => {
      const text = typeof item?.text === "string" ? item.text.trim() : "";
      const author = typeof item?.author === "string" ? item.author.trim() : "";
      const parsedDate = item?.createdAt ? new Date(item.createdAt) : null;
      return {
        text,
        author: author || "Team",
        createdAt:
          parsedDate && !Number.isNaN(parsedDate.getTime())
            ? parsedDate
            : new Date(),
      };
    })
    .filter((item) => item.text);
}

function normalizeEmail(value) {
  return typeof value === "string" ? value.trim().toLowerCase() : "";
}

function isValidPortalPassword(password) {
  return typeof password === "string" && password.trim().length >= 8;
}

/** Dev stub until real transactional email is wired up. */
function logPortalAccessEmailStub(payload) {
  const {
    to,
    clientName,
    event,
    changedEmail,
    changedPassword,
    previousEmail,
  } = payload;
  const parts = [
    "[PORTAL EMAIL STUB — replace with real mailer]",
    `To: ${to}`,
    `Client: ${clientName || "—"}`,
    `Event: ${event}`,
  ];
  if (previousEmail && previousEmail !== to) {
    parts.push(`Previous login email: ${previousEmail}`);
  }
  parts.push(`Login email (after save): ${changedEmail || to}`);
  parts.push(
    changedPassword
      ? "Password: was set or changed (value not logged)."
      : "Password: unchanged.",
  );
  console.log(parts.join("\n"));
}

function hasOwn(obj, key) {
  return Object.prototype.hasOwnProperty.call(obj, key);
}

function normalizeResourceItem(item = {}) {
  return {
    name: typeof item?.name === "string" ? item.name.trim() : "",
    note: typeof item?.note === "string" ? item.note.trim() : "",
    status: typeof item?.status === "string" ? item.status.trim() : "",
  };
}

function isEditorAllowedWorkspaceUpdate(existingWorkspace, payload = {}) {
  const keys = Object.keys(payload || {});
  if (keys.length !== 1 || keys[0] !== "resources") return false;
  const currentResources = existingWorkspace?.resources?.toObject
    ? existingWorkspace.resources.toObject()
    : existingWorkspace?.resources || {};
  const nextResources = payload.resources || {};
  const tabs = [
    "scripts",
    "props",
    "cast",
    "shotlist",
    "moodboard",
    "interview",
  ];

  return tabs.every((tab) => {
    const currentListRaw = Array.isArray(currentResources[tab])
      ? currentResources[tab]
      : [];
    const nextListRaw = Array.isArray(nextResources[tab])
      ? nextResources[tab]
      : [];
    const currentList = currentListRaw.map(normalizeResourceItem);
    const nextList = nextListRaw.map(normalizeResourceItem);
    if (nextList.length < currentList.length) return false;
    for (let i = 0; i < currentList.length; i += 1) {
      const current = currentList[i];
      const next = nextList[i];
      if (
        !next ||
        next.name !== current.name ||
        next.note !== current.note ||
        next.status !== current.status
      ) {
        return false;
      }
    }
    for (let i = currentList.length; i < nextList.length; i += 1) {
      if (!nextList[i].name) return false;
    }
    return true;
  });
}

function safeClientDocumentFilename(name) {
  const raw = typeof name === "string" ? name : "document";
  const base = raw.replace(/[^a-zA-Z0-9._-]/g, "_").slice(0, 180);
  return base || "document.bin";
}

function clientDocumentObjectUrl(bucket, region, key) {
  const path = key
    .split("/")
    .map((seg) => encodeURIComponent(seg))
    .join("/");
  return `https://${bucket}.s3.${region}.amazonaws.com/${path}`;
}

function safeWhatsappFilename(name) {
  const raw = typeof name === "string" ? name : "whatsapp-image";
  const base = raw.replace(/[^a-zA-Z0-9._-]/g, "_").slice(0, 180);
  return base || "whatsapp-image.bin";
}

function isAllowedWhatsappImageContentType(contentType) {
  if (typeof contentType !== "string") return false;
  return WHATSAPP_IMAGE_CONTENT_TYPES.has(contentType.trim().toLowerCase());
}

function normalizeClientContacts(rawContacts = [], fallback = {}) {
  const normalized = (Array.isArray(rawContacts) ? rawContacts : [])
    .map((contact) => ({
      name: typeof contact?.name === "string" ? contact.name.trim() : "",
      email: normalizeEmail(contact?.email),
      phone: typeof contact?.phone === "string" ? contact.phone.trim() : "",
      role: typeof contact?.role === "string" ? contact.role.trim() : "",
      primary: Boolean(contact?.primary),
    }))
    .filter(
      (contact) =>
        contact.name || contact.email || contact.phone || contact.role,
    );

  const fallbackContact = {
    name: typeof fallback.contact === "string" ? fallback.contact.trim() : "",
    email: normalizeEmail(fallback.email),
    phone: typeof fallback.phone === "string" ? fallback.phone.trim() : "",
    role: "",
    primary: true,
  };
  const hasFallbackValues = Boolean(
    fallbackContact.name || fallbackContact.email || fallbackContact.phone,
  );

  if (normalized.length === 0 && hasFallbackValues) {
    normalized.push(fallbackContact);
  }

  if (normalized.length > 0 && !normalized.some((contact) => contact.primary)) {
    normalized[0].primary = true;
  }

  return normalized;
}

function withLegacyClientContactFields(payload = {}) {
  const contacts = normalizeClientContacts(payload.contacts, payload);
  const primary = contacts.find((contact) => contact.primary) || contacts[0];
  return {
    ...payload,
    contacts,
    contact: primary?.name || undefined,
    email: primary?.email || undefined,
    phone: primary?.phone || undefined,
  };
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
  const contacts = normalizeClientContacts(obj.contacts, obj);
  const primary = contacts.find((contact) => contact.primary) || contacts[0];
  return {
    ...obj,
    contacts,
    contact: primary?.name || obj.contact || undefined,
    email: primary?.email || obj.email || undefined,
    phone: primary?.phone || obj.phone || undefined,
    portalPassword: undefined,
  };
}

function verifyFrameWebhookSignature(req) {
  const secret =
    typeof process.env.FRAMEIO_WEBHOOK_SECRET === "string"
      ? process.env.FRAMEIO_WEBHOOK_SECRET.trim()
      : "";
  if (!secret) return false;
  const signature = req.get(FRAMEIO_SIGNATURE_HEADER);
  if (!signature) return false;
  const rawBody =
    typeof req.rawBody === "string" && req.rawBody.length
      ? req.rawBody
      : JSON.stringify(req.body || {});
  const digest = crypto
    .createHmac("sha256", secret)
    .update(rawBody)
    .digest("hex");
  const computed = `sha256=${digest}`;
  try {
    return crypto.timingSafeEqual(
      Buffer.from(signature),
      Buffer.from(computed),
    );
  } catch {
    return false;
  }
}

async function applyFrameFeedbackToBatchVideo({
  batch,
  video,
  clientId,
  outcome,
  revisionNote,
  eventId,
  eventAt,
}) {
  if (outcome === "approved") {
    video.approved = true;
    video.approvedAt = eventAt;
    video.revision = false;
    video.revisionNote = "";
    video.editFase = "client_approved";
  } else {
    video.revision = true;
    video.revisionNote = revisionNote;
    video.approved = false;
    video.approvedAt = null;
    video.editFase = "client_revision";
  }
  video.frameLastEventId = eventId || undefined;
  video.frameLastEventAt = eventAt;
  await batch.save();

  const client = await Client.findById(clientId).select("name");
  await Note.create({
    clientId,
    from: "client",
    author: client?.name || "Client",
    text:
      outcome === "approved"
        ? `Goedgekeurd via Frame.io: "${video.name}"`
        : `Revisie via Frame.io voor "${video.name}": ${revisionNote}`,
  });
}

// Frame.io webhook (server-to-server)
router.post("/webhooks/frameio", async (req, res) => {
  try {
    if (!verifyFrameWebhookSignature(req)) {
      return res.status(401).json({ error: "Invalid Frame.io signature" });
    }

    const payload = req.body || {};
    const eventId = getFrameEventIdFromPayload(payload);
    const frameAssetId = getFrameAssetIdFromPayload(payload);
    const outcome = parseFrameOutcome(payload);
    const requestTs = req.get(FRAMEIO_TIMESTAMP_HEADER);
    const eventAt =
      requestTs && Number.isFinite(Number(requestTs))
        ? new Date(Number(requestTs) * 1000)
        : new Date();

    if (!eventId || !frameAssetId || !outcome) {
      return res.status(202).json({
        message: "Ignored webhook event",
        reason: "missing_event_id_or_asset_or_outcome",
      });
    }

    const existingEvent = await FrameWebhookEvent.findOne({ eventId }).select(
      "_id",
    );
    if (existingEvent) {
      return res.json({ message: "Already processed" });
    }

    const revisionNote = getFrameRevisionNote(payload);
    let handled = false;

    const batches = await Batch.find({ "videos.frameAssetId": frameAssetId });
    for (const batch of batches) {
      const video = batch.videos.find(
        (item) => String(item.frameAssetId || "") === frameAssetId,
      );
      if (!video) continue;
      const clientId =
        batch.clientId || (await resolveClientIdFromPayload(batch));
      if (!clientId) continue;
      await applyFrameFeedbackToBatchVideo({
        batch,
        video,
        clientId,
        outcome,
        revisionNote,
        eventId,
        eventAt,
      });
      handled = true;
      break;
    }

    if (!handled) {
      const workspaces = await Workspace.find({
        "batches.videos.frameAssetId": frameAssetId,
      });
      for (const workspace of workspaces) {
        let targetVideo = null;
        for (const batch of workspace.batches || []) {
          const candidate = (batch.videos || []).find(
            (item) => String(item.frameAssetId || "") === frameAssetId,
          );
          if (candidate) {
            targetVideo = candidate;
            break;
          }
        }
        if (!targetVideo) continue;
        const clientId =
          workspace.clientId || (await resolveClientIdFromPayload(workspace));
        if (!clientId) continue;
        if (outcome === "approved") {
          targetVideo.approved = true;
          targetVideo.approvedAt = eventAt;
          targetVideo.revision = false;
          targetVideo.revisionNote = "";
          targetVideo.editFase = "client_approved";
        } else {
          targetVideo.revision = true;
          targetVideo.revisionNote = revisionNote;
          targetVideo.approved = false;
          targetVideo.approvedAt = null;
          targetVideo.editFase = "client_revision";
        }
        targetVideo.frameLastEventId = eventId || undefined;
        targetVideo.frameLastEventAt = eventAt;
        await workspace.save();
        const client = await Client.findById(clientId).select("name");
        await Note.create({
          clientId,
          from: "client",
          author: client?.name || "Client",
          text:
            outcome === "approved"
              ? `Goedgekeurd via Frame.io: "${targetVideo.name}"`
              : `Revisie via Frame.io voor "${targetVideo.name}": ${revisionNote}`,
        });
        handled = true;
        break;
      }
    }

    if (!handled) {
      console.warn("[FRAMEIO_WEBHOOK] Unmapped frameAssetId:", frameAssetId);
      return res.status(202).json({
        message: "No mapped video found for Frame asset",
        frameAssetId,
      });
    }

    await FrameWebhookEvent.create({
      eventId,
      eventType: String(payload.event || payload.type || ""),
      frameAssetId,
      outcome,
      processedAt: new Date(),
    });
    return res.json({ message: "Processed", outcome });
  } catch (e) {
    return res.status(500).json({ error: e.message });
  }
});

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

    const payload = withLegacyClientContactFields({
      ...req.body,
      portalEmail: hasPortalEmail ? normalizedPortalEmail : undefined,
    });
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
      logPortalAccessEmailStub({
        to: normalizedPortalEmail,
        clientName: client.name,
        event: "portal_credentials_created_with_client",
        changedEmail: normalizedPortalEmail,
        changedPassword: true,
      });
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

    const updatePayload = withLegacyClientContactFields({
      ...req.body,
      contacts: hasOwn(req.body, "contacts")
        ? req.body.contacts
        : existingClient.contacts,
      contact: hasOwn(req.body, "contact")
        ? req.body.contact
        : existingClient.contact,
      email: hasOwn(req.body, "email") ? req.body.email : existingClient.email,
      phone: hasOwn(req.body, "phone") ? req.body.phone : existingClient.phone,
    });
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
          logPortalAccessEmailStub({
            to: targetEmail,
            clientName: client.name,
            event: "portal_credentials_created",
            changedEmail: targetEmail,
            changedPassword: true,
            previousEmail: existingClient.portalEmail || undefined,
          });
        } else {
          const prevEmail = existingPortalUser.email;
          existingPortalUser.email = targetEmail;
          existingPortalUser.name = client.name;
          if (providedPortalPassword) {
            existingPortalUser.passwordHash = passwordHash;
          }
          await existingPortalUser.save();
          const emailChanged =
            String(prevEmail || "").toLowerCase() !==
            String(targetEmail || "").toLowerCase();
          if (emailChanged || providedPortalPassword) {
            logPortalAccessEmailStub({
              to: targetEmail,
              clientName: client.name,
              event: emailChanged
                ? "portal_login_email_or_password_updated"
                : "portal_password_updated",
              changedEmail: targetEmail,
              changedPassword: !!providedPortalPassword,
              previousEmail: emailChanged ? prevEmail : undefined,
            });
          }
        }
      }
    }

    res.json(sanitizeClient(client));
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

router.get("/clients/:id/documents", auth(["team"]), async (req, res) => {
  try {
    const client = await Client.findById(req.params.id).select("documents");
    if (!client) return res.status(404).json({ error: "Client not found" });
    const docs = Array.isArray(client.documents) ? client.documents : [];
    const sorted = [...docs].sort((a, b) => {
      const left = new Date(a.createdAt || 0).getTime();
      const right = new Date(b.createdAt || 0).getTime();
      return right - left;
    });
    res.json(sorted);
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

router.post(
  "/clients/:id/documents/presign",
  auth(["team"]),
  async (req, res) => {
    try {
      const client = await Client.findById(req.params.id).select("_id");
      if (!client) return res.status(404).json({ error: "Client not found" });

      const aws = readAwsCheckerEnv();
      if (!hasBucketAndRegion(aws)) {
        return res.status(503).json({
          error:
            "S3 is not configured: set AWS_REGION and AWS_S3_BUCKET in foureel-backend/.env",
        });
      }
      if (!hasSigningCredentials(aws)) {
        return res.status(503).json({
          error:
            "Missing signing keys: set AWS_ACCESS_KEY_ID and AWS_SECRET_ACCESS_KEY in foureel-backend/.env (IAM with s3:PutObject), then restart the API.",
        });
      }

      const { bucket, region } = aws;
      const filename = safeClientDocumentFilename(req.body?.filename);
      const contentType =
        typeof req.body?.contentType === "string" && req.body.contentType.trim()
          ? req.body.contentType.trim()
          : "application/octet-stream";
      const key = `client-documents/${String(client._id)}/${Date.now()}-${filename}`;

      const command = new PutObjectCommand({
        Bucket: bucket,
        Key: key,
        ContentType: contentType,
      });

      const uploadUrl = await getSignedUrl(s3, command, { expiresIn: 60 * 60 });
      const fileUrl = clientDocumentObjectUrl(bucket, region, key);
      res.json({ uploadUrl, key, fileUrl, method: "PUT", contentType });
    } catch (e) {
      res.status(500).json({ error: e.message });
    }
  },
);

router.post("/clients/:id/documents", auth(["team"]), async (req, res) => {
  try {
    const client = await Client.findById(req.params.id);
    if (!client) return res.status(404).json({ error: "Client not found" });

    const aws = readAwsCheckerEnv();
    if (!hasBucketAndRegion(aws)) {
      return res.status(503).json({
        error:
          "S3 is not configured: set AWS_REGION and AWS_S3_BUCKET in foureel-backend/.env",
      });
    }

    const key = typeof req.body?.key === "string" ? req.body.key.trim() : "";
    const expectedPrefix = `client-documents/${String(client._id)}/`;
    if (!key || !key.startsWith(expectedPrefix)) {
      return res.status(400).json({ error: "Invalid or missing document key" });
    }

    const expectedUrl = clientDocumentObjectUrl(aws.bucket, aws.region, key);
    const fileUrl =
      typeof req.body?.fileUrl === "string" && req.body.fileUrl.trim()
        ? req.body.fileUrl.trim()
        : expectedUrl;
    if (fileUrl !== expectedUrl) {
      return res.status(400).json({ error: "fileUrl does not match key" });
    }

    const name =
      typeof req.body?.name === "string" && req.body.name.trim()
        ? req.body.name.trim()
        : key.split("/").pop() || "document";
    const contentType =
      typeof req.body?.contentType === "string"
        ? req.body.contentType.trim()
        : "";
    const sizeBytes = Number.isFinite(Number(req.body?.sizeBytes))
      ? Math.max(0, Math.floor(Number(req.body.sizeBytes)))
      : undefined;

    client.documents.push({
      name,
      key,
      url: expectedUrl,
      contentType: contentType || undefined,
      sizeBytes,
      uploadedById: req.user.id,
      uploadedByName: req.user.name,
    });
    await client.save();

    const createdDoc = client.documents[client.documents.length - 1];
    res.status(201).json(createdDoc);
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
// TEAM (dashboard sidebar)
// ═══════════════════════════════════════════════════════════════
function isValidHexColor(value) {
  if (typeof value !== "string") return false;
  const s = value.trim();
  return /^#[0-9A-Fa-f]{3}([0-9A-Fa-f]{3})?$/.test(s);
}

function parseTeamAccessLevel(payload = {}, fallback = "editor") {
  const explicit =
    typeof payload?.teamAccessLevel === "string"
      ? payload.teamAccessLevel.trim().toLowerCase()
      : "";
  if (explicit === "admin" || explicit === "editor") return explicit;
  const fromRole =
    typeof payload?.teamRole === "string"
      ? payload.teamRole.trim().toLowerCase()
      : "";
  if (fromRole === "admin" || fromRole === "editor") return fromRole;
  return fallback;
}

router.get("/team", auth(TEAM_ALL_ACCESS), async (req, res) => {
  try {
    const users = await User.find({ role: "team" })
      .select("name email initials color teamRole teamAccessLevel")
      .sort({ name: 1 })
      .lean();
    res.json(users);
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

router.post("/team", auth(["team"]), async (req, res) => {
  try {
    const email = normalizeEmail(req.body?.email);
    const password =
      typeof req.body?.password === "string" ? req.body.password.trim() : "";
    const name = typeof req.body?.name === "string" ? req.body.name.trim() : "";
    const teamRole =
      typeof req.body?.teamRole === "string" ? req.body.teamRole.trim() : "";
    const colorRaw =
      typeof req.body?.color === "string" ? req.body.color.trim() : "";

    if (!name) {
      return res.status(400).json({ error: "Name is required" });
    }
    if (!email || !EMAIL_REGEX.test(email)) {
      return res.status(400).json({ error: "A valid email is required" });
    }
    if (!password || password.length < 8) {
      return res
        .status(400)
        .json({ error: "Password must be at least 8 characters" });
    }
    if (!teamRole) {
      return res.status(400).json({ error: "Team role is required" });
    }

    const exists = await User.findOne({ email });
    if (exists) {
      return res.status(409).json({ error: "That email is already in use" });
    }

    const initials = name.length ? String(name[0]).toUpperCase() : "";
    const color =
      colorRaw && isValidHexColor(colorRaw) ? colorRaw.trim() : "#C8953A";

    const created = await User.create({
      email,
      passwordHash: await bcrypt.hash(password, 10),
      role: "team",
      name,
      teamRole,
      teamAccessLevel: parseTeamAccessLevel(req.body, "editor"),
      initials: initials || undefined,
      color,
    });

    const safe = await User.findById(created._id)
      .select("name email initials color teamRole teamAccessLevel")
      .lean();
    res.status(201).json(safe);
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

router.put("/team/:id", auth(["team"]), async (req, res) => {
  try {
    if (!mongoose.Types.ObjectId.isValid(req.params.id)) {
      return res.status(400).json({ error: "Invalid team member id" });
    }
    const existing = await User.findOne({ _id: req.params.id, role: "team" });
    if (!existing) {
      return res.status(404).json({ error: "Team member not found" });
    }

    const name =
      typeof req.body?.name === "string" ? req.body.name.trim() : existing.name;
    const emailRaw =
      typeof req.body?.email === "string" ? req.body.email : existing.email;
    const email = normalizeEmail(emailRaw);
    const teamRole =
      typeof req.body?.teamRole === "string"
        ? req.body.teamRole.trim()
        : existing.teamRole || "";
    const teamAccessLevel = parseTeamAccessLevel(
      req.body,
      existing.teamAccessLevel || "editor",
    );
    const colorRaw =
      typeof req.body?.color === "string"
        ? req.body.color.trim()
        : existing.color;
    const password =
      typeof req.body?.password === "string" ? req.body.password.trim() : "";

    if (!name) {
      return res.status(400).json({ error: "Name is required" });
    }
    if (!email || !EMAIL_REGEX.test(email)) {
      return res.status(400).json({ error: "A valid email is required" });
    }
    if (!teamRole) {
      return res.status(400).json({ error: "Team role is required" });
    }
    if (password && password.length < 8) {
      return res
        .status(400)
        .json({ error: "Password must be at least 8 characters" });
    }

    const emailConflict = await User.findOne({
      email,
      _id: { $ne: existing._id },
    });
    if (emailConflict) {
      return res.status(409).json({ error: "That email is already in use" });
    }

    const initials = name.length ? String(name[0]).toUpperCase() : "";
    existing.name = name;
    existing.email = email;
    existing.teamRole = teamRole;
    existing.teamAccessLevel = teamAccessLevel;
    existing.initials = initials || undefined;
    existing.color =
      colorRaw && isValidHexColor(colorRaw) ? colorRaw.trim() : "#C8953A";
    if (password) {
      existing.passwordHash = await bcrypt.hash(password, 10);
    }
    await existing.save();

    const safe = await User.findById(existing._id)
      .select("name email initials color teamRole teamAccessLevel")
      .lean();
    res.json(safe);
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

router.delete("/team/:id", auth(["team"]), async (req, res) => {
  try {
    if (!mongoose.Types.ObjectId.isValid(req.params.id)) {
      return res.status(400).json({ error: "Invalid team member id" });
    }
    const deleted = await User.findOneAndDelete({
      _id: req.params.id,
      role: "team",
    });
    if (!deleted) {
      return res.status(404).json({ error: "Team member not found" });
    }
    const deletedOwnAccount = String(req.user.id) === String(req.params.id);
    res.json({ message: "Deleted", deletedOwnAccount });
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

// ═══════════════════════════════════════════════════════════════
// EVENTS (Calendar)
// ═══════════════════════════════════════════════════════════════
router.get("/events", auth(["team"]), async (req, res) => {
  try {
    const events = await Event.find()
      .populate("assigneeId", "name initials color teamRole")
      .sort({ date: 1, time: 1, name: 1 });
    res.json(events);
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

router.post("/events", auth(["team"]), async (req, res) => {
  try {
    if (
      !req.body.assigneeId ||
      !mongoose.Types.ObjectId.isValid(String(req.body.assigneeId))
    ) {
      return res.status(400).json({ error: "assigneeId is required" });
    }
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
    if (
      !req.body.assigneeId ||
      !mongoose.Types.ObjectId.isValid(String(req.body.assigneeId))
    ) {
      return res.status(400).json({ error: "assigneeId is required" });
    }
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
router.get("/tasks", auth(TEAM_ALL_ACCESS), async (req, res) => {
  try {
    const tasks = await Task.find({
      archived: false,
      status: { $ne: "delete" },
    });
    const sorted = [...tasks].sort((a, b) => {
      const colCmp =
        TASK_COLUMNS.indexOf(a.column || "todo") -
        TASK_COLUMNS.indexOf(b.column || "todo");
      if (colCmp !== 0) return colCmp;
      return compareTaskOrder(a, b);
    });
    res.json(sorted);
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

router.get("/tasks/archived", auth(TEAM_ALL_ACCESS), async (req, res) => {
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
    const targetColumn = TASK_COLUMNS.includes(req.body?.column)
      ? req.body.column
      : "todo";
    const lastTaskInColumn = await Task.findOne({
      archived: false,
      status: { $ne: "delete" },
      column: targetColumn,
    })
      .sort({ sortOrder: -1, createdAt: -1 })
      .select("sortOrder");
    const nextSortOrder = Number.isFinite(lastTaskInColumn?.sortOrder)
      ? lastTaskInColumn.sortOrder + 1
      : 1;
    const task = await Task.create({
      ...req.body,
      ...clientFields,
      column: targetColumn,
      sortOrder: nextSortOrder,
    });
    res.status(201).json(task);
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

router.patch("/tasks/reorder", auth(["team"]), async (req, res) => {
  try {
    const { movedTaskId, destinationColumn, columnTaskIds } = req.body || {};
    if (!movedTaskId || !mongoose.Types.ObjectId.isValid(String(movedTaskId))) {
      return res.status(400).json({ error: "Invalid movedTaskId" });
    }
    if (!TASK_COLUMNS.includes(destinationColumn)) {
      return res.status(400).json({ error: "Invalid destinationColumn" });
    }
    if (!columnTaskIds || typeof columnTaskIds !== "object") {
      return res.status(400).json({ error: "columnTaskIds is required" });
    }

    const touchedColumns = Object.entries(columnTaskIds).filter(
      ([column, ids]) => TASK_COLUMNS.includes(column) && Array.isArray(ids),
    );
    if (!touchedColumns.length) {
      return res
        .status(400)
        .json({ error: "At least one column ordering is required" });
    }

    const movedTask = await Task.findById(movedTaskId).select("_id");
    if (!movedTask) return res.status(404).json({ error: "Task not found" });

    const bulkOps = [];
    touchedColumns.forEach(([column, ids]) => {
      ids.forEach((taskId, index) => {
        if (!mongoose.Types.ObjectId.isValid(String(taskId))) return;
        bulkOps.push({
          updateOne: {
            filter: { _id: taskId },
            update: {
              $set: {
                column,
                sortOrder: index + 1,
              },
            },
          },
        });
      });
    });

    if (!bulkOps.length) {
      return res
        .status(400)
        .json({ error: "No valid task ids provided for reorder" });
    }

    await Task.bulkWrite(bulkOps);

    const updatedTask = await Task.findById(movedTaskId);
    if (!updatedTask) return res.status(404).json({ error: "Task not found" });

    if (updatedTask.column !== destinationColumn) {
      await Task.updateOne(
        { _id: movedTaskId },
        { $set: { column: destinationColumn } },
      );
      updatedTask.column = destinationColumn;
    }

    await log(
      `<strong>${req.user.name}</strong> taakvolgorde bijgewerkt`,
      "var(--blue)",
      "taken",
      req.user.name,
    );
    res.json(updatedTask);
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
    const body = req.body && typeof req.body === "object" ? req.body : {};
    if (
      Object.prototype.hasOwnProperty.call(body, "column") &&
      !TASK_COLUMNS.includes(body.column)
    ) {
      return res.status(400).json({ error: "Invalid task column" });
    }
    const updatePayload = { ...body };
    if (Object.prototype.hasOwnProperty.call(body, "description")) {
      updatePayload.description =
        typeof body.description === "string" ? body.description.trim() : "";
    }
    if (Object.prototype.hasOwnProperty.call(body, "checklist")) {
      updatePayload.checklist = sanitizeTaskChecklist(body.checklist) || [];
    }
    if (Object.prototype.hasOwnProperty.call(body, "links")) {
      updatePayload.links = sanitizeTaskLinks(body.links) || [];
    }
    if (Object.prototype.hasOwnProperty.call(body, "comments")) {
      updatePayload.comments = sanitizeTaskComments(body.comments) || [];
    }
    const shouldResolveClient =
      Object.prototype.hasOwnProperty.call(updatePayload, "clientId") ||
      Object.prototype.hasOwnProperty.call(updatePayload, "client");
    const resolvedClientFields = shouldResolveClient
      ? await resolveTaskClientFields(updatePayload)
      : {};

    const task = await Task.findByIdAndUpdate(
      req.params.id,
      {
        ...updatePayload,
        ...resolvedClientFields,
      },
      {
        new: true,
      },
    );
    if (!task) return res.status(404).json({ error: "Task not found" });
    if (updatePayload.column) {
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
      typeof req.body?.archivedReason === "string" &&
      req.body.archivedReason.trim()
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
      {
        archived: false,
        archivedAt: null,
        archivedReason: null,
        column: "todo",
      },
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
    batch.videos.push(normalizeVideoFrameFields(req.body || {}));
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

      Object.assign(video, normalizeVideoFrameFields(req.body || {}));
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

        const targetClientId =
          batch.clientId || (await resolveClientIdFromPayload(batch));
        const client = targetClientId
          ? await Client.findById(targetClientId)
          : null;
        if (client) {
          const frameUrl = getFrameReviewUrl(video);
          const pushText = buildFrameReviewPushText(video.name, frameUrl);
          const existingPushNote = await Note.findOne({
            clientId: client._id,
            from: "studio",
            text: pushText,
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
              text: pushText,
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
// WORKSPACES (new hierarchy: Workspace → Batches → Videos)
// ═══════════════════════════════════════════════════════════════
router.get("/workspaces", auth(TEAM_ALL_ACCESS), async (req, res) => {
  try {
    const workspaces = await Workspace.find().sort({ createdAt: -1 });
    res.json(workspaces);
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

router.post("/workspaces", auth(["team"]), async (req, res) => {
  try {
    if (!req.body?.name?.trim()) {
      return res.status(400).json({ error: "Workspace name is required" });
    }
    const clientId = await resolveClientIdFromPayload(req.body);
    const workspace = await Workspace.create({
      ...req.body,
      clientId: clientId || req.body.clientId,
      batches: Array.isArray(req.body.batches) ? req.body.batches : [],
    });
    res.status(201).json(workspace);
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

router.put("/workspaces/:id", auth(TEAM_ALL_ACCESS), async (req, res) => {
  try {
    const existingWorkspace = await Workspace.findById(req.params.id);
    if (!existingWorkspace) {
      return res.status(404).json({ error: "Workspace not found" });
    }
    if (req.user.teamAccessLevel === "editor") {
      const allowed = isEditorAllowedWorkspaceUpdate(
        existingWorkspace,
        req.body,
      );
      if (!allowed) {
        return res.status(403).json({
          error:
            "Editors may only add resource items in workspace subject sections",
        });
      }
    }
    const clientId = await resolveClientIdFromPayload(req.body);
    Object.assign(existingWorkspace, req.body);
    const workspace = await existingWorkspace.save();
    if (clientId && !workspace.clientId) {
      workspace.clientId = clientId;
      await workspace.save();
    }
    res.json(workspace);
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

router.delete("/workspaces/:id", auth(["team"]), async (req, res) => {
  try {
    await Workspace.findByIdAndDelete(req.params.id);
    res.json({ message: "Deleted" });
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

// ── Nested: Batches inside a Workspace ────────────────────────
router.post("/workspaces/:wsId/batches", auth(["team"]), async (req, res) => {
  try {
    const workspace = await Workspace.findById(req.params.wsId);
    if (!workspace)
      return res.status(404).json({ error: "Workspace not found" });
    const name = typeof req.body?.name === "string" ? req.body.name.trim() : "";
    if (!name) return res.status(400).json({ error: "Batch name is required" });

    workspace.batches.push({
      name,
      emoji: req.body?.emoji || "🎬",
      videos: [],
    });
    await workspace.save();
    res.status(201).json(workspace);
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

router.put(
  "/workspaces/:wsId/batches/:bId",
  auth(["team"]),
  async (req, res) => {
    try {
      const workspace = await Workspace.findById(req.params.wsId);
      if (!workspace)
        return res.status(404).json({ error: "Workspace not found" });
      const batch = workspace.batches.id(req.params.bId);
      if (!batch) return res.status(404).json({ error: "Batch not found" });

      const { name, emoji } = req.body || {};
      if (typeof name === "string" && name.trim()) batch.name = name.trim();
      if (typeof emoji === "string") batch.emoji = emoji;

      await workspace.save();
      res.json(workspace);
    } catch (e) {
      res.status(500).json({ error: e.message });
    }
  },
);

router.delete(
  "/workspaces/:wsId/batches/:bId",
  auth(["team"]),
  async (req, res) => {
    try {
      const workspace = await Workspace.findById(req.params.wsId);
      if (!workspace)
        return res.status(404).json({ error: "Workspace not found" });
      workspace.batches.pull({ _id: req.params.bId });
      await workspace.save();
      res.json(workspace);
    } catch (e) {
      res.status(500).json({ error: e.message });
    }
  },
);

// ── Nested: Videos inside a Batch inside a Workspace ──────────
router.post(
  "/workspaces/:wsId/batches/:bId/videos",
  auth(["team"]),
  async (req, res) => {
    try {
      const workspace = await Workspace.findById(req.params.wsId);
      if (!workspace)
        return res.status(404).json({ error: "Workspace not found" });
      const batch = workspace.batches.id(req.params.bId);
      if (!batch) return res.status(404).json({ error: "Batch not found" });

      batch.videos.push(normalizeVideoFrameFields(req.body || {}));
      await workspace.save();
      res.status(201).json(workspace);
    } catch (e) {
      res.status(500).json({ error: e.message });
    }
  },
);

router.put(
  "/workspaces/:wsId/batches/:bId/videos/:vId",
  auth(["team"]),
  async (req, res) => {
    try {
      const workspace = await Workspace.findById(req.params.wsId);
      if (!workspace)
        return res.status(404).json({ error: "Workspace not found" });
      const batch = workspace.batches.id(req.params.bId);
      if (!batch) return res.status(404).json({ error: "Batch not found" });
      const video = batch.videos.id(req.params.vId);
      if (!video) return res.status(404).json({ error: "Video not found" });

      Object.assign(video, normalizeVideoFrameFields(req.body || {}));
      await workspace.save();

      // Auto-push to portal when fase = waitreview (mirrors legacy /batches flow)
      if (req.body.editFase === "waitreview") {
        if (!video.portalPushed) {
          video.portalPushed = true;
          video.revision = false;
          video.revisionNote = "";
          video.approved = false;
          video.approvedAt = null;
          await workspace.save();
        }

        const targetClientId =
          workspace.clientId || (await resolveClientIdFromPayload(workspace));
        const client = targetClientId
          ? await Client.findById(targetClientId)
          : null;
        if (client) {
          const frameUrl = getFrameReviewUrl(video);
          const pushText = buildFrameReviewPushText(video.name, frameUrl);
          const existingPushNote = await Note.findOne({
            clientId: client._id,
            from: "studio",
            text: pushText,
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
              text: pushText,
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

      res.json(workspace);
    } catch (e) {
      res.status(500).json({ error: e.message });
    }
  },
);

router.delete(
  "/workspaces/:wsId/batches/:bId/videos/:vId",
  auth(["team"]),
  async (req, res) => {
    try {
      const workspace = await Workspace.findById(req.params.wsId);
      if (!workspace)
        return res.status(404).json({ error: "Workspace not found" });
      const batch = workspace.batches.id(req.params.bId);
      if (!batch) return res.status(404).json({ error: "Batch not found" });
      batch.videos.pull({ _id: req.params.vId });
      await workspace.save();
      res.json(workspace);
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

router.post(
  "/portal/:clientId/whatsapp/presign",
  auth(["team"]),
  async (req, res) => {
    try {
      const { clientId } = req.params;
      if (!mongoose.Types.ObjectId.isValid(clientId)) {
        return res.status(400).json({ error: "Invalid clientId" });
      }

      const client = await Client.findById(clientId).select("_id");
      if (!client) return res.status(404).json({ error: "Client not found" });

      const aws = readAwsCheckerEnv();
      if (!hasBucketAndRegion(aws)) {
        return res.status(503).json({
          error:
            "S3 is not configured: set AWS_REGION and AWS_S3_BUCKET in foureel-backend/.env",
        });
      }
      if (!hasSigningCredentials(aws)) {
        return res.status(503).json({
          error:
            "Missing signing keys: set AWS_ACCESS_KEY_ID and AWS_SECRET_ACCESS_KEY in foureel-backend/.env (IAM with s3:PutObject), then restart the API.",
        });
      }

      const contentType =
        typeof req.body?.contentType === "string"
          ? req.body.contentType.trim()
          : "";
      if (!isAllowedWhatsappImageContentType(contentType)) {
        return res.status(400).json({
          error:
            "Unsupported image type. Allowed: JPEG, PNG, WEBP, HEIC, HEIF.",
        });
      }
      const sizeBytes = Number(req.body?.sizeBytes);
      if (!Number.isFinite(sizeBytes) || sizeBytes <= 0) {
        return res.status(400).json({ error: "sizeBytes is required" });
      }
      if (sizeBytes > WHATSAPP_MAX_FILE_BYTES) {
        return res
          .status(400)
          .json({ error: "Image is too large (max 15 MB)." });
      }

      const { bucket, region } = aws;
      const filename = safeWhatsappFilename(req.body?.filename);
      const key = `whatsapp/${String(client._id)}/${Date.now()}-${filename}`;

      const command = new PutObjectCommand({
        Bucket: bucket,
        Key: key,
        ContentType: contentType,
      });

      const uploadUrl = await getSignedUrl(s3, command, { expiresIn: 60 * 60 });
      const fileUrl = clientDocumentObjectUrl(bucket, region, key);
      res.json({ uploadUrl, key, fileUrl, method: "PUT", contentType });
    } catch (e) {
      res.status(500).json({ error: e.message });
    }
  },
);

router.post(
  "/portal/:clientId/whatsapp/messages",
  auth(["team"]),
  async (req, res) => {
    try {
      const { clientId } = req.params;
      if (!mongoose.Types.ObjectId.isValid(clientId)) {
        return res.status(400).json({ error: "Invalid clientId" });
      }
      const client = await Client.findById(clientId).select("_id");
      if (!client) return res.status(404).json({ error: "Client not found" });

      const text =
        typeof req.body?.text === "string" ? req.body.text.trim() : "";
      const attachmentsRaw = Array.isArray(req.body?.attachments)
        ? req.body.attachments
        : [];
      const aws = readAwsCheckerEnv();
      if (!hasBucketAndRegion(aws)) {
        return res.status(503).json({
          error:
            "S3 is not configured: set AWS_REGION and AWS_S3_BUCKET in foureel-backend/.env",
        });
      }

      const expectedPrefix = `whatsapp/${String(client._id)}/`;
      const attachments = [];
      for (const item of attachmentsRaw) {
        const key = typeof item?.key === "string" ? item.key.trim() : "";
        if (!key || !key.startsWith(expectedPrefix)) {
          return res
            .status(400)
            .json({ error: "Invalid WhatsApp attachment key" });
        }
        const expectedUrl = clientDocumentObjectUrl(
          aws.bucket,
          aws.region,
          key,
        );
        const fileUrl =
          typeof item?.url === "string" && item.url.trim()
            ? item.url.trim()
            : expectedUrl;
        if (fileUrl !== expectedUrl) {
          return res
            .status(400)
            .json({ error: "Attachment URL does not match key" });
        }

        const contentType =
          typeof item?.contentType === "string" ? item.contentType.trim() : "";
        if (!isAllowedWhatsappImageContentType(contentType)) {
          return res
            .status(400)
            .json({ error: "Invalid attachment contentType" });
        }

        const sizeBytes = Number(item?.sizeBytes);
        if (!Number.isFinite(sizeBytes) || sizeBytes <= 0) {
          return res
            .status(400)
            .json({ error: "Invalid attachment sizeBytes" });
        }
        if (sizeBytes > WHATSAPP_MAX_FILE_BYTES) {
          return res
            .status(400)
            .json({ error: "Attachment exceeds 15 MB limit" });
        }

        attachments.push({
          name:
            typeof item?.name === "string" && item.name.trim()
              ? item.name.trim()
              : key.split("/").pop() || "whatsapp-image",
          key,
          url: expectedUrl,
          contentType,
          sizeBytes: Math.floor(sizeBytes),
          uploadedById: req.user.id,
          uploadedByName: req.user.name,
          uploadedAt: new Date(),
        });
      }

      if (!text && attachments.length === 0) {
        return res.status(400).json({
          error: "Provide text or at least one attachment",
        });
      }

      const message = await Note.create({
        clientId: client._id,
        from: "studio",
        channel: "whatsapp",
        author: req.body.author || `${req.user.name} · 4REEL`,
        text,
        attachments,
      });
      res.status(201).json(message);
    } catch (e) {
      res.status(500).json({ error: e.message });
    }
  },
);

router.get(
  "/portal/:clientId/whatsapp/messages",
  auth(["team"]),
  async (req, res) => {
    try {
      const { clientId } = req.params;
      if (!mongoose.Types.ObjectId.isValid(clientId)) {
        return res.status(400).json({ error: "Invalid clientId" });
      }
      const client = await Client.findById(clientId).select("_id");
      if (!client) return res.status(404).json({ error: "Client not found" });

      const messages = await Note.find({
        clientId: client._id,
        channel: "whatsapp",
      }).sort({ createdAt: -1 });
      res.json(messages);
    } catch (e) {
      res.status(500).json({ error: e.message });
    }
  },
);

router.get("/portal/:clientId/videos", auth(["team"]), async (req, res) => {
  try {
    const [batches, workspaces] = await Promise.all([
      Batch.find({ clientId: req.params.clientId }),
      Workspace.find({ clientId: req.params.clientId }),
    ]);
    const reviewVideos = [];
    batches.forEach((b) => {
      b.videos.forEach((v) => {
        if (
          ["waitreview", "client_review", "client_revision"].includes(
            v.editFase,
          )
        ) {
          reviewVideos.push(
            buildPortalReviewVideo(v, {
              batchName: b.name,
              batchId: b._id,
            }),
          );
        }
      });
    });
    workspaces.forEach((workspace) => {
      (workspace.batches || []).forEach((batch) => {
        (batch.videos || []).forEach((video) => {
          if (
            ["waitreview", "client_review", "client_revision"].includes(
              video.editFase,
            )
          ) {
            reviewVideos.push(
              buildPortalReviewVideo(video, {
                batchName: batch.name,
                batchId: batch._id,
                workspaceId: workspace._id,
                workspaceName: workspace.name,
              }),
            );
          }
        });
      });
    });
    res.json(reviewVideos);
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

// Backfill/update Frame.io asset mapping for existing videos
router.post(
  "/portal/frame-assets/backfill",
  auth(["team"]),
  async (req, res) => {
    try {
      const mappings = Array.isArray(req.body?.mappings)
        ? req.body.mappings
        : [];
      if (!mappings.length) {
        return res.status(400).json({ error: "mappings array is required" });
      }

      let updated = 0;
      const skipped = [];

      for (const item of mappings) {
        const videoId =
          typeof item?.videoId === "string" ? item.videoId.trim() : "";
        const frameAssetId =
          typeof item?.frameAssetId === "string"
            ? item.frameAssetId.trim()
            : "";
        const frameReviewUrl =
          typeof item?.frameReviewUrl === "string"
            ? item.frameReviewUrl.trim()
            : "";
        if (!videoId || !frameAssetId) {
          skipped.push({ videoId, reason: "missing_videoId_or_frameAssetId" });
          continue;
        }

        let found = false;
        const batch = await Batch.findOne({ "videos._id": videoId });
        if (batch) {
          const video = batch.videos.id(videoId);
          if (video) {
            video.frameAssetId = frameAssetId;
            if (frameReviewUrl) video.frameReviewUrl = frameReviewUrl;
            await batch.save();
            updated += 1;
            found = true;
          }
        }
        if (found) continue;

        const workspace = await Workspace.findOne({
          "batches.videos._id": videoId,
        });
        if (!workspace) {
          skipped.push({ videoId, reason: "video_not_found" });
          continue;
        }
        let updatedWorkspaceVideo = false;
        for (const wsBatch of workspace.batches || []) {
          const video = wsBatch.videos.id(videoId);
          if (!video) continue;
          video.frameAssetId = frameAssetId;
          if (frameReviewUrl) video.frameReviewUrl = frameReviewUrl;
          updatedWorkspaceVideo = true;
          break;
        }
        if (!updatedWorkspaceVideo) {
          skipped.push({ videoId, reason: "video_not_found" });
          continue;
        }
        await workspace.save();
        updated += 1;
      }

      return res.json({ updated, skipped });
    } catch (e) {
      return res.status(500).json({ error: e.message });
    }
  },
);

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

router.get("/portal/activity", auth(["team"]), async (req, res) => {
  try {
    const limitRaw = Number.parseInt(String(req.query?.limit ?? "40"), 10);
    const limit = Number.isFinite(limitRaw)
      ? Math.max(1, Math.min(limitRaw, 200))
      : 40;
    const beforeDate = req.query?.before
      ? new Date(String(req.query.before))
      : null;
    const hasBefore = beforeDate && !Number.isNaN(beforeDate.getTime());

    const [clients, notes, batches, questionnaires] = await Promise.all([
      Client.find().select("_id name").lean(),
      Note.find({ from: "client" }).sort({ createdAt: -1 }).lean(),
      Batch.find()
        .select(
          "_id name clientId client videos._id videos.name videos.approvedAt videos.revision videos.revisionNote videos.updatedAt videos.createdAt",
        )
        .lean(),
      Questionnaire.find()
        .select(
          "_id clientId openedAt submitted submittedAt createdAt updatedAt",
        )
        .lean(),
    ]);

    const clientNameById = new Map(
      clients.map((client) => [
        String(client._id),
        client.name || "Unknown client",
      ]),
    );
    const resolveClientName = (clientId, fallback = "") =>
      clientNameById.get(String(clientId || "")) ||
      fallback ||
      "Unknown client";

    const events = [];

    notes.forEach((note) => {
      events.push({
        id: String(note._id),
        type: "note",
        clientId: note.clientId,
        clientName: resolveClientName(note.clientId),
        text: note.text || "Client message",
        createdAt: note.createdAt,
        meta: { noteId: note._id },
      });
    });

    batches.forEach((batch) => {
      const batchName = batch.name || "";
      const fallbackClientName = batch.client || "";
      (batch.videos || []).forEach((video) => {
        const videoName = video?.name || "video";
        if (video?.approvedAt) {
          events.push({
            id: `${String(batch._id)}:${String(video._id)}:approved`,
            type: "video_approved",
            clientId: batch.clientId,
            clientName: resolveClientName(batch.clientId, fallbackClientName),
            text: `Goedgekeurd: "${videoName}"`,
            createdAt: video.approvedAt,
            meta: {
              batchId: batch._id,
              batchName,
              videoId: video._id,
              videoName,
            },
          });
        }
        if (video?.revision) {
          const revisionText = video.revisionNote
            ? `Revisie voor "${videoName}": ${video.revisionNote}`
            : `Revisie aangevraagd voor "${videoName}"`;
          events.push({
            id: `${String(batch._id)}:${String(video._id)}:revision`,
            type: "video_revision",
            clientId: batch.clientId,
            clientName: resolveClientName(batch.clientId, fallbackClientName),
            text: revisionText,
            createdAt:
              video.updatedAt ||
              video.createdAt ||
              batch.updatedAt ||
              batch.createdAt,
            meta: {
              batchId: batch._id,
              batchName,
              videoId: video._id,
              videoName,
            },
          });
        }
      });
    });

    questionnaires.forEach((questionnaire) => {
      const clientName = resolveClientName(questionnaire.clientId);
      if (questionnaire.openedAt) {
        events.push({
          id: `${String(questionnaire._id)}:opened`,
          type: "questionnaire_opened",
          clientId: questionnaire.clientId,
          clientName,
          text: "Onboarding vragenlijst geopend",
          createdAt: questionnaire.openedAt,
          meta: { questionnaireId: questionnaire._id },
        });
      }
      if (questionnaire.submitted && questionnaire.submittedAt) {
        events.push({
          id: `${String(questionnaire._id)}:submitted`,
          type: "questionnaire_submitted",
          clientId: questionnaire.clientId,
          clientName,
          text: "Onboarding vragenlijst ingevuld en verzonden!",
          createdAt: questionnaire.submittedAt,
          meta: { questionnaireId: questionnaire._id },
        });
      }
    });

    const filtered = events
      .filter(
        (event) =>
          event.createdAt && !Number.isNaN(new Date(event.createdAt).getTime()),
      )
      .filter((event) =>
        hasBefore ? new Date(event.createdAt) < beforeDate : true,
      )
      .sort(
        (a, b) =>
          new Date(b.createdAt).getTime() - new Date(a.createdAt).getTime(),
      );

    res.json(filtered.slice(0, limit));
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

    const [notes, batches, workspaces] = await Promise.all([
      Note.find({ clientId: client._id }).sort({ createdAt: 1 }),
      Batch.find({ clientId: client._id }),
      Workspace.find({ clientId: client._id }).sort({
        updatedAt: -1,
        createdAt: -1,
      }),
    ]);

    const reviewVideos = [];
    const deliveredBatches = [];
    batches.forEach((b) => {
      const rv = b.videos.filter((v) =>
        ["waitreview", "client_review", "client_revision"].includes(v.editFase),
      );
      const dv = b.videos.filter((v) => v.approved);
      rv.forEach((v) =>
        reviewVideos.push(
          buildPortalReviewVideo(v, {
            batchName: b.name,
          }),
        ),
      );
      if (dv.length)
        deliveredBatches.push({
          name: b.name,
          date: b.createdAt,
          videos: dv.map((v) => ({ name: v.name, driveUrl: v.assets || "" })),
        });
    });

    const questionnaire = await Questionnaire.findOne({ clientId: client._id });
    const workspaceArchive = workspaces.map((workspace) => {
      const videos = [];
      (workspace.batches || []).forEach((batch) => {
        (batch.videos || []).forEach((video) => {
          if (
            ["waitreview", "client_review", "client_revision"].includes(
              video.editFase,
            )
          ) {
            reviewVideos.push(
              buildPortalReviewVideo(video, {
                batchName: batch.name,
                batchId: batch._id,
                workspaceId: workspace._id,
                workspaceName: workspace.name,
              }),
            );
          }
          videos.push({
            ...video.toObject(),
            frameUrl: getFrameReviewUrl(video),
            driveUrl: video.assets || "",
            batchName: batch.name,
            batchId: batch._id,
          });
        });
      });
      videos.sort((a, b) => {
        const right = new Date(b.updatedAt || b.createdAt || 0).getTime();
        const left = new Date(a.updatedAt || a.createdAt || 0).getTime();
        return right - left;
      });
      return {
        _id: workspace._id,
        name: workspace.name,
        emoji: workspace.emoji,
        createdAt: workspace.createdAt,
        updatedAt: workspace.updatedAt,
        videos,
      };
    });

    res.json({
      client: { ...client.toObject(), portalPassword: undefined },
      notes,
      reviewVideos,
      deliveredBatches,
      workspaceArchive,
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
    const shouldSubmit = Boolean(submitted);
    const missingFields = shouldSubmit
      ? getMissingQuestionnaireFields(answers)
      : [];
    if (missingFields.length > 0) {
      return res.status(400).json({
        error:
          "Vul alle verplichte vragen in voordat je de vragenlijst verstuurt.",
        missingFields,
      });
    }
    let q = await Questionnaire.findOne({ clientId: req.user.clientId });
    if (!q) {
      q = new Questionnaire({
        clientId: req.user.clientId,
        openedAt: new Date(),
      });
    }
    q.answers = answers;
    if (shouldSubmit) {
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
      if (
        [
          "inprogress",
          "waitreview",
          "client_review",
          "client_revision",
        ].includes(v.editFase)
      )
        editorLoad[ed].reviewing++;
    });

    const notStarted =
      (pipelineCounts.tentative || 0) + (pipelineCounts.spotting || 0);
    const inEdit =
      (pipelineCounts.ready || 0) + (pipelineCounts.inprogress || 0);
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
      const diffDays = Math.ceil(
        (deadlineDate.getTime() - now.getTime()) / 86400000,
      );
      if (diffDays < 0 || diffDays > 7) return;
      const openVideos = (b.videos || []).filter(
        (v) => v.editFase !== "finished",
      ).length;
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

function safeCheckerFilename(name) {
  const raw = typeof name === "string" ? name : "video";
  const base = raw.replace(/[^a-zA-Z0-9._-]/g, "_").slice(0, 180);
  return base || "video.bin";
}

function checkerObjectUrl(bucket, region, key) {
  const path = key
    .split("/")
    .map((seg) => encodeURIComponent(seg))
    .join("/");
  return `https://${bucket}.s3.${region}.amazonaws.com/${path}`;
}

router.post("/checker/upload/presign", auth(["team"]), async (req, res) => {
  try {
    const aws = readAwsCheckerEnv();
    if (!hasBucketAndRegion(aws)) {
      return res.status(503).json({
        error:
          "S3 is not configured: set AWS_REGION and AWS_S3_BUCKET in foureel-backend/.env",
      });
    }
    if (!hasSigningCredentials(aws)) {
      return res.status(503).json({
        error:
          "Missing signing keys: set AWS_ACCESS_KEY_ID and AWS_SECRET_ACCESS_KEY in foureel-backend/.env (IAM with s3:PutObject), then restart the API.",
      });
    }

    const { bucket, region } = aws;
    const filename = safeCheckerFilename(req.body?.filename);
    const contentType =
      typeof req.body?.contentType === "string" && req.body.contentType.trim()
        ? req.body.contentType.trim()
        : "application/octet-stream";

    const userId = String(req.user.id);
    const key = `video-checker/${userId}/${Date.now()}-${filename}`;

    const command = new PutObjectCommand({
      Bucket: bucket,
      Key: key,
      ContentType: contentType,
    });

    const uploadUrl = await getSignedUrl(s3, command, { expiresIn: 60 * 60 });
    const videoUrl = checkerObjectUrl(bucket, region, key);

    res.json({ uploadUrl, key, videoUrl, method: "PUT", contentType });
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

router.post("/checker/runs", auth(["team"]), async (req, res) => {
  try {
    const aws = readAwsCheckerEnv();
    if (!hasBucketAndRegion(aws)) {
      return res.status(503).json({
        error:
          "S3 is not configured: set AWS_REGION and AWS_S3_BUCKET in foureel-backend/.env",
      });
    }
    const { bucket, region } = aws;

    const key =
      typeof req.body?.s3Key === "string" ? req.body.s3Key.trim() : "";
    const ownerPrefix = `video-checker/${String(req.user.id)}/`;
    if (!key || !key.startsWith(ownerPrefix)) {
      return res.status(400).json({ error: "Invalid or missing s3Key" });
    }

    const expectedUrl = checkerObjectUrl(bucket, region, key);
    const videoUrl =
      typeof req.body?.videoUrl === "string" && req.body.videoUrl.trim()
        ? req.body.videoUrl.trim()
        : expectedUrl;
    if (videoUrl !== expectedUrl) {
      return res.status(400).json({ error: "videoUrl does not match s3Key" });
    }

    const frames = Array.isArray(req.body?.frames) ? req.body.frames : [];
    const summary = req.body?.summary || {};
    const settings = req.body?.settings || {};

    const doc = await VideoCheckerRun.create({
      uploadedById: req.user.id,
      uploadedByName:
        typeof req.user.name === "string" ? req.user.name : undefined,
      videoOriginalName:
        typeof req.body?.videoOriginalName === "string"
          ? req.body.videoOriginalName.slice(0, 500)
          : undefined,
      videoContentType:
        typeof req.body?.videoContentType === "string"
          ? req.body.videoContentType.slice(0, 200)
          : undefined,
      videoSizeBytes:
        typeof req.body?.videoSizeBytes === "number"
          ? Math.max(0, Math.floor(req.body.videoSizeBytes))
          : undefined,
      durationSec:
        typeof req.body?.durationSec === "number" &&
        Number.isFinite(req.body.durationSec)
          ? req.body.durationSec
          : undefined,
      s3Key: key,
      videoUrl: expectedUrl,
      settings: {
        intervalSec:
          typeof settings.intervalSec === "string"
            ? settings.intervalSec
            : undefined,
        lang: typeof settings.lang === "string" ? settings.lang : undefined,
        mode: typeof settings.mode === "string" ? settings.mode : undefined,
      },
      summary: {
        frameCount:
          typeof summary.frameCount === "number"
            ? summary.frameCount
            : frames.length,
        errorCount:
          typeof summary.errorCount === "number" ? summary.errorCount : 0,
        cleanCount:
          typeof summary.cleanCount === "number" ? summary.cleanCount : 0,
      },
      frames: frames.map((f) => ({
        idx: typeof f.idx === "number" ? f.idx : Number(f.idx) || 0,
        timestamp:
          typeof f.timestamp === "number"
            ? f.timestamp
            : Number(f.timestamp) || 0,
        text: typeof f.text === "string" ? f.text.slice(0, 20000) : "",
        issues: Array.isArray(f.errors)
          ? f.errors.map((err) => ({
              wrong: err.wrong,
              suggestion: err.suggestion,
              message: err.message,
              offset: err.offset,
              length: err.length,
              ruleId: err.ruleId,
            }))
          : [],
      })),
    });

    res.status(201).json({ id: doc._id });
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

module.exports = router;
