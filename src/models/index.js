const mongoose = require("mongoose");
const bcrypt = require("bcryptjs");
const { Schema } = mongoose;

// ── User (team + clients) ────────────────────────────────────
const UserSchema = new Schema(
  {
    email: {
      type: String,
      required: true,
      unique: true,
      lowercase: true,
      trim: true,
    },
    passwordHash: { type: String, required: true },
    role: { type: String, enum: ["team", "client"], required: true },
    name: { type: String, required: true },
    initials: String,
    color: String,
    teamRole: String, // 'Creative Director', 'Editor', etc.
    clientId: { type: Schema.Types.ObjectId, ref: "Client" }, // for portal users
  },
  { timestamps: true },
);

UserSchema.pre("validate", function (next) {
  if (this.role === "client" && !this.clientId) {
    this.invalidate("clientId", "Client users must have a linked clientId");
  }
  if (this.role === "team") {
    this.clientId = undefined;
  }
  next();
});

// ── Client ────────────────────────────────────────────────────
const ClientSchema = new Schema(
  {
    name: { type: String, required: true },
    sector: String,
    phase: String,
    contact: String,
    email: String,
    phone: String,
    since: String,
    urgent: { type: Boolean, default: false },
    urgentReason: String,
    color: { type: String, default: "#C4522A" },
    welcomeMessage: String,
    // Portal
    portalPassword: String, // hashed
    portalEmail: { type: String, trim: true, lowercase: true },
    // Shoot
    shoot: {
      name: String,
      date: String,
      location: String,
      info: String,
      status: {
        type: String,
        enum: ["planned", "soon", "wrapped"],
        default: "planned",
      },
    },
    // Retainer
    retainer: {
      pakket: String,
      prijs: String,
      periode: String,
      betaalmethode: String,
      startdatum: String,
      einddatum: String,
      looptijd: String,
      shoots: String,
      videos: String,
      extras: String,
      status: {
        type: String,
        enum: ["actief", "gepauzeerd", "opgezegd", "concept"],
        default: "concept",
      },
      notities: String,
      zichtbaarInPortaal: { type: Boolean, default: false },
    },
  },
  { timestamps: true },
);

function isBcryptHash(value) {
  return typeof value === "string" && /^\$2[aby]\$\d{2}\$/.test(value);
}

async function hashClientPortalPassword(rawValue) {
  if (typeof rawValue !== "string") return rawValue;
  const trimmed = rawValue.trim();
  if (!trimmed) return undefined;
  if (isBcryptHash(trimmed)) return trimmed;
  return bcrypt.hash(trimmed, 10);
}

ClientSchema.pre("save", async function (next) {
  if (!this.isModified("portalPassword")) return next();
  this.portalPassword = await hashClientPortalPassword(this.portalPassword);
  next();
});

async function hashPortalPasswordInUpdate(next) {
  const update = this.getUpdate();
  if (!update) return next();

  const hasTopLevel = Object.prototype.hasOwnProperty.call(
    update,
    "portalPassword",
  );
  const hasSetLevel =
    update.$set &&
    Object.prototype.hasOwnProperty.call(update.$set, "portalPassword");
  if (!hasTopLevel && !hasSetLevel) return next();

  if (hasTopLevel) {
    update.portalPassword = await hashClientPortalPassword(
      update.portalPassword,
    );
  }
  if (hasSetLevel) {
    update.$set.portalPassword = await hashClientPortalPassword(
      update.$set.portalPassword,
    );
  }

  this.setUpdate(update);
  next();
}

ClientSchema.pre("findOneAndUpdate", hashPortalPasswordInUpdate);
ClientSchema.pre("updateOne", hashPortalPasswordInUpdate);

// ── Event ─────────────────────────────────────────────────────
const EventSchema = new Schema(
  {
    name: { type: String, required: true },
    type: {
      type: String,
      enum: ["Shoot", "Edit", "Deadline", "Call", "Delivery"],
      required: true,
    },
    date: { type: String, required: true }, // YYYY-MM-DD
    time: { type: String, trim: true }, // HH:mm (local studio time)
    assigneeId: { type: Schema.Types.ObjectId, ref: "User" },
    clientId: { type: Schema.Types.ObjectId, ref: "Client" },
    client: String, // client name string for display
    notes: String,
  },
  { timestamps: true },
);

// ── Task ──────────────────────────────────────────────────────
const ChecklistItemSchema = new Schema({
  text: String,
  done: { type: Boolean, default: false },
});

const TaskSchema = new Schema(
  {
    title: { type: String, required: true },
    assignee: String,
    status: {
      type: String,
      enum: ["active", "delete"],
      default: "active",
    },
    clientId: { type: Schema.Types.ObjectId, ref: "Client" },
    client: String,
    column: {
      type: String,
      enum: ["todo", "bezig", "review", "klaar"],
      default: "todo",
    },
    priority: {
      type: String,
      enum: ["High", "Normal", "Low"],
      default: "Normal",
    },
    dueDate: String,
    description: String,
    checklist: [ChecklistItemSchema],
    archived: { type: Boolean, default: false },
    archivedAt: Date,
    archivedReason: {
      type: String,
      enum: ["completed", "delivered", "manual"],
      default: null,
    },
  },
  { timestamps: true },
);

// ── Video (embedded in Batch) ─────────────────────────────────
const ShotSchema = new Schema({
  text: String,
  done: { type: Boolean, default: false },
});
const SopSchema = new Schema({
  format: String,
  muziek: String,
  kleurprofiel: String,
  extraNotes: String,
  ratioTags: [String],
  stijlTags: [String],
});

const VideoSchema = new Schema(
  {
    name: { type: String, required: true },
    editFase: { type: String, default: "tentative" },
    assets: String, // Frame.io export link
    export: String, // Drive export link
    notes: String,
    script: String,
    driveLink: String, // brand assets
    shotlist: [ShotSchema],
    sop: SopSchema,
    // Portal review state
    portalPushed: { type: Boolean, default: false },
    revision: { type: Boolean, default: false },
    revisionNote: String,
    approved: { type: Boolean, default: false },
    approvedAt: Date,
  },
  { timestamps: true },
);

const ResourceItemSchema = new Schema(
  {
    name: { type: String, required: true },
    note: String,
    status: String,
  },
  { _id: true },
);

const BatchResourcesSchema = new Schema(
  {
    scripts: [ResourceItemSchema],
    props: [ResourceItemSchema],
    cast: [ResourceItemSchema],
    shotlist: [ResourceItemSchema],
    moodboard: [ResourceItemSchema],
    interview: [ResourceItemSchema],
  },
  { _id: false },
);

// ── Batch ─────────────────────────────────────────────────────
const BatchSchema = new Schema(
  {
    name: { type: String, required: true },
    emoji: { type: String, default: "🎬" },
    clientId: { type: Schema.Types.ObjectId, ref: "Client" },
    client: String,
    editor: String,
    shootDate: String,
    shootStatus: {
      type: String,
      enum: ["wrapped", "tentative", "waiting", "planned"],
      default: "planned",
    },
    deadline: String,
    projectStage: {
      type: String,
      enum: [
        "development",
        "preproduction",
        "shooting",
        "post-production",
        "completed",
      ],
      default: "preproduction",
    },
    notes: String,
    lastReview: String,
    links: [{ label: String, url: String }],
    resources: { type: BatchResourcesSchema, default: () => ({}) },
    videos: [VideoSchema],
  },
  { timestamps: true },
);

// ── Workspace (new: top-level project that owns Batches) ──────
// A Workspace has the top-level project metadata (client, editor,
// deadline, stage, shoot info, links, resources, notes) and contains
// one or more Batches. Each Batch owns its own array of Videos.
const WorkspaceBatchSchema = new Schema(
  {
    name: { type: String, required: true },
    emoji: { type: String, default: "🎬" },
    videos: [VideoSchema],
  },
  { timestamps: true, _id: true },
);

const WorkspaceSchema = new Schema(
  {
    name: { type: String, required: true },
    emoji: { type: String, default: "📁" },
    clientId: { type: Schema.Types.ObjectId, ref: "Client" },
    client: String,
    editor: String,
    shootDate: String,
    shootStatus: {
      type: String,
      enum: ["wrapped", "tentative", "waiting", "planned"],
      default: "planned",
    },
    deadline: String,
    projectStage: {
      type: String,
      enum: [
        "development",
        "preproduction",
        "shooting",
        "post-production",
        "completed",
      ],
      default: "preproduction",
    },
    notes: String,
    lastReview: String,
    links: [{ label: String, url: String }],
    resources: { type: BatchResourcesSchema, default: () => ({}) },
    batches: [WorkspaceBatchSchema],
  },
  { timestamps: true },
);

// ── Portal Note (chat message) ────────────────────────────────
const NoteSchema = new Schema(
  {
    clientId: { type: Schema.Types.ObjectId, ref: "Client", required: true },
    from: { type: String, enum: ["studio", "client"], required: true },
    author: String,
    text: { type: String, required: true },
    read: { type: Boolean, default: false },
  },
  { timestamps: true },
);

// ── Questionnaire ─────────────────────────────────────────────
const QuestionnaireSchema = new Schema(
  {
    clientId: {
      type: Schema.Types.ObjectId,
      ref: "Client",
      required: true,
      unique: true,
    },
    answers: { type: Map, of: Schema.Types.Mixed },
    fileKeys: [String], // S3 keys for uploaded files
    submitted: { type: Boolean, default: false },
    submittedAt: Date,
    openedAt: Date,
  },
  { timestamps: true },
);

// ── Activity ──────────────────────────────────────────────────
const ActivitySchema = new Schema(
  {
    text: String,
    color: String,
    view: String,
    user: String,
  },
  { timestamps: true },
);

// ── Video checker run (spell-check scan + S3 video) ───────────
const CheckerErrorSchema = new Schema(
  {
    wrong: String,
    suggestion: String,
    message: String,
    offset: Number,
    length: Number,
    ruleId: String,
  },
  { _id: false },
);

const CheckerFrameSchema = new Schema(
  {
    idx: Number,
    timestamp: Number,
    text: String,
    issues: [CheckerErrorSchema],
  },
  { _id: false },
);

const VideoCheckerRunSchema = new Schema(
  {
    uploadedById: { type: Schema.Types.ObjectId, ref: "User" },
    uploadedByName: String,
    videoOriginalName: String,
    videoContentType: String,
    videoSizeBytes: Number,
    durationSec: Number,
    s3Key: { type: String, required: true },
    videoUrl: { type: String, required: true },
    settings: {
      intervalSec: String,
      lang: String,
      mode: String,
    },
    summary: {
      frameCount: Number,
      errorCount: Number,
      cleanCount: Number,
    },
    frames: [CheckerFrameSchema],
  },
  { timestamps: true },
);

module.exports = {
  User: mongoose.model("User", UserSchema),
  Client: mongoose.model("Client", ClientSchema),
  Event: mongoose.model("Event", EventSchema),
  Task: mongoose.model("Task", TaskSchema),
  Batch: mongoose.model("Batch", BatchSchema),
  Workspace: mongoose.model("Workspace", WorkspaceSchema),
  Note: mongoose.model("Note", NoteSchema),
  Questionnaire: mongoose.model("Questionnaire", QuestionnaireSchema),
  Activity: mongoose.model("Activity", ActivitySchema),
  VideoCheckerRun: mongoose.model("VideoCheckerRun", VideoCheckerRunSchema),
};
